//! Card-scoped attachment snapshots.
//!
//! Source paths only exist during preflight/copy. Persisted rows contain an
//! application-owned relative storage path and a safe display path. Attachment
//! chunks and per-run read grants are physically separate from formal note
//! libraries and TASK-007's note allowlist.

use crate::notes;
use rusqlite::{params, params_from_iter, types::Value as SqlValue, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, HashMap};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::ipc::Channel;
use walkdir::WalkDir;

pub const COUNT_LIMIT: usize = 25;
pub const BYTE_LIMIT: u64 = 50 * 1024 * 1024;
pub const HARD_COUNT_LIMIT: usize = 500;
pub const HARD_BYTE_LIMIT: u64 = 512 * 1024 * 1024;

static JOB_COUNTER: AtomicU64 = AtomicU64::new(0);

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug)]
pub struct Error(String);

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}
impl std::error::Error for Error {}
impl From<rusqlite::Error> for Error {
    fn from(value: rusqlite::Error) -> Self {
        Self(value.to_string())
    }
}
impl From<std::io::Error> for Error {
    fn from(value: std::io::Error) -> Self {
        Self(value.to_string())
    }
}
impl From<serde_json::Error> for Error {
    fn from(value: serde_json::Error) -> Self {
        Self(value.to_string())
    }
}
impl From<String> for Error {
    fn from(value: String) -> Self {
        Self(value)
    }
}
impl From<&str> for Error {
    fn from(value: &str) -> Self {
        Self(value.to_string())
    }
}
impl serde::Serialize for Error {
    fn serialize<S: serde::Serializer>(
        &self,
        serializer: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.0)
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub id: String,
    pub card_id: String,
    pub scope: String,
    pub name: String,
    pub relative_path: String,
    pub mime_type: String,
    pub byte_size: u64,
    pub sha256: String,
    pub indexed: bool,
    pub created_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub promoted_library_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub promoted_document_id: Option<String>,
}

#[derive(Debug, Clone)]
struct StoredAttachment {
    public: Attachment,
    storage_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentCandidate {
    pub key: String,
    pub name: String,
    pub relative_path: String,
    pub byte_size: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentPreflight {
    pub schema_version: u8,
    pub job_id: String,
    pub card_id: String,
    pub items: Vec<AttachmentCandidate>,
    pub total_count: usize,
    pub total_bytes: u64,
    pub count_limit: usize,
    pub byte_limit: u64,
    pub requires_confirmation: bool,
    pub issues: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentProgress {
    pub schema_version: u8,
    pub job_id: String,
    pub phase: String,
    pub completed_count: usize,
    pub total_count: usize,
    pub completed_bytes: u64,
    pub total_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_item: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub item_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentImportResult {
    pub schema_version: u8,
    pub job_id: String,
    pub attachments: Vec<Attachment>,
    pub total_bytes: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentImportRequest {
    pub job_id: String,
    pub card_id: String,
    pub paths: Vec<String>,
    pub confirmed: bool,
}

#[derive(Debug, Clone)]
struct SourceItem {
    source: PathBuf,
    candidate: AttachmentCandidate,
}

#[derive(Debug, Clone)]
struct ImportPlan {
    roots: Vec<String>,
    preflight: AttachmentPreflight,
    items: Vec<SourceItem>,
    cancelled: Arc<std::sync::atomic::AtomicBool>,
}

#[derive(Default)]
pub struct AttachmentImports(Mutex<HashMap<String, ImportPlan>>);

pub struct AttachmentStore {
    root: PathBuf,
}

impl AttachmentStore {
    pub fn new(root: PathBuf) -> Result<Self> {
        std::fs::create_dir_all(root.join(".staging"))?;
        // A previous process can only leave staging data; committed snapshots
        // never live under this directory.
        for entry in std::fs::read_dir(root.join(".staging"))? {
            let entry = entry?;
            let path = entry.path();
            if path.is_dir() {
                let _ = std::fs::remove_dir_all(path);
            } else {
                let _ = std::fs::remove_file(path);
            }
        }
        Ok(Self { root })
    }
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

fn scope(card_id: &str) -> String {
    format!("attachment:{card_id}")
}

fn safe_name(value: &str) -> String {
    let cleaned = value
        .chars()
        .map(|character| {
            if character.is_control() || matches!(character, '/' | '\\' | ':') {
                '_'
            } else {
                character
            }
        })
        .collect::<String>();
    let cleaned = cleaned.trim().trim_matches('.').to_string();
    if cleaned.is_empty() {
        "attachment".into()
    } else {
        cleaned.chars().take(180).collect()
    }
}

fn display_path(path: &Path) -> String {
    path.components()
        .filter_map(|component| match component {
            std::path::Component::Normal(value) => Some(value.to_string_lossy().to_string()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

fn enumerate(paths: &[String]) -> Result<(Vec<SourceItem>, Vec<String>, u64)> {
    if paths.is_empty() {
        return Err("没有可导入的附件。".into());
    }
    let mut items = Vec::new();
    let mut issues = Vec::new();
    let mut seen = BTreeSet::new();
    let mut total_bytes = 0u64;
    for raw in paths {
        let root = PathBuf::from(raw);
        let metadata = std::fs::symlink_metadata(&root)
            .map_err(|_| Error("无法读取拖入的文件或文件夹。".into()))?;
        if metadata.file_type().is_symlink() {
            issues.push(format!("已跳过符号链接：{}", safe_name(raw)));
            continue;
        }
        let canonical = root
            .canonicalize()
            .map_err(|_| Error("无法确认拖入来源的真实位置。".into()))?;
        let root_name = canonical
            .file_name()
            .and_then(|value| value.to_str())
            .map(safe_name)
            .unwrap_or_else(|| "attachment".into());
        let candidates: Vec<(PathBuf, PathBuf)> = if metadata.is_file() {
            vec![(canonical.clone(), PathBuf::from(&root_name))]
        } else if metadata.is_dir() {
            let mut rows = Vec::new();
            for entry in WalkDir::new(&canonical)
                .follow_links(false)
                .sort_by_file_name()
            {
                let entry =
                    entry.map_err(|_| Error("递归读取文件夹时遇到不可访问项目。".into()))?;
                if entry.file_type().is_symlink() {
                    issues.push(format!(
                        "已跳过符号链接：{}",
                        display_path(
                            entry
                                .path()
                                .strip_prefix(&canonical)
                                .unwrap_or(entry.path())
                        )
                    ));
                    continue;
                }
                if !entry.file_type().is_file() {
                    continue;
                }
                let source = entry
                    .path()
                    .canonicalize()
                    .map_err(|_| Error("无法确认文件夹内文件的真实位置。".into()))?;
                if !source.starts_with(&canonical) {
                    return Err("文件夹枚举越出拖入根目录，已拒绝导入。".into());
                }
                let relative = source
                    .strip_prefix(&canonical)
                    .map_err(|_| Error("无法建立安全附件相对路径。".into()))?
                    .to_path_buf();
                rows.push((source, PathBuf::from(&root_name).join(relative)));
            }
            rows
        } else {
            issues.push(format!("已跳过非普通文件：{root_name}"));
            vec![]
        };
        for (source, relative) in candidates {
            let key = source.to_string_lossy().to_string();
            if !seen.insert(key.clone()) {
                continue;
            }
            let size = source
                .metadata()
                .map_err(|_| Error("附件在预检期间变得不可读。".into()))?
                .len();
            total_bytes = total_bytes
                .checked_add(size)
                .ok_or_else(|| Error("附件总体积无法安全计数。".into()))?;
            if items.len() + 1 > HARD_COUNT_LIMIT || total_bytes > HARD_BYTE_LIMIT {
                return Err("附件超过安全硬上限（500 项或 512 MiB），已拒绝导入。".into());
            }
            let relative_path = display_path(&relative);
            let name = source
                .file_name()
                .and_then(|value| value.to_str())
                .map(safe_name)
                .unwrap_or_else(|| "attachment".into());
            let hash = Sha256::digest(key.as_bytes());
            items.push(SourceItem {
                source,
                candidate: AttachmentCandidate {
                    key: format!("{:x}", hash),
                    name,
                    relative_path,
                    byte_size: size,
                },
            });
        }
    }
    if items.is_empty() {
        return Err("没有可导入的普通文件。".into());
    }
    Ok((items, issues, total_bytes))
}

pub fn preflight(
    conn: &Connection,
    imports: &AttachmentImports,
    card_id: &str,
    paths: &[String],
) -> Result<AttachmentPreflight> {
    let exists: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM cards WHERE id = ?1 AND COALESCE(trashed, 0) = 0)",
        params![card_id],
        |row| row.get(0),
    )?;
    if !exists {
        return Err("当前卡片不存在或已进入回收站。".into());
    }
    let (items, issues, total_bytes) = enumerate(paths)?;
    let job_id = format!(
        "attachment-job-{}-{}",
        now_millis(),
        JOB_COUNTER.fetch_add(1, Ordering::Relaxed)
    );
    let summary = AttachmentPreflight {
        schema_version: 1,
        job_id: job_id.clone(),
        card_id: card_id.to_string(),
        items: items.iter().map(|item| item.candidate.clone()).collect(),
        total_count: items.len(),
        total_bytes,
        count_limit: COUNT_LIMIT,
        byte_limit: BYTE_LIMIT,
        requires_confirmation: items.len() > COUNT_LIMIT || total_bytes > BYTE_LIMIT,
        issues,
    };
    let mut guard = imports
        .0
        .lock()
        .map_err(|_| Error("附件任务表不可用。".into()))?;
    if guard.len() >= 16 {
        guard.clear();
    }
    guard.insert(
        job_id,
        ImportPlan {
            roots: paths.to_vec(),
            preflight: summary.clone(),
            items,
            cancelled: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        },
    );
    Ok(summary)
}

fn extension_mime(name: &str) -> &'static str {
    match Path::new(name)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "md" | "markdown" => "text/markdown",
        "txt" => "text/plain",
        "json" | "jsonl" => "application/json",
        "csv" => "text/csv",
        "tsv" => "text/tab-separated-values",
        "html" => "text/html",
        "css" => "text/css",
        "js" | "jsx" | "ts" | "tsx" | "rs" | "py" | "toml" | "xml" | "yaml" | "yml" => "text/plain",
        _ => "application/octet-stream",
    }
}

fn is_text_attachment(name: &str) -> bool {
    extension_mime(name) != "application/octet-stream"
}

fn send_progress(channel: &Channel<AttachmentProgress>, progress: AttachmentProgress) {
    let _ = channel.send(progress);
}

fn attachment_id(job_id: &str, index: usize, relative_path: &str) -> String {
    let hash = Sha256::digest(format!("{job_id}\0{index}\0{relative_path}").as_bytes());
    format!("attachment-{:x}", hash)[..43].to_string()
}

fn write_snapshot(
    source: &Path,
    destination: &Path,
    expected_size: u64,
    cancelled: &std::sync::atomic::AtomicBool,
    copied_total: &mut u64,
    on_bytes: &mut dyn FnMut(u64),
) -> Result<String> {
    let metadata =
        std::fs::symlink_metadata(source).map_err(|_| Error("附件在复制前变得不可读。".into()))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("附件在预检后变成符号链接或非普通文件，已拒绝导入。".into());
    }
    if metadata.len() != expected_size {
        return Err("附件在预检后发生变化，请重新拖入。".into());
    }
    if source
        .canonicalize()
        .map_err(|_| Error("无法再次确认附件来源。".into()))?
        != source
    {
        return Err("附件来源在预检后发生变化，已拒绝导入。".into());
    }
    let mut input =
        std::fs::File::open(source).map_err(|_| Error("无法读取待导入附件。".into()))?;
    let mut output = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)
        .map_err(|_| Error("无法创建附件快照。".into()))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    let mut copied = 0u64;
    loop {
        if cancelled.load(Ordering::Relaxed) {
            return Err("附件导入已取消。".into());
        }
        let read = input
            .read(&mut buffer)
            .map_err(|_| Error("读取附件时发生错误。".into()))?;
        if read == 0 {
            break;
        }
        output
            .write_all(&buffer[..read])
            .map_err(|_| Error("写入附件快照时发生错误。".into()))?;
        hasher.update(&buffer[..read]);
        copied += read as u64;
        *copied_total += read as u64;
        on_bytes(*copied_total);
    }
    output
        .sync_all()
        .map_err(|_| Error("附件快照无法安全落盘。".into()))?;
    if copied != expected_size {
        return Err("附件在预检后发生变化，请重新拖入。".into());
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn insert_attachment(
    conn: &Connection,
    stored: &StoredAttachment,
    chunks: &[notes::NoteChunk],
) -> Result<()> {
    let attachment = &stored.public;
    conn.execute(
        "INSERT INTO attachments (
           id, card_id, scope, name, relative_path, mime_type, byte_size, sha256,
           storage_path, indexed, created_at, promoted_library_id, promoted_document_id
         ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
        params![
            attachment.id,
            attachment.card_id,
            attachment.scope,
            attachment.name,
            attachment.relative_path,
            attachment.mime_type,
            attachment.byte_size as i64,
            attachment.sha256,
            stored.storage_path,
            attachment.indexed,
            attachment.created_at,
            attachment.promoted_library_id,
            attachment.promoted_document_id,
        ],
    )?;
    for chunk in chunks {
        conn.execute(
            "INSERT INTO attachment_chunks (
               id, attachment_id, card_id, scope, ordinal, heading_path, content,
               char_start, char_end, version_hash
             ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
            params![
                chunk.id,
                attachment.id,
                attachment.card_id,
                attachment.scope,
                chunk.ordinal as i64,
                serde_json::to_string(&chunk.heading_path)?,
                chunk.content,
                chunk.char_start as i64,
                chunk.char_end as i64,
                chunk.version_hash,
            ],
        )?;
        conn.execute(
            "INSERT INTO attachment_chunks_fts (chunk_id, card_id, content)
             VALUES (?1, ?2, ?3)",
            params![chunk.id, attachment.card_id, chunk.content],
        )?;
    }
    Ok(())
}

pub fn import(
    conn: &mut Connection,
    imports: &AttachmentImports,
    store: &AttachmentStore,
    request: &AttachmentImportRequest,
    progress: &Channel<AttachmentProgress>,
) -> Result<AttachmentImportResult> {
    let plan = {
        let guard = imports
            .0
            .lock()
            .map_err(|_| Error("附件任务表不可用。".into()))?;
        guard
            .get(&request.job_id)
            .cloned()
            .ok_or_else(|| Error("附件预检已失效，请重新拖入。".into()))?
    };
    if plan.preflight.card_id != request.card_id || plan.roots != request.paths {
        return Err("附件预检结果与当前拖入来源不一致。".into());
    }
    if plan.preflight.requires_confirmation && !request.confirmed {
        return Err("附件数量或体积超过默认限制，必须先在应用内确认。".into());
    }
    let stage = store.root.join(".staging").join(&request.job_id);
    let final_dir = store
        .root
        .join(safe_name(&request.card_id))
        .join(&request.job_id);
    if stage.exists() || final_dir.exists() {
        return Err("附件任务路径发生碰撞，请重新拖入。".into());
    }
    std::fs::create_dir_all(&stage)?;
    let outcome = (|| -> Result<AttachmentImportResult> {
        let mut stored_rows = Vec::new();
        let mut all_chunks: Vec<Vec<notes::NoteChunk>> = Vec::new();
        let mut copied_bytes = 0u64;
        for (index, item) in plan.items.iter().enumerate() {
            if plan.cancelled.load(Ordering::Relaxed) {
                return Err("附件导入已取消。".into());
            }
            let id = attachment_id(&request.job_id, index, &item.candidate.relative_path);
            let item_dir = stage.join(&id);
            std::fs::create_dir_all(&item_dir)?;
            let filename = safe_name(&item.candidate.name);
            let target = item_dir.join(&filename);
            send_progress(
                progress,
                AttachmentProgress {
                    schema_version: 1,
                    job_id: request.job_id.clone(),
                    phase: "copying".into(),
                    completed_count: index,
                    total_count: plan.items.len(),
                    completed_bytes: copied_bytes,
                    total_bytes: plan.preflight.total_bytes,
                    current_item: Some(item.candidate.relative_path.clone()),
                    item_id: Some(id.clone()),
                    error: None,
                },
            );
            let mut notify = |total| {
                send_progress(
                    progress,
                    AttachmentProgress {
                        schema_version: 1,
                        job_id: request.job_id.clone(),
                        phase: "copying".into(),
                        completed_count: index,
                        total_count: plan.items.len(),
                        completed_bytes: total,
                        total_bytes: plan.preflight.total_bytes,
                        current_item: Some(item.candidate.relative_path.clone()),
                        item_id: Some(id.clone()),
                        error: None,
                    },
                );
            };
            let sha256 = write_snapshot(
                &item.source,
                &target,
                item.candidate.byte_size,
                &plan.cancelled,
                &mut copied_bytes,
                &mut notify,
            )?;
            let mime_type = extension_mime(&filename).to_string();
            let content = if is_text_attachment(&filename)
                && item.candidate.byte_size <= notes::MAX_MARKDOWN_BYTES as u64
            {
                std::fs::read_to_string(&target).ok()
            } else {
                None
            };
            if content.is_some() {
                send_progress(
                    progress,
                    AttachmentProgress {
                        schema_version: 1,
                        job_id: request.job_id.clone(),
                        phase: "indexing".into(),
                        completed_count: index,
                        total_count: plan.items.len(),
                        completed_bytes: copied_bytes,
                        total_bytes: plan.preflight.total_bytes,
                        current_item: Some(item.candidate.relative_path.clone()),
                        item_id: Some(id.clone()),
                        error: None,
                    },
                );
            }
            let mut chunks = content
                .as_deref()
                .map(|text| {
                    notes::chunk_markdown(
                        &scope(&request.card_id),
                        &item.candidate.relative_path,
                        text,
                        &sha256,
                    )
                })
                .unwrap_or_default();
            for chunk in &mut chunks {
                chunk.id = format!("attachment-{}", chunk.id);
                chunk.document_id = id.clone();
                chunk.library_id = scope(&request.card_id);
            }
            let relative_storage = PathBuf::from(safe_name(&request.card_id))
                .join(&request.job_id)
                .join(&id)
                .join(&filename);
            stored_rows.push(StoredAttachment {
                public: Attachment {
                    id,
                    card_id: request.card_id.clone(),
                    scope: scope(&request.card_id),
                    name: item.candidate.name.clone(),
                    relative_path: item.candidate.relative_path.clone(),
                    mime_type,
                    byte_size: item.candidate.byte_size,
                    sha256,
                    indexed: !chunks.is_empty(),
                    created_at: now_millis() + index as i64,
                    promoted_library_id: None,
                    promoted_document_id: None,
                },
                storage_path: display_path(&relative_storage),
            });
            all_chunks.push(chunks);
            send_progress(
                progress,
                AttachmentProgress {
                    schema_version: 1,
                    job_id: request.job_id.clone(),
                    phase: "copying".into(),
                    completed_count: index + 1,
                    total_count: plan.items.len(),
                    completed_bytes: copied_bytes,
                    total_bytes: plan.preflight.total_bytes,
                    current_item: Some(item.candidate.relative_path.clone()),
                    item_id: stored_rows.last().map(|row| row.public.id.clone()),
                    error: None,
                },
            );
        }
        let parent = final_dir
            .parent()
            .ok_or_else(|| Error("附件存储目录不可用。".into()))?;
        std::fs::create_dir_all(parent)?;
        std::fs::rename(&stage, &final_dir)
            .map_err(|_| Error("无法完成附件快照目录提交。".into()))?;
        let tx = match conn.transaction() {
            Ok(tx) => tx,
            Err(error) => {
                let _ = std::fs::remove_dir_all(&final_dir);
                return Err(error.into());
            }
        };
        for (row, chunks) in stored_rows.iter().zip(&all_chunks) {
            if let Err(error) = insert_attachment(&tx, row, chunks) {
                drop(tx);
                let _ = std::fs::remove_dir_all(&final_dir);
                return Err(error);
            }
        }
        if let Err(error) = tx.commit() {
            let _ = std::fs::remove_dir_all(&final_dir);
            return Err(error.into());
        }
        send_progress(
            progress,
            AttachmentProgress {
                schema_version: 1,
                job_id: request.job_id.clone(),
                phase: "complete".into(),
                completed_count: stored_rows.len(),
                total_count: stored_rows.len(),
                completed_bytes: copied_bytes,
                total_bytes: copied_bytes,
                current_item: None,
                item_id: None,
                error: None,
            },
        );
        Ok(AttachmentImportResult {
            schema_version: 1,
            job_id: request.job_id.clone(),
            attachments: stored_rows.into_iter().map(|row| row.public).collect(),
            total_bytes: copied_bytes,
        })
    })();
    if outcome.is_err() {
        let _ = std::fs::remove_dir_all(&stage);
        let message = outcome
            .as_ref()
            .err()
            .map(ToString::to_string)
            .unwrap_or_else(|| "附件导入失败。".into());
        send_progress(
            progress,
            AttachmentProgress {
                schema_version: 1,
                job_id: request.job_id.clone(),
                phase: if message.contains("取消") {
                    "cancelled".into()
                } else {
                    "error".into()
                },
                completed_count: 0,
                total_count: plan.items.len(),
                completed_bytes: 0,
                total_bytes: plan.preflight.total_bytes,
                current_item: None,
                item_id: None,
                error: Some(if message.contains("取消") {
                    "附件导入已取消，未保留部分快照。".into()
                } else {
                    message
                }),
            },
        );
    }
    if let Ok(mut guard) = imports.0.lock() {
        guard.remove(&request.job_id);
    }
    outcome
}

pub fn cancel(imports: &AttachmentImports, job_id: &str) -> Result<()> {
    let guard = imports
        .0
        .lock()
        .map_err(|_| Error("附件任务表不可用。".into()))?;
    if let Some(plan) = guard.get(job_id) {
        plan.cancelled.store(true, Ordering::Relaxed);
    }
    Ok(())
}

fn row_to_stored(row: &rusqlite::Row<'_>) -> rusqlite::Result<StoredAttachment> {
    Ok(StoredAttachment {
        public: Attachment {
            id: row.get(0)?,
            card_id: row.get(1)?,
            scope: row.get(2)?,
            name: row.get(3)?,
            relative_path: row.get(4)?,
            mime_type: row.get(5)?,
            byte_size: row.get::<_, i64>(6)? as u64,
            sha256: row.get(7)?,
            indexed: row.get(9)?,
            created_at: row.get(10)?,
            promoted_library_id: row.get(11)?,
            promoted_document_id: row.get(12)?,
        },
        storage_path: row.get(8)?,
    })
}

pub fn list(conn: &Connection, card_id: &str) -> Result<Vec<Attachment>> {
    let mut statement = conn.prepare(
        "SELECT id, card_id, scope, name, relative_path, mime_type, byte_size, sha256,
                storage_path, indexed, created_at, promoted_library_id, promoted_document_id
         FROM attachments WHERE card_id = ?1 ORDER BY created_at, id",
    )?;
    let rows = statement
        .query_map(params![card_id], row_to_stored)?
        .collect::<rusqlite::Result<Vec<_>>>()?
        .into_iter()
        .map(|row| row.public)
        .collect();
    Ok(rows)
}

fn active_scope(conn: &Connection, run_id: &str, project_id: &str, card_id: &str) -> Result<()> {
    let row: Option<(String, String, String, String)> = conn
        .query_row(
            "SELECT c.project_id, c.id, r.phase, r.checkpoint
             FROM agent_runs r
             JOIN turns t ON t.id = r.turn_id
             JOIN cards c ON c.id = t.card_id
             WHERE r.id = ?1",
            params![run_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()?;
    let Some((bound_project, bound_card, phase, checkpoint)) = row else {
        return Err("附件请求没有匹配当前运行的宿主作用域。".into());
    };
    let checkpoint: Value = serde_json::from_str(&checkpoint)?;
    let frozen_card = checkpoint
        .get("hostScope")
        .and_then(|value| value.get("cardId"))
        .and_then(Value::as_str);
    let frozen_scope = checkpoint
        .get("hostScope")
        .and_then(|value| value.get("attachmentScope"))
        .and_then(Value::as_str);
    let expected_scope = scope(card_id);
    if bound_project != project_id
        || bound_card != card_id
        || phase == "terminal"
        || frozen_card != Some(card_id)
        || frozen_scope != Some(expected_scope.as_str())
    {
        return Err("附件请求没有匹配当前运行的宿主作用域。".into());
    }
    Ok(())
}

fn row_to_chunk(row: &rusqlite::Row<'_>) -> rusqlite::Result<notes::PublicNoteChunk> {
    let heading: String = row.get(4)?;
    Ok(notes::PublicNoteChunk {
        id: row.get(0)?,
        library_id: row.get(1)?,
        document_id: row.get(2)?,
        document_version_hash: row.get(8)?,
        relative_path: row.get(3)?,
        title_path: serde_json::from_str(&heading).unwrap_or_default(),
        tags: vec![],
        ordinal: row.get::<_, i64>(5)? as usize,
        start: row.get::<_, i64>(6)? as usize,
        end: row.get::<_, i64>(7)? as usize,
        text: row.get(9)?,
    })
}

fn chunks_for_query(
    conn: &Connection,
    card_id: &str,
    query: &str,
    limit: usize,
) -> Result<Vec<notes::PublicNoteHit>> {
    let limit = limit.clamp(1, 8);
    if query.trim() == "*" {
        let mut statement = conn.prepare(
            "SELECT c.id, c.scope, c.attachment_id, a.relative_path, c.heading_path,
                    c.ordinal, c.char_start, c.char_end, c.version_hash, c.content
             FROM attachment_chunks c JOIN attachments a ON a.id = c.attachment_id
             WHERE c.card_id = ?1 AND c.ordinal = 0
             ORDER BY a.relative_path LIMIT ?2",
        )?;
        let chunks = statement
            .query_map(params![card_id, limit as i64], row_to_chunk)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        return Ok(chunks
            .into_iter()
            .map(|chunk| notes::PublicNoteHit {
                snippet: chunk.text.chars().take(180).collect(),
                chunk,
                score: 0.0,
            })
            .collect());
    }
    let normalized = query
        .chars()
        .filter(|character| !matches!(character, '"' | '\'' | '(' | ')' | '*' | ':' | '^'))
        .collect::<String>();
    let fts = format!("\"{}\"", normalized.trim().replace('"', ""));
    let mut hits = if !normalized.trim().is_empty() {
        let mut statement = conn.prepare(
            "SELECT c.id, c.scope, c.attachment_id, a.relative_path, c.heading_path,
                    c.ordinal, c.char_start, c.char_end, c.version_hash, c.content,
                    bm25(attachment_chunks_fts)
             FROM attachment_chunks_fts
             JOIN attachment_chunks c ON c.id = attachment_chunks_fts.chunk_id
             JOIN attachments a ON a.id = c.attachment_id
             WHERE attachment_chunks_fts MATCH ?1 AND c.card_id = ?2
             ORDER BY bm25(attachment_chunks_fts), a.relative_path, c.ordinal LIMIT ?3",
        )?;
        let rows = statement
            .query_map(params![fts, card_id, limit as i64], |row| {
                Ok((row_to_chunk(row)?, row.get::<_, f64>(10)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap_or_default();
        rows
    } else {
        vec![]
    };
    if hits.is_empty() {
        let mut statement = conn.prepare(
            "SELECT c.id, c.scope, c.attachment_id, a.relative_path, c.heading_path,
                    c.ordinal, c.char_start, c.char_end, c.version_hash, c.content, 0.0
             FROM attachment_chunks c JOIN attachments a ON a.id = c.attachment_id
             WHERE c.card_id = ?1 AND
                   (c.content LIKE '%' || ?2 || '%' OR a.relative_path LIKE '%' || ?2 || '%')
             ORDER BY a.relative_path, c.ordinal LIMIT ?3",
        )?;
        hits = statement
            .query_map(params![card_id, query.trim(), limit as i64], |row| {
                Ok((row_to_chunk(row)?, row.get::<_, f64>(10)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
    }
    Ok(hits
        .into_iter()
        .map(|(chunk, score)| notes::PublicNoteHit {
            snippet: chunk.text.chars().take(360).collect(),
            chunk,
            score,
        })
        .collect())
}

pub fn search_for_run(
    conn: &mut Connection,
    run_id: &str,
    project_id: &str,
    card_id: &str,
    query: &str,
    limit: usize,
) -> Result<Vec<notes::PublicNoteHit>> {
    let tx = conn.transaction()?;
    active_scope(&tx, run_id, project_id, card_id)?;
    let hits = chunks_for_query(&tx, card_id, query, limit)?;
    for hit in &hits {
        tx.execute(
            "INSERT OR IGNORE INTO agent_attachment_search_allowlist (run_id, card_id, chunk_id)
             VALUES (?1, ?2, ?3)",
            params![run_id, card_id, hit.chunk.id],
        )?;
    }
    tx.commit()?;
    Ok(hits)
}

pub fn read_for_run(
    conn: &Connection,
    run_id: &str,
    project_id: &str,
    card_id: &str,
    chunk_ids: &[String],
) -> Result<Vec<notes::PublicNoteChunk>> {
    active_scope(conn, run_id, project_id, card_id)?;
    let mut seen = BTreeSet::new();
    let ids = chunk_ids
        .iter()
        .filter(|id| seen.insert(id.as_str()))
        .take(4)
        .cloned()
        .collect::<Vec<_>>();
    if ids.is_empty() {
        return Ok(vec![]);
    }
    let placeholders = std::iter::repeat("?")
        .take(ids.len())
        .collect::<Vec<_>>()
        .join(",");
    let allow_sql = format!(
        "SELECT COUNT(*) FROM agent_attachment_search_allowlist
         WHERE run_id = ? AND card_id = ? AND chunk_id IN ({placeholders})"
    );
    let mut values = vec![
        SqlValue::Text(run_id.into()),
        SqlValue::Text(card_id.into()),
    ];
    values.extend(ids.iter().cloned().map(SqlValue::Text));
    let allowed: i64 = conn.query_row(&allow_sql, params_from_iter(values), |row| row.get(0))?;
    if allowed != ids.len() as i64 {
        return Err("只能读取当前 run 的附件搜索结果。".into());
    }
    let sql = format!(
        "SELECT c.id, c.scope, c.attachment_id, a.relative_path, c.heading_path,
                c.ordinal, c.char_start, c.char_end, c.version_hash, c.content
         FROM attachment_chunks c JOIN attachments a ON a.id = c.attachment_id
         WHERE c.card_id = ? AND c.id IN ({placeholders})"
    );
    let mut values = vec![SqlValue::Text(card_id.into())];
    values.extend(ids.iter().cloned().map(SqlValue::Text));
    let mut statement = conn.prepare(&sql)?;
    let chunks = statement
        .query_map(params_from_iter(values), row_to_chunk)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let by_id = chunks
        .into_iter()
        .map(|chunk| (chunk.id.clone(), chunk))
        .collect::<HashMap<_, _>>();
    if by_id.len() != ids.len() {
        return Err("附件片段已离开当前卡片作用域，拒绝读取。".into());
    }
    Ok(ids
        .into_iter()
        .filter_map(|id| by_id.get(&id).cloned())
        .collect())
}

pub fn resolve_citation(
    conn: &Connection,
    project_id: &str,
    request: &notes::CitationResolveRequest,
) -> Result<notes::PublicCitationResolution> {
    let card_id = request
        .library_id
        .strip_prefix("attachment:")
        .ok_or_else(|| Error("附件引用作用域格式不正确。".into()))?;
    let valid: bool = conn.query_row(
        "SELECT EXISTS(
           SELECT 1 FROM cards c JOIN attachments a ON a.card_id = c.id
           WHERE c.id = ?1 AND c.project_id = ?2 AND a.id = ?3
         )",
        params![card_id, project_id, request.document_id],
        |row| row.get(0),
    )?;
    if !valid {
        return Ok(notes::PublicCitationResolution {
            state: notes::CitationResolutionState::Missing,
            chunk: None,
            reason: Some("原来源已移除".into()),
        });
    }
    let chunk = if let Some(id) = request.chunk_id.as_deref() {
        conn.query_row(
            "SELECT c.id, c.scope, c.attachment_id, a.relative_path, c.heading_path,
                    c.ordinal, c.char_start, c.char_end, c.version_hash, c.content
             FROM attachment_chunks c JOIN attachments a ON a.id = c.attachment_id
             WHERE c.id = ?1 AND c.attachment_id = ?2",
            params![id, request.document_id],
            row_to_chunk,
        )
        .optional()?
    } else {
        None
    };
    let chunk = match chunk {
        Some(chunk) => Some(chunk),
        None => conn
            .query_row(
                "SELECT c.id, c.scope, c.attachment_id, a.relative_path, c.heading_path,
                        c.ordinal, c.char_start, c.char_end, c.version_hash, c.content
                 FROM attachment_chunks c JOIN attachments a ON a.id = c.attachment_id
                 WHERE c.attachment_id = ?1 ORDER BY c.ordinal LIMIT 1",
                params![request.document_id],
                row_to_chunk,
            )
            .optional()?,
    };
    Ok(notes::PublicCitationResolution {
        state: notes::CitationResolutionState::Current,
        chunk,
        reason: None,
    })
}

pub fn remove(conn: &mut Connection, store: &AttachmentStore, id: &str) -> Result<()> {
    let row: Option<StoredAttachment> = conn
        .query_row(
            "SELECT id, card_id, scope, name, relative_path, mime_type, byte_size, sha256,
                    storage_path, indexed, created_at, promoted_library_id, promoted_document_id
             FROM attachments WHERE id = ?1",
            params![id],
            row_to_stored,
        )
        .optional()?;
    let Some(row) = row else {
        return Ok(());
    };
    let path = store.root.join(&row.storage_path);
    if !path.starts_with(&store.root) {
        return Err("附件存储路径越界，拒绝删除。".into());
    }
    let directory = path
        .parent()
        .ok_or_else(|| Error("附件快照目录不可用。".into()))?;
    let deleting = store
        .root
        .join(".staging")
        .join(format!("deleting-{}", safe_name(id)));
    if deleting.exists() {
        let _ = std::fs::remove_dir_all(&deleting);
    }
    std::fs::rename(directory, &deleting).map_err(|_| Error("无法隔离待删除附件快照。".into()))?;
    let tx = conn.transaction()?;
    let delete_result = (|| -> Result<()> {
        tx.execute(
            "DELETE FROM attachment_chunks_fts
             WHERE chunk_id IN (SELECT id FROM attachment_chunks WHERE attachment_id = ?1)",
            params![id],
        )?;
        tx.execute("DELETE FROM attachments WHERE id = ?1", params![id])?;
        Ok(())
    })();
    if let Err(error) = delete_result {
        drop(tx);
        let _ = std::fs::rename(&deleting, directory);
        return Err(error);
    }
    if let Err(error) = tx.commit() {
        let _ = std::fs::rename(&deleting, directory);
        return Err(error.into());
    }
    std::fs::remove_dir_all(deleting)
        .map_err(|_| Error("附件记录已删除，但快照清理失败。".into()))?;
    Ok(())
}

pub fn promote(
    conn: &mut Connection,
    store: &AttachmentStore,
    project_id: &str,
    attachment_id: &str,
) -> Result<Attachment> {
    let row: StoredAttachment = conn
        .query_row(
            "SELECT a.id, a.card_id, a.scope, a.name, a.relative_path, a.mime_type,
                    a.byte_size, a.sha256, a.storage_path, a.indexed, a.created_at,
                    a.promoted_library_id, a.promoted_document_id
             FROM attachments a JOIN cards c ON c.id = a.card_id
             WHERE a.id = ?1 AND c.project_id = ?2",
            params![attachment_id, project_id],
            row_to_stored,
        )
        .optional()?
        .ok_or_else(|| Error("附件不存在、已删除或不属于当前项目。".into()))?;
    if !is_text_attachment(&row.public.name) {
        return Err("只有可读取的文本附件可以提升为项目资料。".into());
    }
    let source = store.root.join(&row.storage_path);
    if !source.starts_with(&store.root) {
        return Err("附件快照路径越界，拒绝提升。".into());
    }
    let content = std::fs::read_to_string(source)
        .map_err(|_| Error("附件快照不是可读取的 UTF-8 文本。".into()))?;
    let library_id = format!("project-attachments-{project_id}");
    let document_id = format!("promoted-{attachment_id}");
    let relative_path = format!(
        "附件提升/{}-{}.md",
        attachment_id.chars().rev().take(8).collect::<String>(),
        safe_name(&row.public.name)
    );
    let version_hash = crate::vault::normalized_hash(&content);
    let mut chunks = notes::chunk_markdown(&library_id, &relative_path, &content, &version_hash);
    for chunk in &mut chunks {
        chunk.document_id = document_id.clone();
    }
    let now = now_millis();
    let tx = conn.transaction()?;
    tx.execute(
        "INSERT INTO note_libraries (id, kind, name, root_path, created_at, updated_at)
         VALUES (?1, 'import', '项目附件资料库', NULL, ?2, ?2)
         ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at",
        params![library_id, now],
    )?;
    tx.execute(
        "DELETE FROM note_chunks_fts
         WHERE chunk_id IN (SELECT id FROM note_chunks WHERE document_id = ?1)",
        params![document_id],
    )?;
    tx.execute(
        "DELETE FROM note_documents WHERE id = ?1",
        params![document_id],
    )?;
    tx.execute(
        "INSERT INTO note_documents (
           id, library_id, relative_path, title, tags, version_hash, updated_at
         ) VALUES (?1,?2,?3,?4,'[]',?5,?6)",
        params![
            document_id,
            library_id,
            relative_path,
            row.public.name,
            version_hash,
            now
        ],
    )?;
    for chunk in &chunks {
        tx.execute(
            "INSERT INTO note_chunks (
               id, library_id, document_id, ordinal, heading_path, content,
               char_start, char_end, version_hash
             ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
            params![
                chunk.id,
                library_id,
                document_id,
                chunk.ordinal as i64,
                serde_json::to_string(&chunk.heading_path)?,
                chunk.content,
                chunk.char_start as i64,
                chunk.char_end as i64,
                chunk.version_hash,
            ],
        )?;
        tx.execute(
            "INSERT INTO note_chunks_fts (chunk_id, library_id, content)
             VALUES (?1, ?2, ?3)",
            params![chunk.id, library_id, chunk.content],
        )?;
    }
    tx.execute(
        "INSERT OR IGNORE INTO project_note_libraries (project_id, library_id)
         VALUES (?1, ?2)",
        params![project_id, library_id],
    )?;
    tx.execute(
        "UPDATE attachments
         SET promoted_library_id = ?1, promoted_document_id = ?2
         WHERE id = ?3",
        params![library_id, document_id, attachment_id],
    )?;
    tx.commit()?;
    Ok(Attachment {
        promoted_library_id: Some(library_id),
        promoted_document_id: Some(document_id),
        ..row.public
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn seeded() -> (Connection, AttachmentStore, AttachmentImports) {
        let conn = crate::db::open_in_memory().unwrap();
        conn.execute(
            "INSERT INTO projects (id, name, pinned, updated_at) VALUES ('p','P',0,1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO cards (id, project_id, title, favorite, unread, created_at, concepts)
             VALUES ('c','p','C',0,0,1,'[]')",
            [],
        )
        .unwrap();
        let root = tempdir().unwrap().keep();
        (
            conn,
            AttachmentStore::new(root).unwrap(),
            AttachmentImports::default(),
        )
    }

    fn quiet_channel() -> Channel<AttachmentProgress> {
        Channel::new(|_| Ok(()))
    }

    fn import_text(
        conn: &mut Connection,
        store: &AttachmentStore,
        imports: &AttachmentImports,
        card_id: &str,
        path: &Path,
    ) -> Attachment {
        let paths = vec![path.display().to_string()];
        let preflight = preflight(conn, imports, card_id, &paths).unwrap();
        import(
            conn,
            imports,
            store,
            &AttachmentImportRequest {
                job_id: preflight.job_id,
                card_id: card_id.into(),
                paths,
                confirmed: true,
            },
            &quiet_channel(),
        )
        .unwrap()
        .attachments
        .remove(0)
    }

    #[test]
    fn enumeration_is_sorted_does_not_follow_symlinks_and_never_exposes_absolute_paths() {
        let (conn, _store, imports) = seeded();
        let source = tempdir().unwrap();
        std::fs::create_dir_all(source.path().join("folder")).unwrap();
        std::fs::write(source.path().join("folder/b.txt"), "B").unwrap();
        std::fs::write(source.path().join("folder/a.txt"), "A").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(
            source.path().join("folder/a.txt"),
            source.path().join("folder/link.txt"),
        )
        .unwrap();
        let result = preflight(
            &conn,
            &imports,
            "c",
            &[source.path().join("folder").display().to_string()],
        )
        .unwrap();
        assert_eq!(
            result
                .items
                .iter()
                .map(|item| item.relative_path.as_str())
                .collect::<Vec<_>>(),
            vec!["folder/a.txt", "folder/b.txt"]
        );
        assert!(!serde_json::to_string(&result)
            .unwrap()
            .contains(&source.path().display().to_string()));
    }

    #[test]
    fn attachment_tables_are_separate_from_formal_note_tables() {
        let (conn, _store, _imports) = seeded();
        for table in [
            "attachments",
            "attachment_chunks",
            "note_documents",
            "note_chunks",
        ] {
            let exists: bool = conn
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
                    params![table],
                    |row| row.get(0),
                )
                .unwrap();
            assert!(exists, "{table}");
        }
        let foreign: String = conn
            .query_row(
                "SELECT sql FROM sqlite_master WHERE name='agent_attachment_search_allowlist'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(foreign.contains("attachment_chunks"));
        assert!(!foreign.contains("note_chunks(id)"));
    }

    #[test]
    fn import_owns_a_byte_snapshot_and_cleans_cancelled_partial_work() {
        let (mut conn, store, imports) = seeded();
        let source = tempdir().unwrap();
        let path = source.path().join("fact.md");
        std::fs::write(&path, "original attachment bytes").unwrap();
        let attachment = import_text(&mut conn, &store, &imports, "c", &path);
        std::fs::write(&path, "mutated source").unwrap();
        std::fs::remove_file(&path).unwrap();

        let stored: StoredAttachment = conn
            .query_row(
                "SELECT id, card_id, scope, name, relative_path, mime_type, byte_size, sha256,
                        storage_path, indexed, created_at, promoted_library_id, promoted_document_id
                 FROM attachments WHERE id = ?1",
                params![attachment.id],
                row_to_stored,
            )
            .unwrap();
        assert_eq!(
            std::fs::read_to_string(store.root.join(&stored.storage_path)).unwrap(),
            "original attachment bytes"
        );
        assert!(!stored
            .storage_path
            .contains(&source.path().display().to_string()));

        let cancelled_path = source.path().join("cancelled.md");
        std::fs::write(&cancelled_path, "must not survive").unwrap();
        let paths = vec![cancelled_path.display().to_string()];
        let plan = preflight(&conn, &imports, "c", &paths).unwrap();
        cancel(&imports, &plan.job_id).unwrap();
        let error = import(
            &mut conn,
            &imports,
            &store,
            &AttachmentImportRequest {
                job_id: plan.job_id,
                card_id: "c".into(),
                paths,
                confirmed: true,
            },
            &quiet_channel(),
        )
        .unwrap_err();
        assert!(error.to_string().contains("取消"));
        let staging_count = std::fs::read_dir(store.root.join(".staging"))
            .unwrap()
            .count();
        assert_eq!(staging_count, 0);
        assert_eq!(list(&conn, "c").unwrap().len(), 1);
    }

    #[test]
    fn run_scope_and_separate_allowlist_reject_cross_card_and_guessed_reads() {
        let (mut conn, store, imports) = seeded();
        conn.execute(
            "INSERT INTO cards (id, project_id, title, favorite, unread, created_at, concepts)
             VALUES ('other','p','Other',0,0,2,'[]')",
            [],
        )
        .unwrap();
        let source = tempdir().unwrap();
        let path = source.path().join("scope.md");
        std::fs::write(&path, "ORBIT-RUST-SCOPE-42").unwrap();
        let attachment = import_text(&mut conn, &store, &imports, "c", &path);
        conn.execute(
            "INSERT INTO turns (id, card_id, role, content, created_at)
             VALUES ('turn-c','c','ai','',3)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO agent_runs (
               id, turn_id, schema_version, phase, started_at, updated_at, last_sequence, checkpoint
             ) VALUES ('run-c','turn-c',1,'searching',3,3,0,?1)",
            params![serde_json::json!({
                "hostScope": {
                    "projectId": "p",
                    "libraryIds": [],
                    "cardId": "c",
                    "attachmentScope": "attachment:c"
                }
            })
            .to_string()],
        )
        .unwrap();

        let hits = search_for_run(&mut conn, "run-c", "p", "c", "ORBIT-RUST-SCOPE-42", 8).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].chunk.document_id, attachment.id);
        assert!(
            search_for_run(&mut conn, "run-c", "p", "other", "ORBIT-RUST-SCOPE-42", 8)
                .unwrap_err()
                .to_string()
                .contains("宿主作用域")
        );
        assert!(
            read_for_run(&conn, "run-c", "p", "c", &["attachment-guessed".into()])
                .unwrap_err()
                .to_string()
                .contains("搜索结果")
        );
        let read = read_for_run(&conn, "run-c", "p", "c", &[hits[0].chunk.id.clone()]).unwrap();
        assert_eq!(read[0].text, "ORBIT-RUST-SCOPE-42");
    }

    #[test]
    fn explicit_promotion_copies_into_formal_library_without_changing_attachment_scope() {
        let (mut conn, store, imports) = seeded();
        let source = tempdir().unwrap();
        let path = source.path().join("promote.md");
        std::fs::write(&path, "promotion fact").unwrap();
        let attachment = import_text(&mut conn, &store, &imports, "c", &path);
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM note_documents", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        let promoted = promote(&mut conn, &store, "p", &attachment.id).unwrap();
        assert_eq!(promoted.scope, "attachment:c");
        assert_eq!(
            promoted.promoted_library_id.as_deref(),
            Some("project-attachments-p")
        );
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM note_documents", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM attachment_chunks", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }
}
