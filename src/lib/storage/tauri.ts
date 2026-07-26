/**
 * 桌面端存储适配器：把 `StorageAdapter` 的每个方法转成一次 Tauri 命令调用。
 *
 * 这一层刻意只有转发，没有逻辑。所有语义——只增不删、级联在事务内按 project_id
 * 重新查库、`put_attention_state` upsert-only——都在 `src-tauri/src/db.rs` 里实现
 * 并有 Rust 测试守着。两处各写一遍逻辑必然漂移。
 *
 * 一次 `applyChanges` 是**一次 IPC、一个事务**。这正是不用 `tauri-plugin-sql` 的
 * 原因：那个插件的 `execute(sql, params)` 会把一次触及 9 张表的保存拆成 N 次往返，
 * 而且没法包进一个可回滚的事务。
 */
import { invoke } from "@tauri-apps/api/core";
import type {
  AttentionSnapshot,
  AttentionUpsert,
  WorkspaceSnapshot,
  WorkspaceUpsert,
} from "../delta";
import type { StorageAdapter } from "./types";

export const tauriStorage: StorageAdapter = {
  loadWorkspace: () => invoke<WorkspaceSnapshot | null>("load_workspace"),
  loadAttentionState: () => invoke<AttentionSnapshot>("load_attention"),
  seedIfEmpty: (seed) => invoke<WorkspaceSnapshot>("seed_if_empty", { seed }),
  applyChanges: (upsert) => invoke<void>("apply_changes", { upsert }),
  applyAttentionChanges: (upsert) =>
    invoke<void>("apply_attention_changes", { upsert }),
  putAttentionState: (snapshot) =>
    invoke<void>("put_attention_state", { snapshot }),
  saveWorkspace: (snapshot) => invoke<void>("save_workspace", { snapshot }),
  deleteProjectCascade: (projectId) =>
    invoke<{ workspace: WorkspaceUpsert; attention: AttentionUpsert }>(
      "delete_project_cascade",
      { projectId },
    ),
  deleteReferences: (ids) => invoke<void>("delete_references", { ids }),
  deleteProposals: (ids) => invoke<void>("delete_proposals", { ids }),
  clearWorkspace: () => invoke<void>("clear_workspace"),
  /**
   * 首启把整库备份写进 SQLite。**浏览器那份 IndexedDB 全程不动**，所以这一步失败
   * 是可回滚的；写完之后调用方要立刻重新 load 并逐表比对。
   */
  importLibrary: (input) => invoke<void>("import_library", input),
};
