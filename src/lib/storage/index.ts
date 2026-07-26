/**
 * 存储后端的选择点。
 *
 * `store.tsx` 从 `./lib/storage` 具名引入，解析到这个 barrel——所以拆分实现文件
 * 时它一行都不用改。这是「接缝真实存在」的最强证据；哪天做不到零行改动，就说明
 * 有隐藏的 Dexie 耦合漏了出来，应该先在 web 端修掉再动 Rust。
 *
 * S2 引入 SQLite 时，这里加一个 `__PAPERTABLE_TARGET__` 的 Vite define 分支，让
 * 桌面包 tree-shake 掉 Dexie、web 包不拉 `@tauri-apps/api`。现在只有一个实现，
 * 提前加那个 define 只会留下一段永远走不到的死代码，所以等到真有第二个目标时再加。
 */
export type { StorageAdapter } from "./types";

export type {
  AnchorRecord,
  AttentionSnapshot,
  AttentionUpsert,
  CardRecord,
  TurnRecord,
  WorkspaceSnapshot,
  WorkspaceUpsert,
} from "../delta";

export {
  applyAttentionChanges,
  applyChanges,
  clearWorkspace,
  db,
  deleteProjectCascade,
  deleteProposals,
  deleteReferences,
  dexieStorage as storage,
  loadAttentionState,
  loadWorkspace,
  putAttentionState,
  saveWorkspace,
  seedIfEmpty,
} from "./dexie";
