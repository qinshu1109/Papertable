/**
 * vault 同步的前端接口。规格见 `docs/VAULT_SYNC.md`。
 *
 * 与 storage / provider 同一个模式：web 端是一个明确的空实现，桌面端走 Tauri 命令。
 * 浏览器里碰不到硬盘，所以 web 端不是「暂未实现」而是**结构上不可能**。
 */

export type WriteOutcome = "created" | "updated" | "unchanged" | "conflict";

export interface WriteReport {
  outcome: WriteOutcome;
  /** vault 相对路径，用于在 UI 上点名文件。 */
  path: string;
  conflictPath: string | null;
}

export interface NoteWrite {
  /** `null` 表示 `_索引.md` / `_关系.canvas` 这类项目级产物。 */
  cardId: string | null;
  /** 相对于 Papertable 容纳根目录的分段路径。 */
  relative: string[];
  content: string;
}

/** 挂起中的冲突：[cardId, vault 相对路径]。 */
export type Conflict = [string, string];

export interface VaultBridge {
  /** 桌面版为 true。web 端整个同步 UI 都不该出现。 */
  readonly available: boolean;
  /** 打开系统目录选择器，返回 vault 根目录；取消时返回 null。 */
  chooseVault(): Promise<string | null>;
  sync(input: {
    vault: string;
    notes: NoteWrite[];
    now: number;
  }): Promise<WriteReport[]>;
  rename(input: { vault: string; from: string[]; to: string[] }): Promise<void>;
  remove(input: { vault: string; relative: string[] }): Promise<void>;
  /**
   * 全量重扫并开始监听，返回索引到的笔记数。监听器出问题时重新调用它，就是
   * 「重新扫描知识库」那个按钮。
   */
  watch(vault: string): Promise<number>;
  /** 把 `[[双链]]` 解析成 vault 里的真实笔记：[路径, papertable_id]。 */
  resolveLink(name: string): Promise<[string, string | null][]>;
  indexedCount(): Promise<number>;
  conflicts(): Promise<Conflict[]>;
  /** 「以 Papertable 为准」：清除挂起，下次同步正常覆盖。 */
  resolveConflict(cardId: string): Promise<void>;
  /** 「保留笔记」：给这张卡片立墓碑，此后不再同步。 */
  stopSyncing(cardId: string): Promise<void>;
}
