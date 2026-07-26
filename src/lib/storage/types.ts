/**
 * 存储后端需要实现的全部表面。
 *
 * 刻意很薄：就是 `store.tsx` 实际用到的那些方法，不多不少。
 *
 * **不要加 `query*`。** 没有任何东西在查询——store 在启动时一次性 `loadWorkspace()`
 * 读全量，此后都在内存里过滤。给这个接口加查询能力是在为不存在的需求付设计税。
 *
 * **不要让它泛型化到表名。** `WorkspaceUpsert` 已经是那个泛化形式了。
 *
 * 迁移到 Tauri/SQLite 时要重写的只有实现文件：`delta.ts` 那套纯粹的增量计算、
 * 这个接口、以及「删除只能来自显式意图」的规则都原样成立。届时
 * `deleteProjectCascade` 的六个索引查询会塌缩成一句带 `ON DELETE CASCADE` 的
 * `DELETE`，而 `enqueue` 的写入串行化会并入 SQLite 的单写者 + WAL。
 */
import type {
  AttentionSnapshot,
  AttentionUpsert,
  WorkspaceSnapshot,
  WorkspaceUpsert,
} from "../delta";

export interface StorageAdapter {
  loadWorkspace(): Promise<WorkspaceSnapshot | null>;
  loadAttentionState(): Promise<AttentionSnapshot>;
  /** 库为空时播种；非空时返回库里已有的内容，绝不覆盖。 */
  seedIfEmpty(seed: WorkspaceSnapshot): Promise<WorkspaceSnapshot>;
  /** 日常自动保存。只增不删。 */
  applyChanges(upsert: WorkspaceUpsert): Promise<void>;
  applyAttentionChanges(upsert: AttentionUpsert): Promise<void>;
  /** upsert-only；绝不清空会话与提案。 */
  putAttentionState(snapshot: AttentionSnapshot): Promise<void>;
  /** 全量替换。只用于「清除本地数据」后的重置这类明确场景。 */
  saveWorkspace(snapshot: WorkspaceSnapshot): Promise<void>;
  /** 在写事务内按 projectId 重新查库定位从属行；返回被删的行供撤销精确还原。 */
  deleteProjectCascade(projectId: string): Promise<{
    workspace: WorkspaceUpsert;
    attention: AttentionUpsert;
  }>;
  deleteReferences(ids: string[]): Promise<void>;
  deleteProposals(ids: string[]): Promise<void>;
  clearWorkspace(): Promise<void>;
  /**
   * 用整库备份整体替换本后端的内容。桌面版首启靠它接手浏览器里的数据。
   * 放在接口上而不是只给 Tauri 实现，是为了让 store 不必条件引入
   * `@tauri-apps/api`——否则 web 包会被拖进 Tauri 运行时。
   */
  importLibrary(input: {
    workspace: WorkspaceSnapshot;
    attention: AttentionSnapshot;
  }): Promise<void>;
}
