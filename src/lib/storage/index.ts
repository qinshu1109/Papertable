/**
 * 存储后端的选择点。
 *
 * `store.tsx` 从 `./lib/storage` 具名引入，解析到这个 barrel——所以换后端时它一行
 * 都不用改。这是「接缝真实存在」的最强证据；哪天做不到零行改动，就说明有隐藏的
 * 后端耦合漏了出来，应该先修掉再往下走。
 *
 * 用编译期的 `__PAPERTABLE_TARGET__` 而不是运行时探测 `"__TAURI_INTERNALS__" in
 * window`：这样桌面包能 tree-shake 掉 Dexie，web 包永不拉 `@tauri-apps/api`。
 */
import { dexieStorage } from "./dexie";
import { tauriStorage } from "./tauri";
import type { StorageAdapter } from "./types";

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

export const storage: StorageAdapter =
  __PAPERTABLE_TARGET__ === "desktop" ? tauriStorage : dexieStorage;

export const {
  loadWorkspace,
  loadAttentionState,
  seedIfEmpty,
  applyChanges,
  applyAttentionChanges,
  putAttentionState,
  saveWorkspace,
  deleteProjectCascade,
  deleteReferences,
  deleteProposals,
  clearWorkspace,
  importLibrary,
} = storage;

/** @internal 仅供 Dexie 实现的测试直接操作底层表。 */
export { db } from "./dexie";
