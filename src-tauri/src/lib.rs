mod db;
mod llm;

use db::{AttentionSnapshot, AttentionUpsert, RemovedProject, WorkspaceSnapshot, WorkspaceUpsert};
use llm::{ChatRequest, ProviderConfig, ProviderHealth, PublicConfig, StreamEvent};
use rusqlite::Connection;
use serde_json::Value;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::ipc::Channel;
use tauri::{Manager, State};

/// 模型配置只住在本进程内存和 0600 的配置文件里，前端拿不到密钥本身。
pub struct Provider {
    config: Mutex<ProviderConfig>,
    path: PathBuf,
}

/// 单写者。SQLite 自己是单写者 + WAL，这把锁额外保证的是调用方观察到的完成顺序，
/// 从而让前端「写成功后才推进基线」是安全的——语义等价于 dexie.ts 里的 `enqueue`。
pub struct Db(Mutex<Connection>);

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
    llm::save_config(&state.path, &next)?;
    *guard = next;
    Ok(PublicConfig::from(&*guard))
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
    tauri::async_runtime::spawn_blocking(move || llm::stream(&config, &request, &channel))
        .await
        .map_err(|e| llm::Error::from(e.to_string()))?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
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
            app.manage(Db(Mutex::new(conn)));

            let path = llm::config_path(&dir);
            app.manage(Provider {
                config: Mutex::new(llm::load_config(&path)),
                path,
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
            import_library,
            provider_health,
            provider_config,
            save_provider_config,
            llm_generate,
            llm_stream,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
