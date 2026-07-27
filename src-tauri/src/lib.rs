mod db;
mod llm;
mod vault;
mod watcher;

use db::{AttentionSnapshot, AttentionUpsert, RemovedProject, WorkspaceSnapshot, WorkspaceUpsert};
use llm::{ChatRequest, KeySource, ProviderConfig, ProviderHealth, PublicConfig, StreamEvent};
use rusqlite::Connection;
use serde_json::Value;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::ipc::Channel;
use tauri::{Manager, State};

/// 监听线程要拿同一个连接，所以 Db 内部改成 Arc；这个别名只是给 setup 用。
pub struct SharedDb(Arc<Mutex<Connection>>);

/// 模型配置只住在本进程内存和 0600 的配置文件里，前端拿不到密钥本身。
pub struct Provider {
    config: Mutex<ProviderConfig>,
    path: PathBuf,
    /// 应用数据目录，用于按标记文件开启 SSE 抓取。
    data_dir: PathBuf,
    /// 密钥实际是从钥匙串读到的，还是回落到了文件。设置页要如实展示。
    from_keychain: Mutex<bool>,
}

/// 单写者。SQLite 自己是单写者 + WAL，这把锁额外保证的是调用方观察到的完成顺序，
/// 从而让前端「写成功后才推进基线」是安全的——语义等价于 dexie.ts 里的 `enqueue`。
pub struct Db(Arc<Mutex<Connection>>);

macro_rules! with_db {
    ($state:expr, $conn:ident, $body:expr) => {{
        let mut guard = $state.0.lock().map_err(|_| "数据库锁被毒化".to_string())?;
        let $conn = &mut *guard;
        $body
    }};
}

#[tauri::command]
fn load_workspace(state: State<Db>) -> Result<Option<WorkspaceSnapshot>, db::Error> {
    with_db!(state, conn, db::load_workspace(conn))
}

#[tauri::command]
fn load_attention(state: State<Db>) -> Result<AttentionSnapshot, db::Error> {
    with_db!(state, conn, db::load_attention(conn))
}

#[tauri::command]
fn apply_changes(state: State<Db>, upsert: WorkspaceUpsert) -> Result<(), db::Error> {
    with_db!(state, conn, db::apply_changes(conn, &upsert))
}

#[tauri::command]
fn apply_attention_changes(state: State<Db>, upsert: AttentionUpsert) -> Result<(), db::Error> {
    with_db!(state, conn, db::apply_attention_changes(conn, &upsert))
}

#[tauri::command]
fn put_attention_state(state: State<Db>, snapshot: AttentionSnapshot) -> Result<(), db::Error> {
    with_db!(state, conn, db::put_attention_state(conn, &snapshot))
}

#[tauri::command]
fn delete_project_cascade(
    state: State<Db>,
    project_id: String,
) -> Result<RemovedProject, db::Error> {
    with_db!(state, conn, db::delete_project_cascade(conn, &project_id))
}

#[tauri::command]
fn delete_references(state: State<Db>, ids: Vec<String>) -> Result<(), db::Error> {
    with_db!(state, conn, db::delete_references(conn, &ids))
}

#[tauri::command]
fn delete_proposals(state: State<Db>, ids: Vec<String>) -> Result<(), db::Error> {
    with_db!(state, conn, db::delete_proposals(conn, &ids))
}

/// 库为空时播种；非空时返回库里已有的内容，绝不覆盖。
#[tauri::command]
fn seed_if_empty(
    state: State<Db>,
    seed: WorkspaceSnapshot,
) -> Result<WorkspaceSnapshot, db::Error> {
    with_db!(state, conn, {
        if db::is_empty(conn)? {
            db::write_snapshot(conn, &seed, &AttentionSnapshot::default())?;
        }
        Ok(db::load_workspace(conn)?.unwrap_or(seed))
    })
}

#[tauri::command]
fn save_workspace(state: State<Db>, snapshot: WorkspaceSnapshot) -> Result<(), db::Error> {
    with_db!(state, conn, {
        db::clear_all(conn)?;
        db::write_snapshot(conn, &snapshot, &AttentionSnapshot::default())
    })
}

#[tauri::command]
fn clear_workspace(state: State<Db>) -> Result<(), db::Error> {
    with_db!(state, conn, db::clear_all(conn))
}

/// 前端模块在 WebView 初始化阶段异常时，至少把简短的诊断留在本机。这个命令
/// 不读取业务数据、不回传路径，也不记录堆栈或请求内容；它只解决「白屏但没有
/// 可见错误」这一类桌面端排障死角。
#[tauri::command]
fn report_frontend_startup_failure(app: tauri::AppHandle, message: String) -> Result<(), String> {
    use std::io::Write;

    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    let path = dir.join("frontend-startup.log");
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|error| error.to_string())?;
    let clipped: String = message.chars().take(4_000).collect();
    writeln!(file, "{} | {}", now_millis(), clipped.replace('\n', " "))
        .map_err(|error| error.to_string())
}

/// 首启导入整库备份。**源（浏览器的 IndexedDB）永不被触碰**，所以这一步失败是可
/// 回滚的；导入后前端立刻重新 load 并逐表比对，结果显示在 UI 上。
#[tauri::command]
fn import_library(
    state: State<Db>,
    workspace: WorkspaceSnapshot,
    attention: AttentionSnapshot,
) -> Result<(), db::Error> {
    with_db!(state, conn, {
        db::clear_all(conn)?;
        db::write_snapshot(conn, &workspace, &attention)
    })
}

// ---------------------------------------------------------------------------
// 模型通道
// ---------------------------------------------------------------------------

fn provider_snapshot(state: &State<Provider>) -> Result<ProviderConfig, llm::Error> {
    Ok(state
        .config
        .lock()
        .map_err(|_| "配置锁被毒化".to_string())?
        .clone())
}

#[tauri::command]
fn provider_health(state: State<Provider>) -> Result<ProviderHealth, llm::Error> {
    Ok(llm::health(&provider_snapshot(&state)?))
}

#[tauri::command]
fn provider_config(state: State<Provider>) -> Result<PublicConfig, llm::Error> {
    Ok(PublicConfig::from(&provider_snapshot(&state)?))
}

#[tauri::command]
fn save_provider_config(state: State<Provider>, input: Value) -> Result<PublicConfig, llm::Error> {
    let mut guard = state
        .config
        .lock()
        .map_err(|_| "配置锁被毒化".to_string())?;
    let next = llm::normalize(&input, &guard)?;
    let in_keychain = llm::save_config(&state.path, &next)?;
    *guard = next;
    if let Ok(mut source) = state.from_keychain.lock() {
        *source = in_keychain;
    }
    Ok(PublicConfig::from(&*guard))
}

/// 这一份构建是什么。
///
/// 存在的理由：ad-hoc 签名下 `/Applications` 里那份和 `target/` 里的构建产物
/// bundle id 相同、版本号相同、共用同一个数据库，界面上分辨不出打开的是哪一份。
/// 曾经因此运行了三小时前的旧代码而毫无察觉。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct BuildInfo {
    version: &'static str,
    commit: &'static str,
    built_at: &'static str,
    /// 可执行文件路径——这是唯一能确凿区分三份 bundle 的东西。
    exe: String,
    /// 从 /Applications 启动的才是正式安装的那份。
    installed: bool,
}

#[tauri::command]
fn build_info() -> BuildInfo {
    let exe = std::env::current_exe()
        .map(|p| p.display().to_string())
        .unwrap_or_default();
    BuildInfo {
        version: env!("CARGO_PKG_VERSION"),
        commit: env!("PAPERTABLE_COMMIT"),
        built_at: env!("PAPERTABLE_BUILT_AT"),
        installed: exe.starts_with("/Applications/"),
        exe,
    }
}

/// 密钥存在哪：钥匙串、回落文件，还是没设置。
#[tauri::command]
fn provider_key_source(state: State<Provider>) -> Result<KeySource, llm::Error> {
    let config = provider_snapshot(&state)?;
    let from_keychain = *state
        .from_keychain
        .lock()
        .map_err(|_| "配置锁被毒化".to_string())?;
    Ok(llm::key_source(&config, from_keychain))
}

#[tauri::command]
fn llm_generate(state: State<Provider>, request: ChatRequest) -> Result<String, llm::Error> {
    llm::generate(&provider_snapshot(&state)?, &request)
}

/// 流式生成。事件走 Tauri `Channel`，替代浏览器里的 SSE 解析循环。
/// 阻塞式 HTTP 读放到线程池里，避免占住 IPC 线程。
#[tauri::command]
async fn llm_stream(
    state: State<'_, Provider>,
    request: ChatRequest,
    channel: Channel<StreamEvent>,
) -> Result<(), llm::Error> {
    let config = provider_snapshot(&state)?;
    let tap = llm::SseTap::open(Some(&state.data_dir));
    tauri::async_runtime::spawn_blocking(move || llm::stream(&config, &request, &channel, &tap))
        .await
        .map_err(|e| llm::Error::from(e.to_string()))?
}

// ---------------------------------------------------------------------------
// vault 同步
// ---------------------------------------------------------------------------

/// 一篇待写笔记。内容由 TS 侧的 `vaultNote.ts` 序列化——归一化哈希只在 Rust 侧算，
/// 因为只有这边需要读回磁盘上的文件做比较。
#[derive(serde::Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
struct NoteWrite {
    /// 卡片 id；`None` 表示 `_索引.md` / `_关系.canvas` 这类项目级产物。
    card_id: Option<String>,
    /// 相对于 Papertable 容纳根目录的分段路径。
    relative: Vec<String>,
    content: String,
}

/// 按容纳规则写一批笔记，并按 `sync_state` 逐个做冲突检测。
///
/// 冲突的那一篇**不推进基线**，同步就此挂起；其余照常写入，不会因为一篇冲突就
/// 整批停摆。
#[tauri::command]
fn vault_sync(
    db: State<Db>,
    watch: State<watcher::VaultWatcher>,
    vault: String,
    subtree: String,
    notes: Vec<NoteWrite>,
    now: i64,
) -> Result<Vec<vault::WriteReport>, vault::Error> {
    let root = std::path::PathBuf::from(&vault);
    // 落点可配置，但**必须先归一化并校验**：空值回落到默认子树，拒绝绝对路径、
    // `..`、以 `.` 开头的分量。
    let subtree = vault::subtree_or_default(&subtree)?;
    let mut guard = db.0.lock().map_err(|_| "数据库锁被毒化".to_string())?;
    let conn = &mut *guard;
    let mut reports = Vec::with_capacity(notes.len());

    for note in &notes {
        let parts: Vec<&str> = note.relative.iter().map(String::as_str).collect();
        let target = note.relative.join("/");

        let mut overwrite = vault::Overwrite::IfUnchanged;
        if let Some(id) = &note.card_id {
            let record =
                db::sync_record(conn, id).map_err(|e| vault::Error::from(e.to_string()))?;
            // 用户选过「以 Papertable 为准」：这一次无条件覆盖。
            if matches!(&record, Some((_, status)) if status == "force") {
                overwrite = vault::Overwrite::Force;
            }
            match record {
                // 用户选了「保留笔记」：这张卡片已脱钩，此后一个字都不写。
                // 之前这里没检查，于是墓碑写了没人读——按钮点完，下一轮同步又冲突。
                Some((_, status)) if status == "detached" => continue,
                // 标题变了：先 rename 再写，Obsidian 会自动更新指向它的 [[双链]]。
                // 路径取自 sync_state 记下的那个，不是重新推算的——推算依赖当时的
                // 重名集合，改完标题就对不上了。
                Some((old, _)) if old != target => {
                    let old_parts: Vec<&str> = old.split('/').collect();
                    watch.mark(std::path::Path::new(&old));
                    watch.mark(std::path::Path::new(&target));
                    vault::rename_note(&root, &subtree, &old_parts, &parts)?;
                    // 冲突副本挂在旧文件名上；不清掉就永远是孤儿。
                    // 若冲突仍然成立，下一次写入会在新路径重新生成它。
                    vault::remove_conflict_copy(&root, &subtree, &old_parts)?;
                }
                _ => {}
            }
        }

        let previous = match &note.card_id {
            Some(id) => db::sync_hash(conn, id).map_err(|e| vault::Error::from(e.to_string()))?,
            None => None,
        };
        // 项目级产物没有 card_id，也就没有基线；它们完全由 Papertable 生成，
        // 用「内容不同就覆盖」即可，所以这里把当前磁盘内容当作基线传进去。
        let previous = match (&note.card_id, previous) {
            (None, _) => {
                let path = vault::resolve_in(&root, &subtree, &parts)?;
                std::fs::read_to_string(&path)
                    .ok()
                    .map(|text| vault::normalized_hash(&text))
            }
            (_, value) => value,
        };

        // 写盘前登记：让常见路径省掉一次读盘。**只是优化**，真正的判定靠哈希。
        watch.mark(std::path::Path::new(&note.relative.join("/")));
        let report = vault::write_note(
            &root,
            &subtree,
            &parts,
            &note.content,
            previous.as_deref(),
            overwrite,
        )?;
        if let Some(id) = &note.card_id {
            let status = if report.outcome == vault::WriteOutcome::Conflict {
                "conflict"
            } else {
                "synced"
            };
            db::put_sync_state(conn, id, &report.path, report.hash.as_deref(), now, status)
                .map_err(|e| vault::Error::from(e.to_string()))?;
        }
        reports.push(report);
    }
    Ok(reports)
}

/// 标题变更走 rename 而不是删+建，Obsidian 会自动更新指向它的 `[[双链]]`。
#[tauri::command]
fn vault_rename(
    vault: String,
    subtree: String,
    from: Vec<String>,
    to: Vec<String>,
) -> Result<(), vault::Error> {
    let subtree = vault::subtree_or_default(&subtree)?;
    let root = std::path::PathBuf::from(&vault);
    vault::rename_note(
        &root,
        &subtree,
        &from.iter().map(String::as_str).collect::<Vec<_>>(),
        &to.iter().map(String::as_str).collect::<Vec<_>>(),
    )
}

/// 卡片进回收站时删掉笔记，不留孤儿。
#[tauri::command]
fn vault_delete(vault: String, subtree: String, relative: Vec<String>) -> Result<(), vault::Error> {
    let subtree = vault::subtree_or_default(&subtree)?;
    vault::delete_note(
        &std::path::PathBuf::from(&vault),
        &subtree,
        &relative.iter().map(String::as_str).collect::<Vec<_>>(),
    )
}

/// 取消跟踪一批卡片，并删掉它们在知识库里的笔记。
///
/// 路径取自 `sync_state` 记下的那个——**只删我们确实写过的文件**，绝不按当前状态
/// 重新推算文件名，那样可能删到别人的东西。
#[tauri::command]
fn vault_forget(
    db: State<Db>,
    watch: State<watcher::VaultWatcher>,
    vault: String,
    subtree: String,
    card_ids: Vec<String>,
) -> Result<usize, vault::Error> {
    let subtree = vault::subtree_or_default(&subtree)?;
    let root = std::path::PathBuf::from(&vault);
    let mut guard = db.0.lock().map_err(|_| "数据库锁被毒化".to_string())?;
    let conn = &mut *guard;
    let mut removed = 0usize;
    for id in &card_ids {
        let Some((path, _)) =
            db::sync_record(conn, id).map_err(|e| vault::Error::from(e.to_string()))?
        else {
            continue;
        };
        watch.mark(std::path::Path::new(&path));
        let parts: Vec<&str> = path.split('/').collect();
        vault::delete_note(&root, &subtree, &parts)?;
        vault::remove_conflict_copy(&root, &subtree, &parts)?;
        db::forget_sync(conn, id).map_err(|e| vault::Error::from(e.to_string()))?;
        removed += 1;
    }
    Ok(removed)
}

/// Papertable 到目前为止真正写过的磁盘路径。
///
/// 容纳规则的**自证**手段。验收时把 Obsidian 自己改写 `.obsidian/workspace.json`
/// 算成了 Papertable 的红线事故；真实库是个活的 vault，靠比对整库 mtime 无法归因。
/// 有了这份清单，「Papertable 写了哪些路径」可以直接读出来。
#[tauri::command]
fn vault_written_paths() -> Vec<String> {
    vault::written_paths()
}

#[tauri::command]
fn vault_conflicts(db: State<Db>) -> Result<Vec<(String, String)>, db::Error> {
    with_db!(db, conn, db::conflicted(conn))
}

/// 冲突裁决。`keep` 是按钮的意图字符串，映射只发生在 `db::resolve_conflict` 一处；
/// **返回落库后的真实状态**，UI 的提示必须基于返回值而不是点击意图——接线若再出错，
/// 提示会当场暴露它。
#[tauri::command]
fn vault_resolve_conflict(
    db: State<Db>,
    vault: String,
    subtree: String,
    card_id: String,
    keep: String,
) -> Result<String, vault::Error> {
    let subtree = vault::subtree_or_default(&subtree)?;
    let root = std::path::PathBuf::from(&vault);
    let mut guard = db.0.lock().map_err(|_| "数据库锁被毒化".to_string())?;
    let conn = &mut *guard;
    let record = db::sync_record(conn, &card_id).map_err(|e| vault::Error::from(e.to_string()))?;
    let status = db::resolve_conflict(conn, &card_id, &keep)
        .map_err(|e| vault::Error::from(e.to_string()))?;
    // 「保留笔记」= 用户拒绝了 Papertable 的那份内容，冲突副本立即清掉。
    // 「以 Papertable 为准」的副本由下一次强制写入清理。
    if status == "detached" {
        if let Some((path, _)) = record {
            let parts: Vec<&str> = path.split('/').collect();
            vault::remove_conflict_copy(&root, &subtree, &parts)?;
        }
    }
    Ok(status.to_string())
}

// ---------------------------------------------------------------------------
// vault 监听（入向）
//
// 入向**只新增 ReferenceChip**，永不改动 Card / Turn / CardEdge。
// ---------------------------------------------------------------------------

/// 全量重扫并开始监听。监听器出问题时，重新调用它就是那个「重新扫描知识库」按钮。
#[tauri::command]
fn vault_watch(
    app: tauri::AppHandle,
    shared: State<SharedDb>,
    watch: State<watcher::VaultWatcher>,
    vault: String,
) -> Result<usize, vault::Error> {
    let root = std::path::PathBuf::from(&vault);
    let now = now_millis();
    let count = {
        let conn = shared.0.lock().map_err(|_| "数据库锁被毒化".to_string())?;
        watcher::scan(&conn, &root, now).map_err(|e| vault::Error::from(e.to_string()))?
    };
    let handle = app.clone();
    watch
        .start(root, Arc::clone(&shared.0), move |notes| {
            use tauri::Emitter;
            let _ = handle.emit("vault-changed", notes);
        })
        .map_err(|e| vault::Error::from(e.to_string()))?;
    Ok(count)
}

/// 把 `[[双链]]` 解析成 vault 里的真实笔记。
#[tauri::command]
fn vault_resolve_link(
    db: State<Db>,
    name: String,
) -> Result<Vec<(String, Option<String>)>, db::Error> {
    with_db!(db, conn, db::resolve_link(conn, &name))
}

#[tauri::command]
fn vault_indexed_count(db: State<Db>) -> Result<i64, db::Error> {
    with_db!(db, conn, db::indexed_count(conn))
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // 单实例。两份**不同版本**的 bundle 同时运行在同一个数据库上，是跨进程版的
        // 多标签页问题：每个进程各持一份内存基线，而它们互相不可见。
        // 第二次启动时聚焦已有窗口，而不是再开一个。
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            use tauri::Manager;
            if let Some(window) = app.webview_windows().values().next() {
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            // 库放在 app_data_dir，**绝不放进 vault**：WAL 文件在 Obsidian vault 或
            // 云同步目录里是损坏源，而且 Obsidian 会去索引它。
            let dir = app.path().app_data_dir()?;
            let conn = db::open(&dir.join("papertable.sqlite3"))
                .map_err(|e| std::io::Error::other(e.to_string()))?;
            let shared = Arc::new(Mutex::new(conn));
            app.manage(Db(Arc::clone(&shared)));
            app.manage(SharedDb(shared));
            app.manage(watcher::VaultWatcher::default());

            let path = llm::config_path(&dir);
            let (config, from_keychain) = llm::load_config_with_source(&path);
            app.manage(Provider {
                config: Mutex::new(config),
                path,
                data_dir: dir.clone(),
                from_keychain: Mutex::new(from_keychain),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_workspace,
            load_attention,
            apply_changes,
            apply_attention_changes,
            put_attention_state,
            delete_project_cascade,
            delete_references,
            delete_proposals,
            seed_if_empty,
            save_workspace,
            clear_workspace,
            report_frontend_startup_failure,
            import_library,
            provider_health,
            provider_config,
            save_provider_config,
            provider_key_source,
            build_info,
            llm_generate,
            llm_stream,
            vault_sync,
            vault_rename,
            vault_delete,
            vault_forget,
            vault_watch,
            vault_resolve_link,
            vault_indexed_count,
            vault_written_paths,
            vault_conflicts,
            vault_resolve_conflict,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
