//! SQLite 持久化层。
//!
//! 与 `src/lib/storage/dexie.ts` 实现同一个 `StorageAdapter` 契约，语义必须逐条对齐：
//!
//! - 日常保存 `apply_changes` **只增不删**；
//! - 删除只有三个入口，其中 `delete_project_cascade` 在事务内按 project_id 重新查库
//!   定位从属行，不依赖调用方的内存基线；
//! - `put_attention_state` 是 upsert-only，绝不清空会话与提案。
//!
//! 表结构见 `schema.sql`。JSON 与真列的取舍判据写在那里。

use rusqlite::{params, params_from_iter, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::Path;

const SCHEMA: &str = include_str!("schema.sql");
const USER_VERSION: i64 = 11;
const AGENT_EVENT_SCHEMA_VERSION: i64 = 1;
const AGENT_EVENT_TYPES: &[&str] = &[
    "exploration-started",
    "search-requested",
    "search-completed",
    "read-requested",
    "read-completed",
    "duplicate-call-detected",
    "protocol-repaired",
    "retry",
    "budget-added",
    "final-synthesis",
    "terminal",
];
const AGENT_RUN_PHASES: &[&str] = &[
    "exploring",
    "searching",
    "reading",
    "repairing",
    "retrying",
    "synthesizing",
    "interrupted",
    "terminal",
];

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
        Error(value.to_string())
    }
}
impl From<serde_json::Error> for Error {
    fn from(value: serde_json::Error) -> Self {
        Error(value.to_string())
    }
}
impl From<String> for Error {
    fn from(value: String) -> Self {
        Error(value)
    }
}
impl From<&str> for Error {
    fn from(value: &str) -> Self {
        Error(value.to_string())
    }
}
impl serde::Serialize for Error {
    fn serialize<S: serde::Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        s.serialize_str(&self.0)
    }
}

// ---------------------------------------------------------------------------
// 线材类型
//
// 只给 vault 写入器必须解释的四个类型写结构体（Project / Card / Turn / CardEdge）。
// 其余（ViewState、AppSettings、ContextSnapshot、ReferenceChip、Proposal…）走
// `doc TEXT` JSON 列，只把需要的列提升出来——把它们镜像成 Rust 结构体是纯粹的
// 类型漂移风险，而 Rust 永远不需要解释 attentionPromptHistory 里有什么。
// ---------------------------------------------------------------------------

/// 列为 NULL 时**省略键**而不是写 `undefined`。否则 `sameCardRecord` 的键数比较会在
/// 每次重载后的首次 diff 全部触发，把每张卡片白白重写一遍。
fn skip_none<T: Serialize>(value: &Option<T>) -> bool {
    value.is_none()
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub pinned: bool,
    pub updated_at: i64,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Turn {
    pub id: String,
    pub role: String,
    pub content: String,
    pub created_at: i64,
    #[serde(default, skip_serializing_if = "skip_none")]
    pub streaming: Option<bool>,
    #[serde(default, skip_serializing_if = "skip_none")]
    pub status: Option<String>,
    #[serde(default, skip_serializing_if = "skip_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "skip_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "skip_none")]
    pub favorite: Option<bool>,
    /// 可审计的 Harness 运行轨迹；没有模型隐藏推理。
    #[serde(default, skip_serializing_if = "skip_none")]
    pub agent_run: Option<Value>,
    /// 只允许由实际读取过的 note chunk 生成的受控引用。
    #[serde(default, skip_serializing_if = "skip_none")]
    pub citations: Option<Value>,
    /// 生成中可见的 Harness 阶段；只为恢复 UI，不含模型内部过程。
    #[serde(default, skip_serializing_if = "skip_none")]
    pub agent_phase: Option<String>,
}

/// 落库的卡片行不含 turns，与 Dexie 侧的 `CardRecord` 一致。
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CardRecord {
    pub id: String,
    pub project_id: String,
    pub title: String,
    #[serde(default)]
    pub favorite: bool,
    #[serde(default)]
    pub unread: bool,
    #[serde(default, skip_serializing_if = "skip_none")]
    pub answer_mode: Option<String>,
    #[serde(default)]
    pub concepts: Vec<String>,
    #[serde(default, skip_serializing_if = "skip_none")]
    pub concept_preview_cache: Option<Value>,
    #[serde(default, skip_serializing_if = "skip_none")]
    pub trashed: Option<bool>,
    #[serde(default, skip_serializing_if = "skip_none")]
    pub origin: Option<String>,
    #[serde(default, skip_serializing_if = "skip_none")]
    pub proposal_id: Option<String>,
    pub created_at: i64,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TurnRecord {
    #[serde(flatten)]
    pub turn: Turn,
    pub card_id: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentStepEventInput {
    pub id: String,
    pub schema_version: i64,
    pub occurred_at: i64,
    pub message: Value,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AppendAgentStepInput {
    pub run_id: String,
    pub turn_id: String,
    pub schema_version: i64,
    pub started_at: i64,
    pub updated_at: i64,
    #[serde(default, skip_serializing_if = "skip_none")]
    pub finished_at: Option<i64>,
    #[serde(default, skip_serializing_if = "skip_none")]
    pub expected_last_sequence: Option<i64>,
    pub checkpoint: Value,
    pub event: AgentStepEventInput,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentRunRecord {
    pub id: String,
    pub turn_id: String,
    pub schema_version: i64,
    pub phase: String,
    pub started_at: i64,
    pub updated_at: i64,
    #[serde(default, skip_serializing_if = "skip_none")]
    pub finished_at: Option<i64>,
    pub last_sequence: i64,
    pub checkpoint: Value,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentEventRecord {
    pub id: String,
    pub run_id: String,
    pub sequence: i64,
    pub schema_version: i64,
    pub event_type: String,
    pub occurred_at: i64,
    pub message: Value,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum AgentAudit {
    EventSourced {
        run: AgentRunRecord,
        events: Vec<AgentEventRecord>,
    },
    Legacy {
        #[serde(rename = "turnId")]
        turn_id: String,
        trace: Option<Value>,
    },
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CardEdge {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub source_card_id: String,
    pub target_card_id: String,
    #[serde(default, skip_serializing_if = "skip_none")]
    pub source_turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "skip_none")]
    pub source_text: Option<String>,
    #[serde(default, skip_serializing_if = "skip_none")]
    pub source_block_text: Option<String>,
    #[serde(default, skip_serializing_if = "skip_none")]
    pub source_anchor_id: Option<String>,
    #[serde(default, skip_serializing_if = "skip_none")]
    pub context_snapshot_id: Option<String>,
    #[serde(default, skip_serializing_if = "skip_none")]
    pub context_cutoff_turn_id: Option<String>,
    pub context_policy: String,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct TableUpsert<T> {
    #[serde(default = "Vec::new")]
    pub upserts: Vec<T>,
}

// 手写而不是 derive：`#[derive(Default)]` 会加一条 `T: Default` 约束，而空表根本
// 不需要元素类型可默认构造。
impl<T> Default for TableUpsert<T> {
    fn default() -> Self {
        Self {
            upserts: Vec::new(),
        }
    }
}

#[derive(Serialize, Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceUpsert {
    #[serde(default)]
    pub projects: TableUpsert<Project>,
    #[serde(default)]
    pub cards: TableUpsert<CardRecord>,
    #[serde(default)]
    pub turns: TableUpsert<TurnRecord>,
    #[serde(default)]
    pub edges: TableUpsert<CardEdge>,
    #[serde(default)]
    pub anchors: TableUpsert<Value>,
    #[serde(default)]
    pub snapshots: TableUpsert<Value>,
    #[serde(default)]
    pub references: TableUpsert<Value>,
    #[serde(default)]
    pub view: Option<Value>,
    #[serde(default)]
    pub settings: Option<Value>,
}

#[derive(Serialize, Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct AttentionUpsert {
    #[serde(default)]
    pub events: TableUpsert<Value>,
    #[serde(default)]
    pub sessions: TableUpsert<Value>,
    #[serde(default)]
    pub proposals: TableUpsert<Value>,
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSnapshot {
    pub projects: Vec<Project>,
    /// 带 turns 的完整卡片，与前端 `WorkspaceSnapshot` 一致。
    pub cards: Vec<Value>,
    pub edges: Vec<CardEdge>,
    pub anchors: Vec<Value>,
    pub snapshots: Vec<Value>,
    pub references: Vec<Value>,
    pub view: Value,
    pub settings: Value,
}

#[derive(Serialize, Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct AttentionSnapshot {
    pub events: Vec<Value>,
    pub sessions: Vec<Value>,
    pub proposals: Vec<Value>,
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RemovedProject {
    pub workspace: WorkspaceUpsert,
    pub attention: AttentionUpsert,
}

// ---------------------------------------------------------------------------
// 连接与迁移
// ---------------------------------------------------------------------------

pub fn open(path: &Path) -> Result<Connection> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| Error(e.to_string()))?;
    }
    let conn = Connection::open(path)?;
    migrate(&conn)?;
    Ok(conn)
}

/// 测试用。走同一条 `migrate()`，所以 schema 与真实库不会漂移。
#[cfg(test)]
pub fn open_in_memory() -> Result<Connection> {
    let conn = Connection::open_in_memory()?;
    migrate(&conn)?;
    Ok(conn)
}

/// `PRAGMA user_version` 阶梯，与 Dexie 的 version(1)/(2)/(3) 是同一个模式。
///
/// schema.sql 里的 DDL 全部是 `IF NOT EXISTS`，所以「版本落后就整份重放一遍」是
/// 幂等的，比维护一串增量 DDL 更难写错。注意判据必须是 `< USER_VERSION` 而不是
/// `< 1`——否则已经在 v1 的库永远拿不到后续版本新增的表。
fn has_column(conn: &Connection, table: &str, column: &str) -> Result<bool> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        if row.get::<_, String>(1)? == column {
            return Ok(true);
        }
    }
    Ok(false)
}

fn migrate(conn: &Connection) -> Result<()> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if version < USER_VERSION {
        conn.execute_batch(SCHEMA)?;
        // v4 曾把模型草稿存到 turns.reasoning。此字段不属于产品数据模型；保留旧列
        // 只为避免在用户库上重建 turns 的风险，但升级时必须擦空其中所有内容。
        if version < 5 && has_column(conn, "turns", "reasoning")? {
            conn.execute(
                "UPDATE turns SET reasoning = NULL WHERE reasoning IS NOT NULL",
                [],
            )?;
        }
        // `CREATE TABLE IF NOT EXISTS` 不会给已有 turns 补列，v6 必须显式升级。
        // 这两列都是 JSON 运输字段，不加索引，避免流式落库的写放大。
        if version < 6 && !has_column(conn, "turns", "agent_run")? {
            conn.execute("ALTER TABLE turns ADD COLUMN agent_run TEXT", [])?;
        }
        if version < 6 && !has_column(conn, "turns", "citations")? {
            conn.execute("ALTER TABLE turns ADD COLUMN citations TEXT", [])?;
        }
        // v7 只补一个用户可见的短状态。它不是推理链，也不参与上下文组装。
        if version < 7 && !has_column(conn, "turns", "agent_phase")? {
            conn.execute("ALTER TABLE turns ADD COLUMN agent_phase TEXT", [])?;
        }
        // Pre-v10 capability rows cannot prove all three admission stages and
        // must be invalidated rather than guessed into the current schema.
        if version < 10 {
            let raw: Option<String> = conn
                .query_row("SELECT doc FROM settings WHERE id = 'app'", [], |row| {
                    row.get(0)
                })
                .optional()?;
            if let Some(raw) = raw {
                let mut settings: Value = serde_json::from_str(&raw)?;
                if let Some(object) = settings.as_object_mut() {
                    object.insert("providerCapabilities".into(), Value::Array(vec![]));
                    object.insert(
                        "providerCapabilityTtlMs".into(),
                        Value::from(24 * 60 * 60 * 1_000_i64),
                    );
                    conn.execute(
                        "UPDATE settings SET doc = ?1 WHERE id = 'app'",
                        params![serde_json::to_string(&settings)?],
                    )?;
                }
            }
        }
        conn.execute_batch(&format!("PRAGMA user_version = {USER_VERSION}"))?;
    }
    // FTS 虚表不是 schema.sql 的静态 DDL（需要在 trigram 不可用时降级），所以
    // 即使某个历史库的 user_version 已经写成最新，也在打开时补一次缺失索引。
    ensure_note_fts(conn)?;
    ensure_attachment_fts(conn)?;
    // 每次打开都要重设：foreign_keys 是 per-connection 的，不随库持久化。
    conn.execute_batch("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;")?;
    Ok(())
}

/// FTS5 由 rusqlite bundled SQLite 提供。优先 trigram（中英文、片段查询都好用），
/// 若某个旧系统 SQLite 不识别该 tokenizer，仍保留一个 unicode61 FTS5 索引，让只读
/// 检索降级而不是让整个桌面应用无法启动。
fn ensure_note_fts(conn: &Connection) -> Result<()> {
    let exists: Option<String> = conn
        .query_row(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'note_chunks_fts'",
            [],
            |row| row.get(0),
        )
        .optional()?;
    if exists.is_some() {
        return Ok(());
    }
    let trigram = "CREATE VIRTUAL TABLE note_chunks_fts USING fts5(\
        chunk_id UNINDEXED, library_id UNINDEXED, content, tokenize='trigram')";
    if conn.execute_batch(trigram).is_err() {
        conn.execute_batch(
            "CREATE VIRTUAL TABLE note_chunks_fts USING fts5(\
              chunk_id UNINDEXED, library_id UNINDEXED, content, tokenize='unicode61')",
        )?;
    }
    Ok(())
}

fn ensure_attachment_fts(conn: &Connection) -> Result<()> {
    let exists: Option<String> = conn
        .query_row(
            "SELECT name FROM sqlite_master
             WHERE type = 'table' AND name = 'attachment_chunks_fts'",
            [],
            |row| row.get(0),
        )
        .optional()?;
    if exists.is_some() {
        return Ok(());
    }
    let trigram = "CREATE VIRTUAL TABLE attachment_chunks_fts USING fts5(\
        chunk_id UNINDEXED, card_id UNINDEXED, content, tokenize='trigram')";
    if conn.execute_batch(trigram).is_err() {
        conn.execute_batch(
            "CREATE VIRTUAL TABLE attachment_chunks_fts USING fts5(\
              chunk_id UNINDEXED, card_id UNINDEXED, content, tokenize='unicode61')",
        )?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// 读
// ---------------------------------------------------------------------------

fn json_col(raw: Option<String>) -> Result<Option<Value>> {
    Ok(match raw {
        Some(text) => Some(serde_json::from_str(&text)?),
        None => None,
    })
}

/// 把可选字段插回 JSON 对象；值为 NULL 时**不插入这个键**。
fn put_opt(map: &mut serde_json::Map<String, Value>, key: &str, value: Option<Value>) {
    if let Some(v) = value {
        map.insert(key.to_string(), v);
    }
}

fn read_projects(conn: &Connection) -> Result<Vec<Project>> {
    let mut stmt = conn.prepare("SELECT id, name, pinned, updated_at FROM projects")?;
    let rows = stmt.query_map([], |row| {
        Ok(Project {
            id: row.get(0)?,
            name: row.get(1)?,
            pinned: row.get::<_, i64>(2)? != 0,
            updated_at: row.get(3)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

fn read_card_records(conn: &Connection) -> Result<Vec<CardRecord>> {
    let mut stmt = conn.prepare(
        "SELECT id, project_id, title, favorite, unread, answer_mode, trashed, origin,
                proposal_id, created_at, concepts, concept_preview_cache FROM cards",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, i64>(3)?,
            row.get::<_, i64>(4)?,
            row.get::<_, Option<String>>(5)?,
            row.get::<_, Option<i64>>(6)?,
            row.get::<_, Option<String>>(7)?,
            row.get::<_, Option<String>>(8)?,
            row.get::<_, i64>(9)?,
            row.get::<_, String>(10)?,
            row.get::<_, Option<String>>(11)?,
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let r = row?;
        out.push(CardRecord {
            id: r.0,
            project_id: r.1,
            title: r.2,
            favorite: r.3 != 0,
            unread: r.4 != 0,
            answer_mode: r.5,
            trashed: r.6.map(|v| v != 0),
            origin: r.7,
            proposal_id: r.8,
            created_at: r.9,
            concepts: serde_json::from_str(&r.10)?,
            concept_preview_cache: json_col(r.11)?,
        });
    }
    Ok(out)
}

fn read_turns(conn: &Connection) -> Result<Vec<TurnRecord>> {
    let mut stmt = conn.prepare(
        "SELECT id, card_id, role, content, created_at, streaming, status, error, model, favorite,
                agent_run, citations, agent_phase
         FROM turns ORDER BY card_id, created_at",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, i64>(4)?,
            row.get::<_, Option<i64>>(5)?,
            row.get::<_, Option<String>>(6)?,
            row.get::<_, Option<String>>(7)?,
            row.get::<_, Option<String>>(8)?,
            row.get::<_, Option<i64>>(9)?,
            row.get::<_, Option<String>>(10)?,
            row.get::<_, Option<String>>(11)?,
            row.get::<_, Option<String>>(12)?,
        ))
    })?;
    let mut output = Vec::new();
    for row in rows {
        let value = row?;
        output.push(TurnRecord {
            card_id: value.1,
            turn: Turn {
                id: value.0,
                role: value.2,
                content: value.3,
                created_at: value.4,
                streaming: value.5.map(|flag| flag != 0),
                status: value.6,
                error: value.7,
                model: value.8,
                favorite: value.9.map(|flag| flag != 0),
                agent_run: json_col(value.10)?,
                citations: json_col(value.11)?,
                agent_phase: value.12,
            },
        });
    }
    Ok(output)
}

type AgentRunRow = (
    String,
    String,
    i64,
    String,
    i64,
    i64,
    Option<i64>,
    i64,
    String,
);

fn read_agent_run_by_turn(conn: &Connection, turn_id: &str) -> Result<Option<AgentRunRecord>> {
    let row: Option<AgentRunRow> = conn
        .query_row(
            "SELECT id, turn_id, schema_version, phase, started_at, updated_at, finished_at,
                    last_sequence, checkpoint
             FROM agent_runs WHERE turn_id = ?1",
            params![turn_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                    row.get(7)?,
                    row.get(8)?,
                ))
            },
        )
        .optional()?;
    row.map(|value| {
        Ok(AgentRunRecord {
            id: value.0,
            turn_id: value.1,
            schema_version: value.2,
            phase: value.3,
            started_at: value.4,
            updated_at: value.5,
            finished_at: value.6,
            last_sequence: value.7,
            checkpoint: serde_json::from_str(&value.8)?,
        })
    })
    .transpose()
}

fn read_agent_events(conn: &Connection, run_id: &str) -> Result<Vec<AgentEventRecord>> {
    let mut stmt = conn.prepare(
        "SELECT id, run_id, sequence, schema_version, event_type, occurred_at, message
         FROM agent_events WHERE run_id = ?1 ORDER BY sequence",
    )?;
    let rows = stmt.query_map(params![run_id], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, i64>(2)?,
            row.get::<_, i64>(3)?,
            row.get::<_, String>(4)?,
            row.get::<_, i64>(5)?,
            row.get::<_, String>(6)?,
        ))
    })?;
    let mut events = Vec::new();
    for row in rows {
        let value = row?;
        events.push(AgentEventRecord {
            id: value.0,
            run_id: value.1,
            sequence: value.2,
            schema_version: value.3,
            event_type: value.4,
            occurred_at: value.5,
            message: serde_json::from_str(&value.6)?,
        });
    }
    Ok(events)
}

pub fn load_agent_audit(conn: &Connection, turn_id: &str) -> Result<Option<AgentAudit>> {
    if let Some(run) = read_agent_run_by_turn(conn, turn_id)? {
        let events = read_agent_events(conn, &run.id)?;
        return Ok(Some(AgentAudit::EventSourced { run, events }));
    }

    // v7 及更早的 turn 继续从原摘要读取。这里绝不 INSERT/backfill。
    let legacy: Option<Option<String>> = conn
        .query_row(
            "SELECT agent_run FROM turns WHERE id = ?1",
            params![turn_id],
            |row| row.get(0),
        )
        .optional()?;
    let Some(raw) = legacy else {
        return Ok(None);
    };
    Ok(Some(AgentAudit::Legacy {
        turn_id: turn_id.to_string(),
        trace: json_col(raw)?,
    }))
}

fn read_edges(conn: &Connection) -> Result<Vec<CardEdge>> {
    let mut stmt = conn.prepare(
        "SELECT id, type, source_card_id, target_card_id, source_turn_id, source_text,
                source_block_text, source_anchor_id, context_snapshot_id,
                context_cutoff_turn_id, context_policy FROM edges",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(CardEdge {
            id: row.get(0)?,
            kind: row.get(1)?,
            source_card_id: row.get(2)?,
            target_card_id: row.get(3)?,
            source_turn_id: row.get(4)?,
            source_text: row.get(5)?,
            source_block_text: row.get(6)?,
            source_anchor_id: row.get(7)?,
            context_snapshot_id: row.get(8)?,
            context_cutoff_turn_id: row.get(9)?,
            context_policy: row.get(10)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

fn read_anchors(conn: &Connection) -> Result<Vec<Value>> {
    let mut stmt = conn.prepare(
        "SELECT id, card_id, turn_id, text, block_text, exact, prefix, suffix, source_revision
         FROM anchors",
    )?;
    let rows = stmt.query_map([], |row| {
        let mut map = serde_json::Map::new();
        map.insert("id".into(), Value::String(row.get(0)?));
        map.insert("cardId".into(), Value::String(row.get(1)?));
        for (index, key) in [
            (2, "turnId"),
            (3, "text"),
            (4, "blockText"),
            (5, "exact"),
            (6, "prefix"),
            (7, "suffix"),
            (8, "sourceRevision"),
        ] {
            put_opt(
                &mut map,
                key,
                row.get::<_, Option<String>>(index)?.map(Value::String),
            );
        }
        Ok(Value::Object(map))
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

fn read_snapshots(conn: &Connection) -> Result<Vec<Value>> {
    let mut stmt = conn.prepare(
        "SELECT id, edge_id, created_at, source_title, source_text, source_block_text, source_turns
         FROM snapshots",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, i64>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, Option<String>>(4)?,
            row.get::<_, Option<String>>(5)?,
            row.get::<_, Option<String>>(6)?,
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let r = row?;
        let mut map = serde_json::Map::new();
        map.insert("id".into(), Value::String(r.0));
        map.insert("edgeId".into(), Value::String(r.1));
        map.insert("createdAt".into(), Value::from(r.2));
        map.insert("sourceTitle".into(), Value::String(r.3));
        put_opt(&mut map, "sourceText", r.4.map(Value::String));
        put_opt(&mut map, "sourceBlockText", r.5.map(Value::String));
        put_opt(&mut map, "sourceTurns", json_col(r.6)?);
        out.push(Value::Object(map));
    }
    Ok(out)
}

fn read_references(conn: &Connection) -> Result<Vec<Value>> {
    let mut stmt =
        conn.prepare("SELECT id, project_id, source_title, excerpt, anchor FROM refs")?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, String>(4)?,
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let r = row?;
        let mut map = serde_json::Map::new();
        map.insert("id".into(), Value::String(r.0));
        map.insert("projectId".into(), Value::String(r.1));
        map.insert("sourceTitle".into(), Value::String(r.2));
        map.insert("excerpt".into(), Value::String(r.3));
        map.insert("anchor".into(), serde_json::from_str(&r.4)?);
        out.push(Value::Object(map));
    }
    Ok(out)
}

fn read_singleton(conn: &Connection, table: &str, id: &str) -> Result<Option<Value>> {
    let raw: Option<String> = conn
        .query_row(
            &format!("SELECT doc FROM {table} WHERE id = ?1"),
            params![id],
            |row| row.get(0),
        )
        .optional()?;
    json_col(raw)
}

fn read_docs(conn: &Connection, table: &str, order: &str) -> Result<Vec<Value>> {
    let mut stmt = conn.prepare(&format!("SELECT doc FROM {table} ORDER BY {order}"))?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(serde_json::from_str(&row?)?);
    }
    Ok(out)
}

pub fn load_workspace(conn: &Connection) -> Result<Option<WorkspaceSnapshot>> {
    let projects = read_projects(conn)?;
    let view = read_singleton(conn, "view", "main")?;
    let settings = read_singleton(conn, "settings", "app")?;
    // 与 Dexie 侧一致：三者缺一即视为「库是空的」。
    let (Some(view), Some(settings)) = (view, settings) else {
        return Ok(None);
    };
    if projects.is_empty() {
        return Ok(None);
    }

    let records = read_card_records(conn)?;
    let turns = read_turns(conn)?;
    let mut by_card: std::collections::HashMap<String, Vec<Value>> =
        std::collections::HashMap::new();
    for record in turns {
        by_card
            .entry(record.card_id.clone())
            .or_default()
            .push(serde_json::to_value(&record.turn)?);
    }
    let mut cards = Vec::with_capacity(records.len());
    for record in records {
        let mut value = serde_json::to_value(&record)?;
        let map = value.as_object_mut().expect("card serialises to an object");
        map.insert(
            "turns".into(),
            Value::Array(by_card.remove(&record.id).unwrap_or_default()),
        );
        cards.push(value);
    }

    Ok(Some(WorkspaceSnapshot {
        projects,
        cards,
        edges: read_edges(conn)?,
        anchors: read_anchors(conn)?,
        snapshots: read_snapshots(conn)?,
        references: read_references(conn)?,
        view,
        settings,
    }))
}

pub fn load_attention(conn: &Connection) -> Result<AttentionSnapshot> {
    Ok(AttentionSnapshot {
        events: read_docs(conn, "interaction_events", "created_at")?,
        sessions: read_docs(conn, "session_boundaries", "started_at")?,
        proposals: read_docs(conn, "proposals", "created_at")?,
    })
}

// ---------------------------------------------------------------------------
// 写
// ---------------------------------------------------------------------------

fn str_field(value: &Value, key: &str) -> Option<String> {
    value.get(key)?.as_str().map(str::to_string)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(not(test), allow(dead_code))]
enum AgentAppendCrashPoint {
    RunEnsured,
    EventInserted,
    RunStateChanged,
}

fn validate_agent_step(input: &AppendAgentStepInput) -> Result<(String, String)> {
    if input.schema_version != AGENT_EVENT_SCHEMA_VERSION
        || input.event.schema_version != AGENT_EVENT_SCHEMA_VERSION
    {
        return Err(Error(format!(
            "不支持的 Agent 事件 schema_version：run={} event={}",
            input.schema_version, input.event.schema_version
        )));
    }
    let event_type = input
        .event
        .message
        .get("kind")
        .and_then(Value::as_str)
        .filter(|kind| AGENT_EVENT_TYPES.contains(kind))
        .ok_or_else(|| Error("未知的 Agent 事件类型".into()))?
        .to_string();
    let phase = input
        .checkpoint
        .get("phase")
        .and_then(Value::as_str)
        .filter(|phase| AGENT_RUN_PHASES.contains(phase))
        .ok_or_else(|| Error("未知的 Agent 运行阶段".into()))?
        .to_string();
    if input.updated_at < input.started_at || input.event.occurred_at < input.started_at {
        return Err(Error("Agent 步骤时间早于运行开始时间".into()));
    }
    let terminal = event_type == "terminal";
    if terminal != (phase == "terminal") || terminal != input.finished_at.is_some() {
        return Err(Error(
            "terminal 事件、terminal 阶段和 finishedAt 必须同时出现".into(),
        ));
    }
    Ok((event_type, phase))
}

fn maybe_inject_agent_crash(
    actual: Option<AgentAppendCrashPoint>,
    expected: AgentAppendCrashPoint,
) -> Result<()> {
    if actual == Some(expected) {
        return Err(Error(format!("injected crash at {expected:?}")));
    }
    Ok(())
}

fn append_agent_step_inner(
    conn: &mut Connection,
    input: &AppendAgentStepInput,
    crash: Option<AgentAppendCrashPoint>,
) -> Result<AgentEventRecord> {
    let (event_type, phase) = validate_agent_step(input)?;
    let tx = conn.transaction()?;

    let turn_exists: i64 = tx.query_row(
        "SELECT COUNT(*) FROM turns WHERE id = ?1",
        params![input.turn_id],
        |row| row.get(0),
    )?;
    if turn_exists != 1 {
        return Err(Error(format!(
            "Agent run 引用了不存在的 turn：{}",
            input.turn_id
        )));
    }

    let existing: Option<(String, i64, String, i64, i64, i64, String)> = tx
        .query_row(
            "SELECT turn_id, schema_version, phase, last_sequence, started_at, updated_at,
                    checkpoint
             FROM agent_runs WHERE id = ?1",
            params![input.run_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                ))
            },
        )
        .optional()?;
    let last_sequence = match existing {
        Some((
            turn_id,
            schema_version,
            existing_phase,
            last_sequence,
            started_at,
            updated_at,
            existing_checkpoint,
        )) => {
            if turn_id != input.turn_id
                || schema_version != input.schema_version
                || started_at != input.started_at
            {
                return Err(Error("Agent run 标识与既有记录不一致".into()));
            }
            if input
                .expected_last_sequence
                .is_some_and(|expected| expected != last_sequence)
            {
                return Err(Error("Agent run 游标在续跑认领前已变化".into()));
            }
            let previous_checkpoint: Value = serde_json::from_str(&existing_checkpoint)?;
            let continuation_claim = event_type == "budget-added"
                && input
                    .event
                    .message
                    .get("added")
                    .is_some_and(Value::is_object)
                && phase == "exploring"
                && input.expected_last_sequence == Some(last_sequence)
                && previous_checkpoint
                    .get("terminal")
                    .and_then(|terminal| terminal.get("result"))
                    .and_then(Value::as_str)
                    == Some("partial")
                && matches!(
                    previous_checkpoint
                        .get("terminal")
                        .and_then(|terminal| terminal.get("reason"))
                        .and_then(Value::as_str),
                    Some(
                        "rounds_exhausted"
                            | "calls_exhausted"
                            | "wall_exhausted"
                            | "tokens_exhausted"
                    )
                );
            if existing_phase == "terminal" && !continuation_claim {
                return Err(Error("终态 Agent run 不接受后续事件".into()));
            }
            if input.updated_at < updated_at {
                return Err(Error("Agent run 更新时间不能倒退".into()));
            }
            last_sequence
        }
        None => {
            if input.expected_last_sequence.is_some() {
                return Err(Error("续跑认领引用了不存在的 Agent run".into()));
            }
            tx.execute(
                "INSERT INTO agent_runs (
                   id, turn_id, schema_version, phase, started_at, updated_at, finished_at,
                   last_sequence, checkpoint
                 ) VALUES (?1,?2,?3,?4,?5,?6,?7,0,?8)",
                params![
                    input.run_id,
                    input.turn_id,
                    input.schema_version,
                    phase,
                    input.started_at,
                    input.updated_at,
                    input.finished_at,
                    serde_json::to_string(&input.checkpoint)?,
                ],
            )?;
            0
        }
    };
    maybe_inject_agent_crash(crash, AgentAppendCrashPoint::RunEnsured)?;

    let sequence = last_sequence + 1;
    tx.execute(
        "INSERT INTO agent_events (
           id, run_id, sequence, schema_version, event_type, occurred_at, message
         ) VALUES (?1,?2,?3,?4,?5,?6,?7)",
        params![
            input.event.id,
            input.run_id,
            sequence,
            input.event.schema_version,
            event_type,
            input.event.occurred_at,
            serde_json::to_string(&input.event.message)?,
        ],
    )?;
    maybe_inject_agent_crash(crash, AgentAppendCrashPoint::EventInserted)?;

    let changed = tx.execute(
        "UPDATE agent_runs SET
           phase = ?2, updated_at = ?3, finished_at = ?4, last_sequence = ?5, checkpoint = ?6
         WHERE id = ?1 AND last_sequence = ?7",
        params![
            input.run_id,
            phase,
            input.updated_at,
            input.finished_at,
            sequence,
            serde_json::to_string(&input.checkpoint)?,
            last_sequence,
        ],
    )?;
    if changed != 1 {
        return Err(Error("Agent run 游标发生并发变化".into()));
    }
    maybe_inject_agent_crash(crash, AgentAppendCrashPoint::RunStateChanged)?;

    tx.commit()?;
    Ok(AgentEventRecord {
        id: input.event.id.clone(),
        run_id: input.run_id.clone(),
        sequence,
        schema_version: input.event.schema_version,
        event_type,
        occurred_at: input.event.occurred_at,
        message: input.event.message.clone(),
    })
}

/// 追加一个完整步骤，并在同一事务内推进恢复游标。事件表没有 upsert/update 路径。
pub fn append_agent_step(
    conn: &mut Connection,
    input: &AppendAgentStepInput,
) -> Result<AgentEventRecord> {
    append_agent_step_inner(conn, input, None)
}

fn write_workspace(tx: &Transaction, upsert: &WorkspaceUpsert) -> Result<()> {
    // 顺序是父 → 子。Dexie 侧刻意把 turns 写在 cards 之前（那边没有外键），
    // 照搬过来会让新卡片的第一条轮次直接 FOREIGN KEY constraint failed。
    for project in &upsert.projects.upserts {
        tx.execute(
            "INSERT INTO projects (id, name, pinned, updated_at) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(id) DO UPDATE SET name = excluded.name, pinned = excluded.pinned,
                                           updated_at = excluded.updated_at",
            params![
                project.id,
                project.name,
                project.pinned as i64,
                project.updated_at
            ],
        )?;
    }
    for card in &upsert.cards.upserts {
        tx.execute(
            "INSERT INTO cards (id, project_id, title, favorite, unread, answer_mode, trashed,
                                origin, proposal_id, created_at, concepts, concept_preview_cache)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)
             ON CONFLICT(id) DO UPDATE SET
               project_id = excluded.project_id, title = excluded.title,
               favorite = excluded.favorite, unread = excluded.unread,
               answer_mode = excluded.answer_mode, trashed = excluded.trashed,
               origin = excluded.origin, proposal_id = excluded.proposal_id,
               created_at = excluded.created_at, concepts = excluded.concepts,
               concept_preview_cache = excluded.concept_preview_cache",
            params![
                card.id,
                card.project_id,
                card.title,
                card.favorite as i64,
                card.unread as i64,
                card.answer_mode,
                card.trashed.map(|v| v as i64),
                card.origin,
                card.proposal_id,
                card.created_at,
                serde_json::to_string(&card.concepts)?,
                card.concept_preview_cache
                    .as_ref()
                    .map(serde_json::to_string)
                    .transpose()?,
            ],
        )?;
    }
    for record in &upsert.turns.upserts {
        let turn = &record.turn;
        // card_id 也在 DO UPDATE 里：改道会把一条轮次挂到另一张卡片下。
        tx.execute(
            "INSERT INTO turns (id, card_id, role, content, created_at, streaming, status,
                                error, model, favorite, agent_run, citations, agent_phase)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)
             ON CONFLICT(id) DO UPDATE SET
               card_id = excluded.card_id, role = excluded.role, content = excluded.content,
               created_at = excluded.created_at, streaming = excluded.streaming,
               status = excluded.status, error = excluded.error, model = excluded.model,
               favorite = excluded.favorite, agent_run = excluded.agent_run,
               citations = excluded.citations, agent_phase = excluded.agent_phase",
            params![
                turn.id,
                record.card_id,
                turn.role,
                turn.content,
                turn.created_at,
                turn.streaming.map(|v| v as i64),
                turn.status,
                turn.error,
                turn.model,
                turn.favorite.map(|v| v as i64),
                turn.agent_run
                    .as_ref()
                    .map(serde_json::to_string)
                    .transpose()?,
                turn.citations
                    .as_ref()
                    .map(serde_json::to_string)
                    .transpose()?,
                turn.agent_phase,
            ],
        )?;
    }
    for edge in &upsert.edges.upserts {
        tx.execute(
            "INSERT INTO edges (id, type, source_card_id, target_card_id, source_turn_id,
                                source_text, source_block_text, source_anchor_id,
                                context_snapshot_id, context_cutoff_turn_id, context_policy)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)
             ON CONFLICT(id) DO UPDATE SET
               type = excluded.type, source_card_id = excluded.source_card_id,
               target_card_id = excluded.target_card_id, source_turn_id = excluded.source_turn_id,
               source_text = excluded.source_text, source_block_text = excluded.source_block_text,
               source_anchor_id = excluded.source_anchor_id,
               context_snapshot_id = excluded.context_snapshot_id,
               context_cutoff_turn_id = excluded.context_cutoff_turn_id,
               context_policy = excluded.context_policy",
            params![
                edge.id,
                edge.kind,
                edge.source_card_id,
                edge.target_card_id,
                edge.source_turn_id,
                edge.source_text,
                edge.source_block_text,
                edge.source_anchor_id,
                edge.context_snapshot_id,
                edge.context_cutoff_turn_id,
                edge.context_policy,
            ],
        )?;
    }
    for anchor in &upsert.anchors.upserts {
        tx.execute(
            "INSERT INTO anchors (id, card_id, turn_id, text, block_text, exact, prefix, suffix,
                                  source_revision)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)
             ON CONFLICT(id) DO UPDATE SET
               card_id = excluded.card_id, turn_id = excluded.turn_id, text = excluded.text,
               block_text = excluded.block_text, exact = excluded.exact,
               prefix = excluded.prefix, suffix = excluded.suffix,
               source_revision = excluded.source_revision",
            params![
                str_field(anchor, "id"),
                str_field(anchor, "cardId"),
                str_field(anchor, "turnId"),
                str_field(anchor, "text"),
                str_field(anchor, "blockText"),
                str_field(anchor, "exact"),
                str_field(anchor, "prefix"),
                str_field(anchor, "suffix"),
                str_field(anchor, "sourceRevision"),
            ],
        )?;
    }
    for snapshot in &upsert.snapshots.upserts {
        tx.execute(
            "INSERT INTO snapshots (id, edge_id, created_at, source_title, source_text,
                                    source_block_text, source_turns)
             VALUES (?1,?2,?3,?4,?5,?6,?7)
             ON CONFLICT(id) DO UPDATE SET
               edge_id = excluded.edge_id, created_at = excluded.created_at,
               source_title = excluded.source_title, source_text = excluded.source_text,
               source_block_text = excluded.source_block_text,
               source_turns = excluded.source_turns",
            params![
                str_field(snapshot, "id"),
                str_field(snapshot, "edgeId"),
                snapshot.get("createdAt").and_then(Value::as_i64),
                str_field(snapshot, "sourceTitle"),
                str_field(snapshot, "sourceText"),
                str_field(snapshot, "sourceBlockText"),
                snapshot
                    .get("sourceTurns")
                    .map(serde_json::to_string)
                    .transpose()?,
            ],
        )?;
    }
    for reference in &upsert.references.upserts {
        tx.execute(
            "INSERT INTO refs (id, project_id, source_title, excerpt, anchor)
             VALUES (?1,?2,?3,?4,?5)
             ON CONFLICT(id) DO UPDATE SET
               project_id = excluded.project_id, source_title = excluded.source_title,
               excerpt = excluded.excerpt, anchor = excluded.anchor",
            params![
                str_field(reference, "id"),
                str_field(reference, "projectId"),
                str_field(reference, "sourceTitle"),
                str_field(reference, "excerpt"),
                serde_json::to_string(reference.get("anchor").unwrap_or(&Value::Null))?,
            ],
        )?;
    }
    if let Some(view) = &upsert.view {
        tx.execute(
            "INSERT INTO view (id, doc) VALUES ('main', ?1)
             ON CONFLICT(id) DO UPDATE SET doc = excluded.doc",
            params![serde_json::to_string(view)?],
        )?;
    }
    if let Some(settings) = &upsert.settings {
        tx.execute(
            "INSERT INTO settings (id, doc) VALUES ('app', ?1)
             ON CONFLICT(id) DO UPDATE SET doc = excluded.doc",
            params![serde_json::to_string(settings)?],
        )?;
    }
    Ok(())
}

fn write_docs(tx: &Transaction, table: &str, extra: &str, rows: &[Value]) -> Result<()> {
    for row in rows {
        tx.execute(
            &format!(
                "INSERT INTO {table} (id, project_id, {extra}, doc) VALUES (?1,?2,?3,?4)
                 ON CONFLICT(id) DO UPDATE SET project_id = excluded.project_id,
                   {extra} = excluded.{extra}, doc = excluded.doc"
            ),
            params![
                str_field(row, "id"),
                str_field(row, "projectId"),
                row.get(if extra == "started_at" {
                    "startedAt"
                } else {
                    "createdAt"
                })
                .and_then(Value::as_i64),
                serde_json::to_string(row)?,
            ],
        )?;
    }
    Ok(())
}

fn write_attention(tx: &Transaction, upsert: &AttentionUpsert) -> Result<()> {
    write_docs(
        tx,
        "interaction_events",
        "created_at",
        &upsert.events.upserts,
    )?;
    write_docs(
        tx,
        "session_boundaries",
        "started_at",
        &upsert.sessions.upserts,
    )?;
    write_docs(tx, "proposals", "created_at", &upsert.proposals.upserts)?;
    Ok(())
}

/// 日常自动保存。只增不删——删除必须走下面的显式意图 API。
pub fn apply_changes(conn: &mut Connection, upsert: &WorkspaceUpsert) -> Result<()> {
    let tx = conn.transaction()?;
    // 兜底：万一将来有人把顺序写错，让它在 COMMIT 时炸出来而不是悄悄损坏。
    tx.execute_batch("PRAGMA defer_foreign_keys = ON")?;
    write_workspace(&tx, upsert)?;
    tx.commit()?;
    Ok(())
}

pub fn apply_attention_changes(conn: &mut Connection, upsert: &AttentionUpsert) -> Result<()> {
    let tx = conn.transaction()?;
    write_attention(&tx, upsert)?;
    tx.commit()?;
    Ok(())
}

/// upsert-only。绝不清空会话与提案：那会让关闭一个窗口就销毁另一处产生的提案。
pub fn put_attention_state(conn: &mut Connection, snapshot: &AttentionSnapshot) -> Result<()> {
    apply_attention_changes(
        conn,
        &AttentionUpsert {
            events: TableUpsert {
                upserts: snapshot.events.clone(),
            },
            sessions: TableUpsert {
                upserts: snapshot.sessions.clone(),
            },
            proposals: TableUpsert {
                upserts: snapshot.proposals.clone(),
            },
        },
    )
}

// ---------------------------------------------------------------------------
// 删除：显式意图，或事务内针对数据库求值的谓词
// ---------------------------------------------------------------------------

fn delete_by_ids(tx: &Transaction, table: &str, ids: &[String]) -> Result<()> {
    if ids.is_empty() {
        return Ok(());
    }
    let placeholders = std::iter::repeat("?")
        .take(ids.len())
        .collect::<Vec<_>>()
        .join(",");
    tx.execute(
        &format!("DELETE FROM {table} WHERE id IN ({placeholders})"),
        params_from_iter(ids.iter()),
    )?;
    Ok(())
}

/// 删除项目是明确意图：在事务内按 project_id 重新查库定位从属行，不依赖调用方的
/// 内存基线。返回被删掉的行，供撤销精确还原。
///
/// 外键上都挂了 ON DELETE CASCADE，所以删 projects 一句就够；这里仍然先把行读出来，
/// 因为撤销要还原的是「删除前库里的内容」。
pub fn delete_project_cascade(conn: &mut Connection, project_id: &str) -> Result<RemovedProject> {
    let tx = conn.transaction()?;

    let mut project_stmt =
        tx.prepare("SELECT id, name, pinned, updated_at FROM projects WHERE id = ?1")?;
    let projects: Vec<Project> = project_stmt
        .query_map(params![project_id], |row| {
            Ok(Project {
                id: row.get(0)?,
                name: row.get(1)?,
                pinned: row.get::<_, i64>(2)? != 0,
                updated_at: row.get(3)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(project_stmt);

    let mut card_stmt = tx.prepare("SELECT id FROM cards WHERE project_id = ?1")?;
    let card_ids: Vec<String> = card_stmt
        .query_map(params![project_id], |row| row.get(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(card_stmt);

    // 读回整行是为了撤销；这里复用全表读再按 id 过滤，规模是单机知识库量级。
    let card_set: std::collections::HashSet<&String> = card_ids.iter().collect();
    let cards: Vec<CardRecord> = read_card_records(&tx)?
        .into_iter()
        .filter(|card| card_set.contains(&card.id))
        .collect();
    let turns: Vec<TurnRecord> = read_turns(&tx)?
        .into_iter()
        .filter(|turn| card_set.contains(&turn.card_id))
        .collect();
    let edges: Vec<CardEdge> = read_edges(&tx)?
        .into_iter()
        .filter(|edge| {
            card_set.contains(&edge.source_card_id) || card_set.contains(&edge.target_card_id)
        })
        .collect();
    let edge_ids: std::collections::HashSet<&String> = edges.iter().map(|e| &e.id).collect();
    let anchors: Vec<Value> = read_anchors(&tx)?
        .into_iter()
        .filter(|a| str_field(a, "cardId").is_some_and(|id| card_set.contains(&id)))
        .collect();
    let snapshots: Vec<Value> = read_snapshots(&tx)?
        .into_iter()
        .filter(|s| str_field(s, "edgeId").is_some_and(|id| edge_ids.contains(&id)))
        .collect();
    let references: Vec<Value> = read_references(&tx)?
        .into_iter()
        .filter(|r| str_field(r, "projectId").as_deref() == Some(project_id))
        .collect();

    let attention = AttentionSnapshot {
        events: read_docs(&tx, "interaction_events", "created_at")?
            .into_iter()
            .filter(|v| str_field(v, "projectId").as_deref() == Some(project_id))
            .collect(),
        sessions: read_docs(&tx, "session_boundaries", "started_at")?
            .into_iter()
            .filter(|v| str_field(v, "projectId").as_deref() == Some(project_id))
            .collect(),
        proposals: read_docs(&tx, "proposals", "created_at")?
            .into_iter()
            .filter(|v| str_field(v, "projectId").as_deref() == Some(project_id))
            .collect(),
    };

    // 业务表靠 ON DELETE CASCADE；注意力三表没有外键（project_id 只是普通列），
    // 所以显式删。
    tx.execute("DELETE FROM projects WHERE id = ?1", params![project_id])?;
    for table in ["interaction_events", "session_boundaries", "proposals"] {
        tx.execute(
            &format!("DELETE FROM {table} WHERE project_id = ?1"),
            params![project_id],
        )?;
    }
    tx.commit()?;

    Ok(RemovedProject {
        workspace: WorkspaceUpsert {
            projects: TableUpsert { upserts: projects },
            cards: TableUpsert { upserts: cards },
            turns: TableUpsert { upserts: turns },
            edges: TableUpsert { upserts: edges },
            anchors: TableUpsert { upserts: anchors },
            snapshots: TableUpsert { upserts: snapshots },
            references: TableUpsert {
                upserts: references,
            },
            view: None,
            settings: None,
        },
        attention: AttentionUpsert {
            events: TableUpsert {
                upserts: attention.events,
            },
            sessions: TableUpsert {
                upserts: attention.sessions,
            },
            proposals: TableUpsert {
                upserts: attention.proposals,
            },
        },
    })
}

pub fn delete_references(conn: &mut Connection, ids: &[String]) -> Result<()> {
    let tx = conn.transaction()?;
    delete_by_ids(&tx, "refs", ids)?;
    tx.commit()?;
    Ok(())
}

pub fn delete_proposals(conn: &mut Connection, ids: &[String]) -> Result<()> {
    let tx = conn.transaction()?;
    delete_by_ids(&tx, "proposals", ids)?;
    tx.commit()?;
    Ok(())
}

// ---------------------------------------------------------------------------
// 全量场景
// ---------------------------------------------------------------------------

/// 把整个工作区快照写进库。`cards` 里带 turns，要拆成两张表。
pub fn write_snapshot(
    conn: &mut Connection,
    workspace: &WorkspaceSnapshot,
    attention: &AttentionSnapshot,
) -> Result<()> {
    let mut cards = Vec::new();
    let mut turns = Vec::new();
    for value in &workspace.cards {
        let card_id = str_field(value, "id").ok_or_else(|| Error("卡片缺少 id".into()))?;
        if let Some(list) = value.get("turns").and_then(Value::as_array) {
            for turn in list {
                turns.push(TurnRecord {
                    turn: serde_json::from_value(turn.clone())?,
                    card_id: card_id.clone(),
                });
            }
        }
        let mut stripped = value.clone();
        stripped
            .as_object_mut()
            .expect("card is an object")
            .remove("turns");
        cards.push(serde_json::from_value::<CardRecord>(stripped)?);
    }

    let upsert = WorkspaceUpsert {
        projects: TableUpsert {
            upserts: workspace.projects.clone(),
        },
        cards: TableUpsert { upserts: cards },
        turns: TableUpsert { upserts: turns },
        edges: TableUpsert {
            upserts: workspace.edges.clone(),
        },
        anchors: TableUpsert {
            upserts: workspace.anchors.clone(),
        },
        snapshots: TableUpsert {
            upserts: workspace.snapshots.clone(),
        },
        references: TableUpsert {
            upserts: workspace.references.clone(),
        },
        view: Some(workspace.view.clone()),
        settings: Some(workspace.settings.clone()),
    };
    apply_changes(conn, &upsert)?;
    put_attention_state(conn, attention)?;
    Ok(())
}

/// Replaces only the ordinary workspace snapshot.  Attention observations are
/// intentionally outside that snapshot and remain append-only until an
/// explicit project deletion, proposal purge, import, or clear-local-data
/// action removes them.
pub fn replace_workspace_snapshot(
    conn: &mut Connection,
    workspace: &WorkspaceSnapshot,
) -> Result<()> {
    clear_workspace_records(conn)?;
    write_snapshot(conn, workspace, &AttentionSnapshot::default())
}

pub fn is_empty(conn: &Connection) -> Result<bool> {
    let count: i64 = conn.query_row("SELECT COUNT(*) FROM projects", [], |row| row.get(0))?;
    Ok(count == 0)
}

/// 清空普通工作区表，但保留注意力实验和独立的只读资料库。
///
/// `save_workspace` 是一个全量工作区替换 API，不是「清空整个应用」：如果它顺手
/// 清掉 append-only 的 InteractionEvent / SessionBoundary / Proposal，普通快照保存
/// 就会悄悄抹掉注意力观察状态。需要清注意力的调用必须显式走下方
/// `clear_workspace_data()`。
pub fn clear_workspace_records(conn: &mut Connection) -> Result<()> {
    let tx = conn.transaction()?;
    for table in [
        "turns",
        "snapshots",
        "anchors",
        "edges",
        "refs",
        "cards",
        "projects",
        "view",
        "settings",
    ] {
        tx.execute(&format!("DELETE FROM {table}"), [])?;
    }
    tx.commit()?;
    Ok(())
}

/// 清空工作区**及其注意力观察表**，但保留独立的只读资料库。用于整库工作区迁移、
/// 首次导入；资料库不是项目快照的一部分，不能因导入一个项目包而被静默抹掉。
pub fn clear_workspace_data(conn: &mut Connection) -> Result<()> {
    clear_workspace_records(conn)?;
    let tx = conn.transaction()?;
    for table in ["interaction_events", "session_boundaries", "proposals"] {
        tx.execute(&format!("DELETE FROM {table}"), [])?;
    }
    tx.commit()?;
    Ok(())
}

/// 设置页的“清除本地数据”走这个完整版本：工作区、注意力实验、Vault 索引和资料
/// 库都清空。FTS 虚表没有外键，必须显式清掉。
pub fn clear_all(conn: &mut Connection) -> Result<()> {
    clear_workspace_data(conn)?;
    let tx = conn.transaction()?;
    for table in [
        "agent_events",
        "agent_runs",
        "project_note_libraries",
        "note_chunks",
        "note_documents",
        "note_libraries",
        "vault_index",
        "sync_state",
    ] {
        tx.execute(&format!("DELETE FROM {table}"), [])?;
    }
    tx.execute("DELETE FROM note_chunks_fts", [])?;
    tx.execute("DELETE FROM attachment_chunks_fts", [])?;
    tx.commit()?;
    Ok(())
}

// ---------------------------------------------------------------------------
// vault 同步状态
// ---------------------------------------------------------------------------

/// 某张卡片上次被写进 vault 时的归一化哈希；`None` 表示从没写过。
pub fn sync_hash(conn: &Connection, card_id: &str) -> Result<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT last_written_hash FROM sync_state WHERE card_id = ?1 AND status = 'synced'",
            params![card_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten())
}

/// 上次写出去的路径与状态。冲突挂起 / 已脱钩的卡片也要能查到，所以不过滤 status。
pub fn sync_record(conn: &Connection, card_id: &str) -> Result<Option<(String, String)>> {
    Ok(conn
        .query_row(
            "SELECT vault_path, status FROM sync_state WHERE card_id = ?1",
            params![card_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?)
}

/// 取消跟踪：把 sync_state 的行删掉。文件由调用方按记录下来的路径删除。
pub fn forget_sync(conn: &Connection, card_id: &str) -> Result<()> {
    conn.execute(
        "DELETE FROM sync_state WHERE card_id = ?1",
        params![card_id],
    )?;
    Ok(())
}

pub fn put_sync_state(
    conn: &Connection,
    card_id: &str,
    vault_path: &str,
    hash: Option<&str>,
    at: i64,
    status: &str,
) -> Result<()> {
    conn.execute(
        "INSERT INTO sync_state (card_id, vault_path, last_written_hash, last_written_at, status)
         VALUES (?1,?2,?3,?4,?5)
         ON CONFLICT(card_id) DO UPDATE SET vault_path = excluded.vault_path,
           last_written_hash = COALESCE(excluded.last_written_hash, sync_state.last_written_hash),
           last_written_at = excluded.last_written_at, status = excluded.status",
        params![card_id, vault_path, hash, at, status],
    )?;
    Ok(())
}

/// 处于冲突挂起状态的卡片，用于 UI 上的常驻横幅。
pub fn conflicted(conn: &Connection) -> Result<Vec<(String, String)>> {
    let mut stmt =
        conn.prepare("SELECT card_id, vault_path FROM sync_state WHERE status = 'conflict'")?;
    let rows = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// 用户选择「以 Papertable 为准」后清除挂起，下次同步会正常覆盖。
/// 用户对冲突的裁决。**唯一的分发点**：按钮 → 意图字符串 → 这里，一次映射。
///
/// 之前是三层成对结构（两个按钮 → store 两个分支 → bridge 两个方法 → 两个命令 →
/// 两个 db 函数），任何一层接反都表现为「按钮效果对调」，而且没有一处能证明自己。
/// 真机验收出现过「点了以 Papertable 为准、库里却是 detached」的现场——四层逐一
/// 核对都没找到接反的证据。塌成一处映射并把落库后的真实状态**返回给 UI 展示**，
/// 这类事故要么不再发生，要么一发生就自己现形。
///
/// - "papertable" → 'force'：下一次同步无条件覆盖。**不能表达成清空基线**——那正好
///   落进「无基线 + 文件已存在 → 隔离」的防接管规则，按钮就成了空操作。
/// - "note" → 'detached'：立墓碑，此后不再同步。
pub fn resolve_conflict(conn: &Connection, card_id: &str, keep: &str) -> Result<&'static str> {
    let status = match keep {
        "papertable" => "force",
        "note" => "detached",
        other => return Err(Error(format!("未知的冲突处理方式：{other}"))),
    };
    conn.execute(
        "UPDATE sync_state SET status = ?2 WHERE card_id = ?1",
        params![card_id, status],
    )?;
    Ok(status)
}

// ---------------------------------------------------------------------------
// vault 索引（入向）
// ---------------------------------------------------------------------------

/// 索引里记的归一化哈希，用于识别「这个事件是我们自己写入的回声」。
pub fn indexed_hash(conn: &Connection, path: &str) -> Result<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT hash FROM vault_index WHERE path = ?1",
            params![path],
            |row| row.get::<_, String>(0),
        )
        .optional()?)
}

pub fn put_indexed(
    conn: &Connection,
    path: &str,
    name: &str,
    note_id: Option<&str>,
    hash: &str,
    at: i64,
) -> Result<()> {
    conn.execute(
        "INSERT INTO vault_index (path, name, note_id, hash, updated_at)
         VALUES (?1,?2,?3,?4,?5)
         ON CONFLICT(path) DO UPDATE SET name = excluded.name, note_id = excluded.note_id,
           hash = excluded.hash, updated_at = excluded.updated_at",
        params![path, name, note_id, hash, at],
    )?;
    Ok(())
}

pub fn drop_indexed(conn: &Connection, path: &str) -> Result<()> {
    conn.execute("DELETE FROM vault_index WHERE path = ?1", params![path])?;
    Ok(())
}

/// 全量重扫时用：把不在磁盘上的条目清掉。
pub fn retain_indexed(conn: &Connection, alive: &[String]) -> Result<()> {
    if alive.is_empty() {
        conn.execute("DELETE FROM vault_index", [])?;
        return Ok(());
    }
    let placeholders = std::iter::repeat("?")
        .take(alive.len())
        .collect::<Vec<_>>()
        .join(",");
    conn.execute(
        &format!("DELETE FROM vault_index WHERE path NOT IN ({placeholders})"),
        params_from_iter(alive.iter()),
    )?;
    Ok(())
}

/// 按 `[[双链]]` 里的名字解析。同名多篇时返回全部，由调用方决定怎么处理。
pub fn resolve_link(conn: &Connection, name: &str) -> Result<Vec<(String, Option<String>)>> {
    let mut stmt =
        conn.prepare("SELECT path, note_id FROM vault_index WHERE name = ?1 ORDER BY path")?;
    let rows = stmt.query_map(params![name], |row| Ok((row.get(0)?, row.get(1)?)))?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn indexed_count(conn: &Connection) -> Result<i64> {
    Ok(conn.query_row("SELECT COUNT(*) FROM vault_index", [], |row| row.get(0))?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn project(id: &str) -> Project {
        Project {
            id: id.into(),
            name: format!("项目 {id}"),
            pinned: false,
            updated_at: 1,
        }
    }

    fn card(id: &str, project_id: &str) -> CardRecord {
        CardRecord {
            id: id.into(),
            project_id: project_id.into(),
            title: format!("卡片 {id}"),
            favorite: false,
            unread: false,
            answer_mode: None,
            concepts: vec![],
            concept_preview_cache: None,
            trashed: None,
            origin: None,
            proposal_id: None,
            created_at: 1,
        }
    }

    fn turn(id: &str, card_id: &str) -> TurnRecord {
        TurnRecord {
            card_id: card_id.into(),
            turn: Turn {
                id: id.into(),
                role: "user".into(),
                content: "内容".into(),
                created_at: 1,
                streaming: None,
                status: None,
                error: None,
                model: None,
                favorite: None,
                agent_run: None,
                citations: None,
                agent_phase: None,
            },
        }
    }

    fn singletons(upsert: &mut WorkspaceUpsert) {
        upsert.view = Some(
            json!({"id":"main","activeProjectId":"p","currentCardId":"c",
            "drafts":{},"lastCardByProject":{},"collapsed":[],"scrollPositions":{}}),
        );
        upsert.settings = Some(json!({"id":"app","model":"claude-opus-5"}));
    }

    fn seeded() -> Connection {
        let mut conn = open_in_memory().unwrap();
        let mut upsert = WorkspaceUpsert::default();
        upsert.projects.upserts = vec![project("p")];
        upsert.cards.upserts = vec![card("c", "p"), card("c2", "p")];
        upsert.turns.upserts = vec![turn("t", "c"), turn("t2", "c2")];
        singletons(&mut upsert);
        apply_changes(&mut conn, &upsert).unwrap();
        conn
    }

    fn seed_agent_turn(conn: &mut Connection) {
        let mut upsert = WorkspaceUpsert::default();
        upsert.projects.upserts = vec![project("p")];
        upsert.cards.upserts = vec![card("c", "p")];
        upsert.turns.upserts = vec![TurnRecord {
            card_id: "c".into(),
            turn: Turn {
                id: "agent-turn".into(),
                role: "ai".into(),
                content: "".into(),
                created_at: 100,
                streaming: Some(true),
                status: Some("streaming".into()),
                error: None,
                model: Some("test-model".into()),
                favorite: None,
                agent_run: Some(json!({"mode":"two-stage","searchQueries":[]})),
                citations: None,
                agent_phase: Some("searching".into()),
            },
        }];
        singletons(&mut upsert);
        apply_changes(conn, &upsert).unwrap();
    }

    fn agent_step(kind: &str, index: usize) -> AppendAgentStepInput {
        let phase = match kind {
            "exploration-started" => "exploring",
            "search-requested" | "search-completed" => "searching",
            "read-requested" | "read-completed" => "reading",
            "duplicate-call-detected" | "protocol-repaired" => "repairing",
            "retry" | "budget-added" => "retrying",
            "final-synthesis" => "synthesizing",
            "terminal" => "terminal",
            _ => panic!("unknown test event"),
        };
        let at = 101 + index as i64;
        let budget = json!({
            "schemaVersion": 1,
            "limits": {"rounds":4,"calls":8,"wallMs":120000,"tokens":32000},
            "used": {"rounds":1,"calls":1,"wallMs":25,"tokens":null},
            "remaining": {"rounds":3,"calls":7,"wallMs":119975,"tokens":null},
            "tokenReporting": {
                "state":"unreported","reportedTokens":0,
                "reportedRequests":0,"unreportedRequests":1
            },
            "records": [{"sequence":1,"occurredAt":at,"dimension":"tokens",
                         "amount":null,"source":"provider-unreported","stage":"exploration"}]
        });
        AppendAgentStepInput {
            run_id: "run-1".into(),
            turn_id: "agent-turn".into(),
            schema_version: AGENT_EVENT_SCHEMA_VERSION,
            started_at: 100,
            updated_at: at,
            finished_at: (kind == "terminal").then_some(at),
            expected_last_sequence: None,
            checkpoint: json!({
                "phase": phase,
                "objective": "测试崩溃恢复",
                "executedSearches": [],
                "readChunkIds": [],
                "confirmedCitationChunkIds": [],
                "unresolvedQuestions": [],
                "addedBudget": {},
                "budget": budget,
                "lastCompleteKind": kind,
                "step": index,
            }),
            event: AgentStepEventInput {
                id: format!("event-{index}"),
                schema_version: AGENT_EVENT_SCHEMA_VERSION,
                occurred_at: at,
                message: json!({"kind":kind,"step":index}),
            },
        }
    }

    #[test]
    fn v5_migration_clears_legacy_reasoning() {
        let conn = open_in_memory().unwrap();
        conn.execute("ALTER TABLE turns ADD COLUMN reasoning TEXT", [])
            .unwrap();
        conn.execute(
            "INSERT INTO projects (id, name, pinned, updated_at) VALUES ('p', '项目', 0, 1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO cards (id, project_id, title, favorite, unread, created_at, concepts)
             VALUES ('c', 'p', '卡片', 0, 0, 1, '[]')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO turns (id, card_id, role, content, created_at, reasoning)
             VALUES ('t', 'c', 'ai', '正文', 1, 'internal draft')",
            [],
        )
        .unwrap();
        conn.execute_batch("PRAGMA user_version = 4").unwrap();

        migrate(&conn).unwrap();

        let reasoning: Option<String> = conn
            .query_row("SELECT reasoning FROM turns WHERE id = 't'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(reasoning, None, "旧草稿必须在升级时擦空");
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, USER_VERSION);
    }

    #[test]
    fn v10_migration_adds_harness_transport_allowlist_and_fts_without_rebuilding_turns() {
        let conn = Connection::open_in_memory().unwrap();
        // 模拟真用户 v5 的 turns：表已存在，所以 schema.sql 的 IF NOT EXISTS 不会替
        // 它补列，迁移必须显式 ALTER。
        conn.execute_batch(
            "CREATE TABLE turns (
                id TEXT PRIMARY KEY, card_id TEXT NOT NULL, role TEXT NOT NULL,
                content TEXT NOT NULL, created_at INTEGER NOT NULL, streaming INTEGER,
                status TEXT, error TEXT, model TEXT, favorite INTEGER
             ); PRAGMA user_version = 5;",
        )
        .unwrap();
        migrate(&conn).unwrap();
        assert!(has_column(&conn, "turns", "agent_run").unwrap());
        assert!(has_column(&conn, "turns", "citations").unwrap());
        assert!(has_column(&conn, "turns", "agent_phase").unwrap());
        let fts: String = conn
            .query_row(
                "SELECT sql FROM sqlite_master WHERE name = 'note_chunks_fts'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(fts.contains("fts5"));
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, USER_VERSION);
        let attachment_allowlist: String = conn
            .query_row(
                "SELECT sql FROM sqlite_master
                 WHERE type = 'table' AND name = 'agent_attachment_search_allowlist'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(attachment_allowlist.contains("attachment_chunks"));
        let allowlist: String = conn
            .query_row(
                "SELECT sql FROM sqlite_master
                 WHERE type = 'table' AND name = 'agent_note_search_allowlist'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(allowlist.contains("run_id"));
        assert!(allowlist.contains("chunk_id"));
    }

    #[test]
    fn v10_migration_invalidates_legacy_capability_cache_and_sets_default_ttl() {
        let conn = open_in_memory().unwrap();
        conn.execute(
            "INSERT INTO settings (id, doc) VALUES ('app', ?1)",
            params![json!({
                "id":"app",
                "model":"legacy",
                "providerCapabilities":[{
                    "baseUrl":"https://legacy.example/v1",
                    "model":"legacy",
                    "mode":"two-stage",
                    "streamingToolCalls":false,
                    "toolResultAccepted":false,
                    "testedAt":1
                }]
            })
            .to_string()],
        )
        .unwrap();
        conn.execute_batch("PRAGMA user_version = 9").unwrap();
        migrate(&conn).unwrap();
        let settings = read_singleton(&conn, "settings", "app").unwrap().unwrap();
        assert_eq!(settings["providerCapabilities"], json!([]));
        assert_eq!(
            settings["providerCapabilityTtlMs"],
            json!(24 * 60 * 60 * 1_000_i64)
        );
    }

    #[test]
    fn v7_turns_stay_legacy_readable_without_event_backfill() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("legacy-v7.sqlite3");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE projects (
                   id TEXT PRIMARY KEY, name TEXT NOT NULL, pinned INTEGER NOT NULL, updated_at INTEGER NOT NULL
                 );
                 CREATE TABLE cards (
                   id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL,
                   favorite INTEGER NOT NULL, unread INTEGER NOT NULL, answer_mode TEXT,
                   trashed INTEGER, origin TEXT, proposal_id TEXT, created_at INTEGER NOT NULL,
                   concepts TEXT NOT NULL, concept_preview_cache TEXT
                 );
                 CREATE TABLE turns (
                   id TEXT PRIMARY KEY, card_id TEXT NOT NULL, role TEXT NOT NULL,
                   content TEXT NOT NULL, created_at INTEGER NOT NULL, streaming INTEGER,
                   status TEXT, error TEXT, model TEXT, favorite INTEGER, agent_run TEXT,
                   citations TEXT, agent_phase TEXT
                 );
                 INSERT INTO projects VALUES ('p','旧项目',0,1);
                 INSERT INTO cards VALUES ('c','p','旧卡片',0,0,NULL,NULL,NULL,NULL,1,'[]',NULL);
                 INSERT INTO turns VALUES (
                   'legacy-turn','c','ai','旧回答',2,0,'complete',NULL,'m',NULL,
                   '{\"mode\":\"two-stage\",\"searchQueries\":[\"旧检索\"]}',NULL,NULL
                 );
                 PRAGMA user_version = 7;",
            )
            .unwrap();
            migrate(&conn).unwrap();
        }

        let conn = open(&path).unwrap();
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, USER_VERSION);
        let run_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM agent_runs", [], |row| row.get(0))
            .unwrap();
        let event_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM agent_events", [], |row| row.get(0))
            .unwrap();
        assert_eq!((run_count, event_count), (0, 0), "迁移不得伪造事件");
        assert_eq!(
            load_agent_audit(&conn, "legacy-turn").unwrap(),
            Some(AgentAudit::Legacy {
                turn_id: "legacy-turn".into(),
                trace: Some(json!({"mode":"two-stage","searchQueries":["旧检索"]})),
            })
        );
    }

    #[test]
    fn latest_version_repairs_a_missing_rebuildable_fts_index() {
        let conn = open_in_memory().unwrap();
        conn.execute_batch("DROP TABLE note_chunks_fts; DROP TABLE attachment_chunks_fts")
            .unwrap();
        conn.execute_batch(&format!("PRAGMA user_version = {USER_VERSION}"))
            .unwrap();
        migrate(&conn).unwrap();
        let exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master
                 WHERE name IN ('note_chunks_fts', 'attachment_chunks_fts')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(exists, 2);
    }

    #[test]
    fn turn_trace_and_citations_round_trip_as_json_without_hidden_reasoning() {
        let mut conn = seeded();
        let mut update = WorkspaceUpsert::default();
        update.turns.upserts = vec![TurnRecord {
            card_id: "c".into(),
            turn: Turn {
                id: "t".into(),
                role: "ai".into(),
                content: "有来源的正文".into(),
                created_at: 2,
                streaming: Some(false),
                status: Some("complete".into()),
                error: None,
                model: Some("m".into()),
                favorite: None,
                agent_run: Some(json!({"mode":"two-stage","readChunkIds":["chunk-1"]})),
                citations: Some(json!([{"chunkId":"chunk-1","excerpt":"证据"}])),
                agent_phase: Some("reading".into()),
            },
        }];
        apply_changes(&mut conn, &update).unwrap();
        let turn = read_turns(&conn)
            .unwrap()
            .into_iter()
            .find(|record| record.turn.id == "t")
            .unwrap()
            .turn;
        assert_eq!(turn.agent_run.unwrap()["mode"], "two-stage");
        assert_eq!(turn.citations.unwrap()[0]["chunkId"], "chunk-1");
        assert_eq!(turn.agent_phase.as_deref(), Some("reading"));
    }

    #[test]
    fn every_agent_step_boundary_survives_crash_and_reopen_without_partial_rows() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("agent-crash.sqlite3");
        {
            let mut conn = open(&path).unwrap();
            seed_agent_turn(&mut conn);
        }

        for (index, kind) in AGENT_EVENT_TYPES.iter().enumerate() {
            let input = agent_step(kind, index);
            for crash in [
                AgentAppendCrashPoint::RunEnsured,
                AgentAppendCrashPoint::EventInserted,
                AgentAppendCrashPoint::RunStateChanged,
            ] {
                {
                    let mut conn = open(&path).unwrap();
                    let error = append_agent_step_inner(&mut conn, &input, Some(crash))
                        .expect_err("注入点必须中止事务");
                    assert!(error.to_string().contains("injected crash"));
                    // 模拟进程在错误后消失，不在同一连接上做任何清理或补偿。
                }
                let conn = open(&path).unwrap();
                match load_agent_audit(&conn, "agent-turn").unwrap().unwrap() {
                    AgentAudit::Legacy { .. } => {
                        assert_eq!(index, 0, "只有首步骤提交前可以仍是 legacy")
                    }
                    AgentAudit::EventSourced { run, events } => {
                        assert_eq!(events.len(), index);
                        assert_eq!(run.last_sequence, index as i64);
                        assert_eq!(run.checkpoint["step"], json!(index - 1));
                        assert!(
                            events.iter().all(|event| event.id != input.event.id),
                            "事务中写入的半条事件不得在 reopen 后出现"
                        );
                    }
                }
            }

            {
                let mut conn = open(&path).unwrap();
                let event = append_agent_step(&mut conn, &input).unwrap();
                assert_eq!(event.sequence, index as i64 + 1);
            }
            // 每一个完整步骤后立即丢弃连接并重开，等价验证 kill-after-commit。
            let conn = open(&path).unwrap();
            let AgentAudit::EventSourced { run, events } =
                load_agent_audit(&conn, "agent-turn").unwrap().unwrap()
            else {
                panic!("提交首个事件后必须进入 event-sourced 模式");
            };
            assert_eq!(events.len(), index + 1);
            assert_eq!(run.last_sequence, index as i64 + 1);
            assert_eq!(run.checkpoint["lastCompleteKind"], json!(kind));
            assert_eq!(run.checkpoint["budget"]["remaining"]["calls"], json!(7));
            assert_eq!(events.last().unwrap().event_type, *kind);
            assert_eq!(
                events
                    .iter()
                    .map(|event| event.sequence)
                    .collect::<Vec<_>>(),
                (1..=index as i64 + 1).collect::<Vec<_>>()
            );
        }
    }

    #[test]
    fn agent_events_are_insert_only_and_duplicate_append_is_atomic() {
        let mut conn = seeded();
        // The generic seed uses turn "t"; adapt a valid first step to it.
        let mut first = agent_step("exploration-started", 0);
        first.turn_id = "t".into();
        append_agent_step(&mut conn, &first).unwrap();

        assert!(
            conn.execute(
                "UPDATE agent_events SET event_type = 'retry' WHERE id = ?1",
                params![first.event.id],
            )
            .is_err(),
            "schema trigger must reject mutation of an appended event"
        );

        let mut duplicate = agent_step("search-requested", 1);
        duplicate.turn_id = "t".into();
        duplicate.event.id = first.event.id.clone();
        assert!(append_agent_step(&mut conn, &duplicate).is_err());

        let AgentAudit::EventSourced { run, events } =
            load_agent_audit(&conn, "t").unwrap().unwrap()
        else {
            panic!("first event must remain readable");
        };
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event_type, "exploration-started");
        assert_eq!(run.last_sequence, 1);
        assert_eq!(run.checkpoint["step"], 0);
    }

    fn seed_resumable_run(conn: &mut Connection) -> AppendAgentStepInput {
        let mut start = agent_step("exploration-started", 0);
        start.turn_id = "t".into();
        start.checkpoint["hostScope"] = json!({"projectId":"p","libraryIds":["library-original"]});
        append_agent_step(conn, &start).unwrap();

        let mut terminal = agent_step("terminal", 1);
        terminal.turn_id = "t".into();
        terminal.checkpoint["terminal"] = json!({"result":"partial","reason":"rounds_exhausted"});
        terminal.checkpoint["stopReason"] = json!("rounds_exhausted");
        terminal.checkpoint["hostScope"] =
            json!({"projectId":"p","libraryIds":["library-original"]});
        terminal.event.message = json!({
            "kind":"terminal",
            "terminal":{"result":"partial","reason":"rounds_exhausted"},
            "citations":[],
            "unresolvedQuestions":["预算耗尽"]
        });
        append_agent_step(conn, &terminal).unwrap();

        let mut continuation = agent_step("budget-added", 2);
        continuation.turn_id = "t".into();
        continuation.expected_last_sequence = Some(2);
        continuation.checkpoint["phase"] = json!("exploring");
        continuation.checkpoint["terminal"] = Value::Null;
        continuation.checkpoint["stopReason"] = Value::Null;
        continuation.checkpoint["hostScope"] =
            json!({"projectId":"p","libraryIds":["library-original"]});
        continuation.event.message = json!({
            "kind":"budget-added",
            "added":{"rounds":2,"calls":3},
            "reason":"user-requested same-run continuation"
        });
        continuation
    }

    #[test]
    fn same_run_continuation_has_one_atomic_cursor_winner() {
        let mut conn = seeded();
        let continuation = seed_resumable_run(&mut conn);
        let event = append_agent_step(&mut conn, &continuation).unwrap();
        assert_eq!(event.sequence, 3);
        assert!(
            append_agent_step(&mut conn, &continuation).is_err(),
            "the stale terminal cursor cannot claim the run twice"
        );
        let AgentAudit::EventSourced { run, events } =
            load_agent_audit(&conn, "t").unwrap().unwrap()
        else {
            panic!("run must stay event sourced");
        };
        assert_eq!(run.id, "run-1");
        assert_eq!(run.phase, "exploring");
        assert_eq!(run.finished_at, None);
        assert_eq!(run.last_sequence, 3);
        assert_eq!(events.len(), 3);
        assert_eq!(
            events
                .iter()
                .filter(|event| {
                    event.event_type == "budget-added" && event.message.get("added").is_some()
                })
                .count(),
            1
        );
    }

    #[test]
    fn continuation_claim_crash_reopens_at_the_prior_terminal_checkpoint() {
        for crash in [
            AgentAppendCrashPoint::RunEnsured,
            AgentAppendCrashPoint::EventInserted,
            AgentAppendCrashPoint::RunStateChanged,
        ] {
            let directory = tempfile::tempdir().unwrap();
            let path = directory.path().join("resume-claim.sqlite3");
            let continuation = {
                let mut conn = open(&path).unwrap();
                let mut seed = WorkspaceUpsert::default();
                seed.projects.upserts = vec![project("p")];
                seed.cards.upserts = vec![card("c", "p")];
                seed.turns.upserts = vec![TurnRecord {
                    card_id: "c".into(),
                    turn: Turn {
                        id: "t".into(),
                        role: "user".into(),
                        content: "问题".into(),
                        created_at: 1,
                        streaming: None,
                        status: Some("complete".into()),
                        error: None,
                        model: None,
                        favorite: None,
                        agent_run: None,
                        citations: None,
                        agent_phase: None,
                    },
                }];
                singletons(&mut seed);
                apply_changes(&mut conn, &seed).unwrap();
                seed_resumable_run(&mut conn)
            };
            {
                let mut conn = open(&path).unwrap();
                assert!(append_agent_step_inner(&mut conn, &continuation, Some(crash)).is_err());
            }
            let conn = open(&path).unwrap();
            let AgentAudit::EventSourced { run, events } =
                load_agent_audit(&conn, "t").unwrap().unwrap()
            else {
                panic!("terminal run must survive");
            };
            assert_eq!(run.phase, "terminal");
            assert_eq!(
                run.checkpoint["terminal"],
                json!({"result":"partial","reason":"rounds_exhausted"})
            );
            assert_eq!(events.len(), 2);
        }
    }

    #[test]
    fn ordinary_workspace_snapshot_replacement_preserves_agent_audit_history() {
        let mut conn = seeded();
        let mut first = agent_step("exploration-started", 0);
        first.turn_id = "t".into();
        append_agent_step(&mut conn, &first).unwrap();

        let replacement = load_workspace(&conn).unwrap().unwrap();
        replace_workspace_snapshot(&mut conn, &replacement).unwrap();

        let AgentAudit::EventSourced { run, events } =
            load_agent_audit(&conn, "t").unwrap().unwrap()
        else {
            panic!("ordinary workspace snapshots must not erase the audit log");
        };
        assert_eq!(run.last_sequence, 1);
        assert_eq!(events.len(), 1);
    }

    /// 移植过来最容易在第一天炸的地方：Dexie 侧刻意把 turns 写在 cards 之前（那边
    /// 没有外键），照搬到 foreign_keys=ON 的 SQLite 上，新卡片的第一条轮次会直接
    /// FOREIGN KEY constraint failed。
    #[test]
    fn a_new_project_card_and_turn_commit_in_one_transaction() {
        let mut conn = open_in_memory().unwrap();
        let mut upsert = WorkspaceUpsert::default();
        upsert.projects.upserts = vec![project("p")];
        upsert.cards.upserts = vec![card("c", "p")];
        upsert.turns.upserts = vec![turn("t", "c")];
        singletons(&mut upsert);
        apply_changes(&mut conn, &upsert).expect("父→子顺序必须让外键成立");
        assert_eq!(read_turns(&conn).unwrap().len(), 1);
    }

    #[test]
    fn foreign_keys_are_actually_enforced() {
        let mut conn = open_in_memory().unwrap();
        let mut upsert = WorkspaceUpsert::default();
        upsert.turns.upserts = vec![turn("t", "missing-card")];
        assert!(
            apply_changes(&mut conn, &upsert).is_err(),
            "孤儿轮次必须被外键拒绝"
        );
    }

    #[test]
    fn apply_changes_never_deletes_a_row() {
        let mut conn = seeded();
        let mut shrunk = WorkspaceUpsert::default();
        shrunk.cards.upserts = vec![card("c", "p")];
        apply_changes(&mut conn, &shrunk).unwrap();
        assert_eq!(
            read_card_records(&conn).unwrap().len(),
            2,
            "增量保存绝不删行"
        );
    }

    #[test]
    fn cascade_removes_rows_no_caller_snapshot_ever_saw() {
        let mut conn = seeded();
        let mut ghost = WorkspaceUpsert::default();
        ghost.cards.upserts = vec![card("ghost", "p")];
        ghost.turns.upserts = vec![turn("t-ghost", "ghost")];
        apply_changes(&mut conn, &ghost).unwrap();
        let mut other = WorkspaceUpsert::default();
        other.projects.upserts = vec![project("p2")];
        other.cards.upserts = vec![card("c-other", "p2")];
        apply_changes(&mut conn, &other).unwrap();

        let removed = delete_project_cascade(&mut conn, "p").unwrap();

        assert!(read_card_records(&conn)
            .unwrap()
            .iter()
            .all(|c| c.project_id == "p2"));
        assert!(
            read_turns(&conn).unwrap().is_empty(),
            "轮次应随卡片级联删除"
        );
        assert!(
            removed
                .workspace
                .cards
                .upserts
                .iter()
                .any(|c| c.id == "ghost"),
            "返回值要包含库里真正删掉的行，撤销才能还原完整"
        );
    }

    #[test]
    fn undo_restores_what_the_database_held() {
        let mut conn = seeded();
        let mut ghost = WorkspaceUpsert::default();
        ghost.cards.upserts = vec![card("ghost", "p")];
        apply_changes(&mut conn, &ghost).unwrap();

        let removed = delete_project_cascade(&mut conn, "p").unwrap();
        apply_changes(&mut conn, &removed.workspace).unwrap();

        let mut ids: Vec<String> = read_card_records(&conn)
            .unwrap()
            .into_iter()
            .map(|c| c.id)
            .collect();
        ids.sort();
        assert_eq!(ids, vec!["c", "c2", "ghost"]);
    }

    /// 「保留笔记」写下的墓碑必须查得到。之前 sync_hash 只看 status='synced'，
    /// 于是脱钩的卡片基线为空 → 文件已存在 → 又被判冲突，按钮等于没点。
    #[test]
    fn a_detached_card_is_still_visible_to_the_sync_loop() {
        let mut conn = seeded();
        put_sync_state(&conn, "c", "项目/卡片.md", Some("h1"), 1, "synced").unwrap();
        assert_eq!(sync_hash(&conn, "c").unwrap().as_deref(), Some("h1"));

        assert_eq!(resolve_conflict(&conn, "c", "note").unwrap(), "detached");
        // 状态查得到，同步循环据此整张跳过。
        let (path, status) = sync_record(&conn, "c").unwrap().unwrap();
        assert_eq!(status, "detached");
        assert_eq!(path, "项目/卡片.md");
        // 而基线仍然为空——正因如此，只看 sync_hash 的实现会把它误判成新文件。
        assert_eq!(sync_hash(&conn, "c").unwrap(), None);

        forget_sync(&conn, "c").unwrap();
        assert_eq!(sync_record(&conn, "c").unwrap(), None);
        let _ = &mut conn;
    }

    /// 「以 Papertable 为准」要留下一个**可执行的意图**（status='force'），
    /// 而不是把基线抹掉——抹掉基线会让下一次写入按「不接管他人文件」再次隔离。
    #[test]
    fn resolving_a_conflict_marks_it_for_a_forced_overwrite() {
        let conn = seeded();
        put_sync_state(&conn, "c", "项目/卡片.md", Some("h1"), 1, "conflict").unwrap();
        assert_eq!(conflicted(&conn).unwrap().len(), 1);

        assert_eq!(
            resolve_conflict(&conn, "c", "papertable").unwrap(),
            "force",
            "返回值要如实反映落库状态，UI 靠它显示结果"
        );
        assert!(resolve_conflict(&conn, "c", "别的").is_err());
        assert!(conflicted(&conn).unwrap().is_empty(), "横幅上不该再列它");
        let (_, status) = sync_record(&conn, "c").unwrap().unwrap();
        assert_eq!(status, "force", "同步循环要能看出这是一次强制覆盖");
        // 基线仍然保留，强制覆盖不依赖它，但也不该被无意义地丢掉。
        assert_eq!(
            sync_hash(&conn, "c").unwrap(),
            None,
            "force 态不参与常规基线"
        );
    }

    #[test]
    fn put_attention_state_is_upsert_only() {
        let mut conn = open_in_memory().unwrap();
        put_attention_state(
            &mut conn,
            &AttentionSnapshot {
                events: vec![],
                sessions: vec![json!({"id":"s1","projectId":"p","startedAt":1})],
                proposals: vec![
                    json!({"id":"pr1","projectId":"p","createdAt":1}),
                    json!({"id":"pr2","projectId":"p","createdAt":2}),
                ],
            },
        )
        .unwrap();
        put_attention_state(
            &mut conn,
            &AttentionSnapshot {
                events: vec![],
                sessions: vec![],
                proposals: vec![json!({"id":"pr1","projectId":"p","createdAt":1})],
            },
        )
        .unwrap();
        assert_eq!(
            load_attention(&conn).unwrap().proposals.len(),
            2,
            "写回一份较少的状态不得销毁另一处生成的提案"
        );
    }

    #[test]
    fn replacing_workspace_snapshot_preserves_append_only_attention_rows() {
        let mut conn = seeded();
        put_attention_state(
            &mut conn,
            &AttentionSnapshot {
                events: vec![json!({
                    "id":"event-1", "projectId":"p", "createdAt":10,
                    "type":"title-edited"
                })],
                sessions: vec![json!({
                    "id":"session-1", "projectId":"p", "startedAt":1,
                    "lastActiveAt":10
                })],
                proposals: vec![json!({
                    "id":"proposal-1", "projectId":"p", "createdAt":10,
                    "title":"保留这条提案"
                })],
            },
        )
        .unwrap();

        let mut replacement = load_workspace(&conn).unwrap().unwrap();
        replacement.projects[0].name = "普通工作区快照更新".into();
        replace_workspace_snapshot(&mut conn, &replacement).unwrap();

        let attention = load_attention(&conn).unwrap();
        assert_eq!(attention.events.len(), 1);
        assert_eq!(attention.sessions.len(), 1);
        assert_eq!(attention.proposals.len(), 1);
        assert_eq!(
            load_workspace(&conn).unwrap().unwrap().projects[0].name,
            "普通工作区快照更新"
        );
    }

    /// S2 的验收信号：导入后重新读出来必须与导入内容逐表相等。
    #[test]
    fn a_library_snapshot_round_trips() {
        let mut conn = open_in_memory().unwrap();
        let workspace = WorkspaceSnapshot {
            projects: vec![project("p")],
            cards: vec![json!({
                "id":"c","projectId":"p","title":"卡片","favorite":false,"unread":false,
                "concepts":["退相干"],"createdAt":1,
                "turns":[{"id":"t","role":"user","content":"问","createdAt":1},
                         {"id":"t2","role":"ai","content":"答","createdAt":2,"status":"complete"}]
            })],
            edges: vec![],
            anchors: vec![json!({"id":"a1","cardId":"c","text":"片段"})],
            snapshots: vec![],
            references: vec![json!({"id":"r1","projectId":"p","sourceTitle":"来源",
                                    "excerpt":"摘录","anchor":{"cardId":"c"}})],
            view: json!({"id":"main","activeProjectId":"p","currentCardId":"c",
                         "drafts":{"p":"草稿"},"lastCardByProject":{},"collapsed":[],
                         "scrollPositions":{"c":42}}),
            settings: json!({"id":"app","model":"claude-opus-5"}),
        };
        let attention = AttentionSnapshot {
            events: vec![json!({"id":"e1","projectId":"p","createdAt":10,"type":"title-edited"})],
            sessions: vec![],
            proposals: vec![],
        };
        write_snapshot(&mut conn, &workspace, &attention).unwrap();

        let back = load_workspace(&conn).unwrap().expect("库里应该有内容");
        assert_eq!(back.projects.len(), 1);
        assert_eq!(back.cards[0]["turns"].as_array().unwrap().len(), 2);
        assert_eq!(back.cards[0]["concepts"][0], "退相干");
        assert_eq!(back.view["drafts"]["p"], "草稿");
        assert_eq!(back.view["scrollPositions"]["c"], 42);
        assert_eq!(back.settings["model"], "claude-opus-5");
        assert_eq!(back.anchors.len(), 1);
        assert_eq!(back.references[0]["anchor"]["cardId"], "c");
        assert_eq!(load_attention(&conn).unwrap().events.len(), 1);
    }

    /// 列为 NULL 时必须**省略键**。写成 null 的话，前端 sameCardRecord 的键数比较
    /// 会在每次重载后的首次 diff 全部触发，把每张卡片白白重写一遍。
    #[test]
    fn absent_optionals_are_omitted_not_null() {
        let conn = seeded();
        let back = load_workspace(&conn).unwrap().unwrap();
        let card = &back.cards[0];
        for key in ["answerMode", "trashed", "origin", "proposalId"] {
            assert!(card.get(key).is_none(), "{key} 不该出现在读回的卡片里");
        }
        for key in ["streaming", "status", "error", "model", "favorite"] {
            assert!(
                card["turns"][0].get(key).is_none(),
                "{key} 不该出现在读回的轮次里"
            );
        }
    }

    #[test]
    fn a_turn_can_move_to_another_card() {
        let mut conn = seeded();
        let mut moved = WorkspaceUpsert::default();
        moved.turns.upserts = vec![turn("t", "c2")];
        apply_changes(&mut conn, &moved).unwrap();
        let turns = read_turns(&conn).unwrap();
        assert_eq!(
            turns.iter().find(|t| t.turn.id == "t").unwrap().card_id,
            "c2"
        );
        assert_eq!(turns.len(), 2, "改道是移动不是复制");
    }
}
