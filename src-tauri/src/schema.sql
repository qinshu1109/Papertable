-- Papertable · SQLite schema (user_version = 8)
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
  favorite   INTEGER,
  -- Harness Alpha 只保存可审计的工具轨迹与受控引用，绝不保存隐藏推理。
  agent_run  TEXT,
  citations  TEXT,
  -- 生成中的可见进度；刷新后仍能告诉用户正在检索、阅读还是组织最终回答。
  agent_phase TEXT
);

-- v8：Agent 过程事件与当前恢复游标分离。turn_id 刻意不是外键：普通工作区快照会
-- 重建 turns，但完整审计历史不能因此被级联删除；设置页“清除本地数据”仍会显式清表。
-- agent_events 只允许 INSERT。运行游标 agent_runs 可更新，但必须与新事件同一事务。
CREATE TABLE IF NOT EXISTS agent_runs (
  id             TEXT PRIMARY KEY,
  turn_id        TEXT    NOT NULL UNIQUE,
  schema_version INTEGER NOT NULL CHECK(schema_version > 0),
  phase          TEXT    NOT NULL,
  started_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  finished_at    INTEGER,
  last_sequence  INTEGER NOT NULL DEFAULT 0 CHECK(last_sequence >= 0),
  checkpoint     TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_events (
  id             TEXT PRIMARY KEY,
  run_id         TEXT    NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  sequence       INTEGER NOT NULL CHECK(sequence > 0),
  schema_version INTEGER NOT NULL CHECK(schema_version > 0),
  event_type     TEXT    NOT NULL,
  occurred_at    INTEGER NOT NULL,
  message        TEXT    NOT NULL,
  UNIQUE(run_id, sequence)
);
CREATE INDEX IF NOT EXISTS agent_events_run
  ON agent_events(run_id, sequence);
CREATE TRIGGER IF NOT EXISTS agent_events_no_update
BEFORE UPDATE ON agent_events
BEGIN
  SELECT RAISE(ABORT, 'agent_events are append-only');
END;

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

-- v2：vault 同步状态。`last_written_hash` 是「我们上次写出去的归一化哈希」，
-- 冲突检测全靠它——文件当前内容归一化后与它不符，就说明用户在 Obsidian 改过。
-- status='conflict' 时该卡片的同步挂起，直到用户二选一。
CREATE TABLE IF NOT EXISTS sync_state (
  card_id           TEXT PRIMARY KEY REFERENCES cards(id) ON DELETE CASCADE,
  vault_path        TEXT    NOT NULL,
  last_written_hash TEXT,
  last_written_at   INTEGER NOT NULL,
  status            TEXT    NOT NULL DEFAULT 'synced'
);

-- v3：vault 索引。入向只用来把 [[双链]] 解析成 ReferenceChip，
-- **永不改动 Card / Turn / CardEdge**——ReferenceChip 是纯增量的，不需要冲突解决。
-- `hash` 是归一化哈希，用于识别「这个事件是我们自己写入的回声」。
CREATE TABLE IF NOT EXISTS vault_index (
  path       TEXT PRIMARY KEY,   -- vault 相对路径
  name       TEXT NOT NULL,      -- 文件名去掉 .md，也就是 [[双链]] 里写的那个名字
  note_id    TEXT,               -- frontmatter 里的 papertable_id（若是我们写的）
  hash       TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS vault_index_name ON vault_index(name);
CREATE INDEX IF NOT EXISTS vault_index_note ON vault_index(note_id);

-- v6：只读资料库。它和工作区表刻意分开：资料不是 Card，也不因导入而污染关系图。
-- `root_path` 只在桌面 Vault 型资料库中存在；网页导入资料库没有本机路径。
CREATE TABLE IF NOT EXISTS note_libraries (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL, -- vault | import
  name       TEXT NOT NULL,
  root_path  TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS note_libraries_root
  ON note_libraries(root_path) WHERE root_path IS NOT NULL;

CREATE TABLE IF NOT EXISTS note_documents (
  id           TEXT PRIMARY KEY,
  library_id   TEXT NOT NULL REFERENCES note_libraries(id) ON DELETE CASCADE,
  relative_path TEXT NOT NULL,
  title        TEXT NOT NULL,
  tags         TEXT NOT NULL DEFAULT '[]',
  version_hash TEXT NOT NULL,
  updated_at   INTEGER NOT NULL,
  UNIQUE(library_id, relative_path)
);
CREATE INDEX IF NOT EXISTS note_documents_library ON note_documents(library_id);

CREATE TABLE IF NOT EXISTS note_chunks (
  id           TEXT PRIMARY KEY,
  library_id   TEXT NOT NULL REFERENCES note_libraries(id) ON DELETE CASCADE,
  document_id  TEXT NOT NULL REFERENCES note_documents(id) ON DELETE CASCADE,
  ordinal      INTEGER NOT NULL,
  heading_path TEXT NOT NULL, -- JSON array
  content      TEXT NOT NULL,
  char_start   INTEGER NOT NULL,
  char_end     INTEGER NOT NULL,
  version_hash TEXT NOT NULL,
  UNIQUE(document_id, ordinal)
);
CREATE INDEX IF NOT EXISTS note_chunks_library ON note_chunks(library_id);
CREATE INDEX IF NOT EXISTS note_chunks_document ON note_chunks(document_id, ordinal);

-- 项目绑定是宿主控制的检索范围。模型工具永远拿不到 Vault 路径或 libraryId 参数。
CREATE TABLE IF NOT EXISTS project_note_libraries (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  library_id TEXT NOT NULL REFERENCES note_libraries(id) ON DELETE CASCADE,
  PRIMARY KEY(project_id, library_id)
);
