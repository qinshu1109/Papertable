-- Papertable · SQLite schema (user_version = 1)
--
-- 列的取舍只有一条判据：当且仅当字段是 (a) 外键、(b) ORDER BY 键、
-- (c) 按项目删除的 WHERE 键、(d) Rust 侧 vault 写入器需要解释的字段，
-- 才给它真列；其余一律 JSON。
--
-- store.tsx 启动时一次性 loadWorkspace() 读全量，此后都在内存里过滤，
-- 所以这里刻意比 Dexie 的索引少：多余索引只是 500 ms 流式写入路径上的写放大。

PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS projects (
  id         TEXT PRIMARY KEY,
  name       TEXT    NOT NULL,
  pinned     INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS cards (
  id         TEXT PRIMARY KEY,
  project_id TEXT    NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title      TEXT    NOT NULL,
  favorite   INTEGER NOT NULL DEFAULT 0,
  unread     INTEGER NOT NULL DEFAULT 0,
  answer_mode TEXT,
  trashed    INTEGER,
  origin     TEXT,
  proposal_id TEXT,
  created_at INTEGER NOT NULL,
  concepts   TEXT    NOT NULL DEFAULT '[]',   -- JSON array
  concept_preview_cache TEXT                  -- JSON object，缺省时为 NULL
);

CREATE TABLE IF NOT EXISTS turns (
  id         TEXT PRIMARY KEY,
  -- 不加 UNIQUE：改道时一条轮次会换卡片，靠 ON CONFLICT(id) DO UPDATE 处理。
  card_id    TEXT    NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  role       TEXT    NOT NULL,
  content    TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  streaming  INTEGER,
  status     TEXT,
  error      TEXT,
  model      TEXT,
  favorite   INTEGER
);

CREATE TABLE IF NOT EXISTS edges (
  id              TEXT PRIMARY KEY,
  type            TEXT NOT NULL,
  source_card_id  TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  target_card_id  TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  source_turn_id  TEXT,
  source_text     TEXT,
  source_block_text TEXT,
  source_anchor_id  TEXT,
  -- 刻意不设外键：会与 snapshots.edge_id 形成环。
  context_snapshot_id TEXT,
  -- 三态（缺失 / 显式 null / 字符串）在 SQL 里塌成一个 NULL。已确认全库零读者，
  -- 只是「编辑并改道」的审计字段，所以不需要哨兵列。
  context_cutoff_turn_id TEXT,
  context_policy  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS anchors (
  id       TEXT PRIMARY KEY,
  card_id  TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  turn_id  TEXT,
  text     TEXT,
  block_text TEXT,
  exact    TEXT,
  prefix   TEXT,
  suffix   TEXT,
  source_revision TEXT
);

CREATE TABLE IF NOT EXISTS snapshots (
  id         TEXT PRIMARY KEY,
  edge_id    TEXT    NOT NULL REFERENCES edges(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  source_title TEXT  NOT NULL,
  source_text  TEXT,
  source_block_text TEXT,
  source_turns TEXT                            -- JSON array of Turn
);

-- "references" 是 SQL 保留字；适配器里统一映射到 refs。
CREATE TABLE IF NOT EXISTS refs (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_title TEXT NOT NULL,
  excerpt      TEXT NOT NULL,
  -- 有意的反规范化副本：它必须在源 anchor 被删后继续存在，
  -- 是展示记录而不是活指针。规范化会引入悬空引用。
  anchor       TEXT NOT NULL                   -- JSON
);

-- 单例行：零查询、字段还在演进，给真列只会每加一个字段就要迁移一次。
CREATE TABLE IF NOT EXISTS view     (id TEXT PRIMARY KEY, doc TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS settings (id TEXT PRIMARY KEY, doc TEXT NOT NULL);

-- 注意力实验：append-only 事件 + 两张紧凑状态表。
CREATE TABLE IF NOT EXISTS interaction_events (
  id         TEXT PRIMARY KEY,
  project_id TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  doc        TEXT    NOT NULL
);
CREATE TABLE IF NOT EXISTS session_boundaries (
  id         TEXT PRIMARY KEY,
  project_id TEXT    NOT NULL,
  started_at INTEGER NOT NULL,
  doc        TEXT    NOT NULL
);
CREATE TABLE IF NOT EXISTS proposals (
  id         TEXT PRIMARY KEY,
  project_id TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  doc        TEXT    NOT NULL
);

-- 前七个索引让级联删除不全表扫；后三个服务按项目删除——那是全应用唯一真正的
-- 索引查询。刻意不移植 projects.updated_at/pinned、cards.created_at/trashed、
-- proposals.status/expires_at/purge_at/candidate_key、interaction_events.type 等：
-- 没有任何东西按它们查询。
CREATE INDEX IF NOT EXISTS turns_card      ON turns(card_id, created_at);
CREATE INDEX IF NOT EXISTS cards_project   ON cards(project_id);
CREATE INDEX IF NOT EXISTS edges_source    ON edges(source_card_id);
CREATE INDEX IF NOT EXISTS edges_target    ON edges(target_card_id);
CREATE INDEX IF NOT EXISTS anchors_card    ON anchors(card_id);
CREATE INDEX IF NOT EXISTS snapshots_edge  ON snapshots(edge_id);
CREATE INDEX IF NOT EXISTS refs_project    ON refs(project_id);
CREATE INDEX IF NOT EXISTS ev_project      ON interaction_events(project_id);
CREATE INDEX IF NOT EXISTS sb_project      ON session_boundaries(project_id);
CREATE INDEX IF NOT EXISTS pr_project      ON proposals(project_id);
