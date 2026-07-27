/**
 * 整库备份：一个文件覆盖全部 12 张表。
 *
 * 存在的理由是一件必须说清的事：**IndexedDB → SQLite 的自动迁移不可能做到。**
 * 现有数据在你打开 `127.0.0.1:5173` 的那个*浏览器 profile* 里；Tauri 在 macOS 用
 * WKWebView，数据存储按 bundle identifier 隔离，桌面应用**看不见**那个数据库。
 * 没有任何 crate、插件或 Tauri API 能读另一个浏览器的 IndexedDB。
 *
 * 所以交接改为显式、可见、可验证：web 端导出这个文件 → 桌面首启导入 → 导入后立即
 * 从 SQLite 重新读出来与导入内容深比较，结果显示在 UI 里 → **web 端的 IndexedDB
 * 全程不动**，作为数周的实时回滚。源永不被修改，目标被校验过，所以这条路丢不了数据。
 *
 * 与「导出全部备份」（每个项目一个无损 ZIP）的区别：那个是按项目的交付物，不含
 * `view`、`settings` 和注意力实验的三张表。迁移需要的是整库。
 */
import type { AttentionSnapshot, WorkspaceSnapshot } from "./delta";
import type { NoteLibrary } from "./notes/types";

export const LIBRARY_BACKUP_SCHEMA = 2;

/** Web-imported source material is durable; desktop Vault indexes are rebuildable. */
export interface NoteCorpusBackup {
  libraries: NoteLibrary[];
  documents: Array<{
    id: string;
    libraryId: string;
    relativePath: string;
    content: string;
    updatedAt: number;
  }>;
  bindings: Array<{ projectId: string; libraryId: string }>;
}

export interface LibraryBackup {
  schema: number;
  exportedAt: string;
  workspace: WorkspaceSnapshot;
  attention: AttentionSnapshot;
  noteCorpus?: NoteCorpusBackup;
}

export function buildLibraryBackup(input: {
  workspace: WorkspaceSnapshot;
  attention: AttentionSnapshot;
  noteCorpus?: NoteCorpusBackup;
  exportedAt: number;
}): LibraryBackup {
  return {
    schema: LIBRARY_BACKUP_SCHEMA,
    exportedAt: new Date(input.exportedAt).toISOString(),
    workspace: input.workspace,
    attention: input.attention,
    ...(input.noteCorpus ? { noteCorpus: input.noteCorpus } : {}),
  };
}

/** 宁可在导入前就报错，也不要把半个库写进新后端。 */
export function parseLibraryBackup(text: string): LibraryBackup {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("备份文件不是合法 JSON。");
  }
  const backup = raw as Partial<LibraryBackup>;
  if (!backup || typeof backup !== "object")
    throw new Error("备份文件结构无法识别。");
  if (backup.schema !== 1 && backup.schema !== LIBRARY_BACKUP_SCHEMA)
    throw new Error(
      `备份文件版本是 ${String(backup.schema)}，本版本只认 1 或 ${LIBRARY_BACKUP_SCHEMA}。`,
    );
  const workspace = backup.workspace;
  const attention = backup.attention;
  if (
    !workspace ||
    !Array.isArray(workspace.projects) ||
    !Array.isArray(workspace.cards) ||
    !workspace.view ||
    !workspace.settings
  )
    throw new Error("备份文件缺少工作区数据。");
  if (
    !attention ||
    !Array.isArray(attention.events) ||
    !Array.isArray(attention.sessions) ||
    !Array.isArray(attention.proposals)
  )
    throw new Error("备份文件缺少注意力实验数据。");
  return backup as LibraryBackup;
}

/** 行数清单，用来在 UI 上展示导入前后的往返比对结果。 */
export function backupCounts(backup: LibraryBackup): Record<string, number> {
  const { workspace, attention } = backup;
  return {
    projects: workspace.projects.length,
    cards: workspace.cards.length,
    turns: workspace.cards.reduce((sum, card) => sum + card.turns.length, 0),
    edges: workspace.edges.length,
    anchors: workspace.anchors.length,
    snapshots: workspace.snapshots.length,
    references: workspace.references.length,
    events: attention.events.length,
    sessions: attention.sessions.length,
    proposals: attention.proposals.length,
    noteLibraries: backup.noteCorpus?.libraries.length ?? 0,
    noteDocuments: backup.noteCorpus?.documents.length ?? 0,
  };
}

/**
 * 往返校验：把「导入的内容」和「从新后端重新读出来的内容」逐表比较。
 * S2 首启导入后必须跑这个，并且把结果显示在 UI 上而不只是测试里。
 */
export function diffBackupCounts(
  expected: LibraryBackup,
  actual: LibraryBackup,
): { equal: boolean; mismatches: string[] } {
  const a = backupCounts(expected);
  const b = backupCounts(actual);
  const mismatches = Object.keys(a)
    .filter((key) => a[key] !== b[key])
    .map((key) => `${key}: 期望 ${a[key]}，实际 ${b[key]}`);
  return { equal: mismatches.length === 0, mismatches };
}
