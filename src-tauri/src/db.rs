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
const USER_VERSION: i64 = 2;

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
fn migrate(conn: &Connection) -> Result<()> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if version < USER_VERSION {
        conn.execute_batch(SCHEMA)?;
        conn.execute_batch(&format!("PRAGMA user_version = {USER_VERSION}"))?;
    }
    // 每次打开都要重设：foreign_keys 是 per-connection 的，不随库持久化。
    conn.execute_batch("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;")?;
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
        "SELECT id, card_id, role, content, created_at, streaming, status, error, model, favorite
         FROM turns ORDER BY card_id, created_at",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(TurnRecord {
            card_id: row.get(1)?,
            turn: Turn {
                id: row.get(0)?,
                role: row.get(2)?,
                content: row.get(3)?,
                created_at: row.get(4)?,
                streaming: row.get::<_, Option<i64>>(5)?.map(|v| v != 0),
                status: row.get(6)?,
                error: row.get(7)?,
                model: row.get(8)?,
                favorite: row.get::<_, Option<i64>>(9)?.map(|v| v != 0),
            },
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
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
                                error, model, favorite)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)
             ON CONFLICT(id) DO UPDATE SET
               card_id = excluded.card_id, role = excluded.role, content = excluded.content,
               created_at = excluded.created_at, streaming = excluded.streaming,
               status = excluded.status, error = excluded.error, model = excluded.model,
               favorite = excluded.favorite",
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

pub fn is_empty(conn: &Connection) -> Result<bool> {
    let count: i64 = conn.query_row("SELECT COUNT(*) FROM projects", [], |row| row.get(0))?;
    Ok(count == 0)
}

pub fn clear_all(conn: &mut Connection) -> Result<()> {
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
        "interaction_events",
        "session_boundaries",
        "proposals",
    ] {
        tx.execute(&format!("DELETE FROM {table}"), [])?;
    }
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
pub fn clear_conflict(conn: &Connection, card_id: &str) -> Result<()> {
    conn.execute(
        "UPDATE sync_state SET status = 'synced', last_written_hash = NULL WHERE card_id = ?1",
        params![card_id],
    )?;
    Ok(())
}

/// 用户选择「保留笔记」：给这张卡片立墓碑，此后不再同步。
pub fn stop_syncing(conn: &Connection, card_id: &str) -> Result<()> {
    conn.execute(
        "UPDATE sync_state SET status = 'detached' WHERE card_id = ?1",
        params![card_id],
    )?;
    Ok(())
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
