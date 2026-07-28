/**
 * Terminal state contract for the bounded Agent run.
 *
 * Result and reason are deliberately separate axes, but they are not freely
 * combinable. This table is the single source of truth for ADR-002's legal
 * combinations. The runtime loop will adopt it in TASK-004; this module does
 * not change current execution behavior.
 *
 * `failed + none` is reserved for an unexpected exception that has no
 * controlled stop reason. The accepted StopReason vocabulary intentionally
 * has no `unexpected_error` member; the concrete error remains separate from
 * the result/reason axes.
 */

export type AgentRunResult =
  "completed" | "partial" | "refused" | "failed" | "aborted";

export type StopReason =
  | "rounds_exhausted"
  | "calls_exhausted"
  | "wall_exhausted"
  | "tokens_exhausted"
  | "no_progress"
  | "protocol_error"
  | "user_abort"
  | "insufficient_evidence"
  | "none";

export const LEGAL_AGENT_TERMINAL_REASONS = {
  completed: ["none"],
  partial: [
    "rounds_exhausted",
    "calls_exhausted",
    "wall_exhausted",
    "tokens_exhausted",
    "no_progress",
  ],
  refused: ["insufficient_evidence"],
  failed: ["protocol_error", "none"],
  aborted: ["user_abort"],
} as const satisfies Record<AgentRunResult, readonly StopReason[]>;

export type AgentTerminalState = {
  [Result in AgentRunResult]: {
    result: Result;
    reason: (typeof LEGAL_AGENT_TERMINAL_REASONS)[Result][number];
  };
}[AgentRunResult];

type AgentTerminalStateKey<
  State extends AgentTerminalState = AgentTerminalState,
> = State extends AgentTerminalState
  ? `${State["result"]}:${State["reason"]}`
  : never;

export const AGENT_TERMINAL_MESSAGES = {
  "completed:none": "已完成本轮探索。",
  "partial:rounds_exhausted":
    "已基于现有证据给出部分结果；工具轮次预算已耗尽。",
  "partial:calls_exhausted": "已基于现有证据给出部分结果；工具调用预算已耗尽。",
  "partial:wall_exhausted": "已基于现有证据给出部分结果；本轮时间预算已耗尽。",
  "partial:tokens_exhausted":
    "已基于现有证据给出部分结果；模型令牌预算已耗尽。",
  "partial:no_progress": "已基于现有证据给出部分结果；继续探索没有取得新进展。",
  "refused:insufficient_evidence":
    "现有材料不足以支持可靠回答，因此本轮未生成无来源结论。",
  "failed:protocol_error":
    "模型协议修复未成功，未生成可能失真的答案；已保留本轮证据与轨迹。",
  "failed:none": "本轮探索因未预期错误失败；已保留可用的证据与轨迹。",
  "aborted:user_abort": "本轮探索已由用户停止。",
} as const satisfies Record<AgentTerminalStateKey, string>;

/**
 * The provider can return no usable content before an Agent answer exists,
 * while the final-answer gate can separately end with no displayable text.
 * TASK-004 will wire these distinct codes into their existing runtime paths.
 */
export type AgentTerminalErrorCode =
  | "provider-empty-response"
  | "final-answer-empty"
  | "unexpected-synthesis-tool-call";

export const AGENT_TERMINAL_ERROR_MESSAGES = {
  "provider-empty-response": "模型服务没有返回可处理的内容，请重试。",
  "final-answer-empty": "模型回答已结束，但没有可显示的最终文本，请重试。",
  "unexpected-synthesis-tool-call":
    "模型在最终综合阶段仍请求调用工具，协议修复后仍未返回最终正文。",
} as const satisfies Record<AgentTerminalErrorCode, string>;

export function isLegalAgentTerminalState(
  result: AgentRunResult,
  reason: StopReason,
): boolean {
  return (
    LEGAL_AGENT_TERMINAL_REASONS[result] as readonly StopReason[]
  ).includes(reason);
}

export function createAgentTerminalState(
  result: AgentRunResult,
  reason: StopReason,
): AgentTerminalState {
  if (!isLegalAgentTerminalState(result, reason))
    throw new TypeError(`Illegal Agent terminal state: ${result}/${reason}`);
  return { result, reason } as AgentTerminalState;
}

export function agentTerminalMessage(state: AgentTerminalState): string {
  const key = `${state.result}:${state.reason}` as AgentTerminalStateKey;
  return AGENT_TERMINAL_MESSAGES[key];
}

export function agentTerminalErrorMessage(
  code: AgentTerminalErrorCode,
): string {
  return AGENT_TERMINAL_ERROR_MESSAGES[code];
}
