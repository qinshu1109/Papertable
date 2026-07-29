/**
 * 通用记忆仍保持显式 Noop。用户确认的判决使用 `lib/verdicts` 的窄接口；
 * 它不向模型暴露写入或删除能力，也不会把 MemOS 变成通用 Agent 工具。
 */
export interface MemoryQuery {
  projectId: string;
  query: string;
  limit?: number;
}

export interface MemoryHit {
  id: string;
  source: string;
  content: string;
  createdAt: number;
  status: "provisional" | "confirmed" | "note-index";
  reason: string;
}

export interface MemoryCapsule {
  idempotencyKey: string;
  projectId: string;
  content: string;
}

export interface MemoryRef {
  id: string;
}

export interface MemoryFeedback {
  memoryId: string;
  kind: "irrelevant" | "stale" | "incorrect" | "recall-miss";
}

export interface MemoryHealth {
  available: boolean;
  message: string;
}

export interface MemoryProvider {
  search(query: MemoryQuery): Promise<MemoryHit[]>;
  writeCapsule(input: MemoryCapsule): Promise<MemoryRef>;
  feedback(input: MemoryFeedback): Promise<void>;
  health(): Promise<MemoryHealth>;
}

/** 第一阶段的显式空实现，防止 UI 或核心逻辑偷接 MemOS。 */
export class NoopProvider implements MemoryProvider {
  async search(): Promise<MemoryHit[]> {
    return [];
  }

  async writeCapsule(input: MemoryCapsule): Promise<MemoryRef> {
    return { id: `noop:${input.idempotencyKey}` };
  }

  async feedback(): Promise<void> {
    return undefined;
  }

  async health(): Promise<MemoryHealth> {
    return { available: false, message: "第一阶段未连接记忆服务" };
  }
}
