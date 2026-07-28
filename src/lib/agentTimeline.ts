import type { AgentBudgetLedger, AgentBudgetLimits } from "./agentBudget";
import type {
  AgentAudit,
  AgentEventRecord,
  AgentEventType,
} from "./agentEvents";
import {
  agentTerminalMessage,
  type AgentRunResult,
  type AgentTerminalState,
  type StopReason,
} from "./agentTerminal";

const MAX_DETAIL_LENGTH = 240;
const MAX_SOURCE_EXCERPT_LENGTH = 420;

export interface AgentTimelineSource {
  key: string;
  title: string;
  relativePath: string;
  excerpt: string;
}

export interface AgentTimelineNode {
  id: string;
  sequence: number;
  kind: AgentEventType;
  occurredAt: number;
  title: string;
  summary: string;
  details: string[];
  sources: AgentTimelineSource[];
  repairMode?: "deterministic" | "model-resend";
}

export interface AgentBudgetPresentationRow {
  dimension: keyof AgentBudgetLimits;
  label: string;
  limit: string;
  used: string;
  remaining: string;
}

export interface AgentRunPresentation {
  state: "running" | "interrupted" | "terminal";
  resultLabel: string;
  reasonLabel: string;
  message: string;
  terminal?: AgentTerminalState;
  truncated: boolean;
  protocolRepairCount: number;
  retryCount: number;
  budget: AgentBudgetPresentationRow[];
}

export interface TrajectoryPromotionDraft {
  title: string;
  sourceText: string;
  sourceBlockText: string;
}

const resultLabels: Record<AgentRunResult, string> = {
  completed: "已完成",
  partial: "部分完成",
  refused: "已拒答",
  failed: "失败",
  aborted: "已中止",
};

const reasonLabels: Record<StopReason, string> = {
  rounds_exhausted: "工具轮次预算耗尽",
  calls_exhausted: "工具调用预算耗尽",
  wall_exhausted: "时间预算耗尽",
  tokens_exhausted: "模型令牌预算耗尽",
  no_progress: "继续探索无新进展",
  protocol_error: "模型协议修复失败",
  user_abort: "用户主动停止",
  insufficient_evidence: "证据不足",
  none: "正常结束",
};

function safeText(value: string, limit = MAX_DETAIL_LENGTH): string {
  const withoutControls = Array.from(value.normalize("NFKC"))
    .filter((character) => {
      const code = character.charCodeAt(0);
      return (
        code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127)
      );
    })
    .join("");
  return withoutControls
    .replace(
      /((?:api[_-]?key|authorization|access[_-]?token|secret)\s*[:=]\s*)\S+/gi,
      "$1[已隐藏]",
    )
    .replace(
      /(?:[a-z]:[\\/]|\/Users\/|\/home\/|\/var\/|\/private\/|\/tmp\/)\S+/gi,
      "[绝对路径已隐藏]",
    )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

export function safeAgentRelativePath(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (
    normalized.startsWith("/") ||
    /^[a-z]:\//i.test(normalized) ||
    normalized.split("/").includes("..")
  )
    return "[路径已隐藏]";
  return safeText(normalized);
}

function repairActionLabel(action: string): string {
  const known: Record<string, string> = {
    "ambiguous-payload-requires-same-model-resend":
      "请求同一模型重发完整工具调用",
    "same-model-resend-produced-complete-legal-call":
      "同一模型重发后通过协议校验",
    "same-protocol-non-stream-produced-complete-legal-call":
      "同协议非流式修复后通过校验",
    "matching-capability-cache-invalidated-and-reprobe-started":
      "失效匹配能力缓存并重新探测",
    "last-stable-checkpoint-retry-produced-complete-legal-call":
      "从最后稳定检查点重试后通过校验",
  };
  return known[action] ?? safeText(action);
}

function terminalEvent(
  audit: Extract<AgentAudit, { kind: "event-sourced" }>,
): Extract<AgentEventRecord["message"], { kind: "terminal" }> | undefined {
  if (audit.run.phase !== "terminal") return undefined;
  const event = [...audit.events]
    .reverse()
    .find((candidate) => candidate.message.kind === "terminal");
  return event?.message.kind === "terminal" ? event.message : undefined;
}

function timelineNode(event: AgentEventRecord): AgentTimelineNode {
  const common = {
    id: event.id,
    sequence: event.sequence,
    kind: event.eventType,
    occurredAt: event.occurredAt,
    details: [] as string[],
    sources: [] as AgentTimelineSource[],
  };
  const message = event.message;
  switch (message.kind) {
    case "exploration-started":
      return {
        ...common,
        title: "开始探索",
        summary:
          message.mode === "native-tools" ? "旗舰原生工具模式" : "双阶段模式",
        details: [
          `目标：${safeText(message.objective)}`,
          ...(message.budget
            ? [
                `初始预算：轮次 ${message.budget.rounds ?? 0} · 调用 ${message.budget.calls ?? 0} · 时间 ${message.budget.wallMs ?? 0}ms · 令牌 ${message.budget.tokens ?? 0}`,
              ]
            : []),
        ],
      };
    case "search-requested":
      return {
        ...common,
        title: "请求搜索",
        summary: `检索「${safeText(message.query)}」`,
        details: [`搜索请求已持久化为步骤 ${event.sequence}。`],
      };
    case "search-completed":
      return {
        ...common,
        title: "搜索完成",
        summary: `${message.hitCount} 个命中`,
        details: [
          `检索：${safeText(message.query)}`,
          `命中数：${message.hitCount}`,
          "搜索命中只属于轨迹，不具引用资格。",
        ],
      };
    case "read-requested":
      return {
        ...common,
        title: "请求读取",
        summary: `${message.chunkIds.length} 个候选片段`,
        details: ["仅读取当前 run 已获宿主授权的候选片段。"],
      };
    case "read-completed":
      return {
        ...common,
        title: "读取完成",
        summary: `${message.sources.length} 个来源`,
        details: [
          `请求 ${message.requestedChunkIds.length} 个片段，实际返回 ${message.sources.length} 个来源。`,
          "下方仅展示已读取来源的安全相对路径与冻结摘录。",
        ],
        sources: message.sources.map((source, index) => ({
          key: `${event.id}:source:${index}`,
          title: safeText(source.title) || "未命名来源",
          relativePath: safeAgentRelativePath(source.relativePath),
          excerpt: safeText(source.text, MAX_SOURCE_EXCERPT_LENGTH),
        })),
      };
    case "duplicate-call-detected":
      return {
        ...common,
        title: "发现重复调用",
        summary: `同一成功调用第 ${message.occurrences} 次出现`,
        details: [
          message.occurrences >= 3
            ? "探索因无新进展转入有界综合。"
            : "本次未重复执行，也未重复消耗调用预算。",
        ],
      };
    case "protocol-repaired":
      return {
        ...common,
        title: message.deterministic ? "确定性协议修复" : "模型重发修复",
        summary: repairActionLabel(message.action),
        details: [
          `问题：${safeText(message.issue)}`,
          `动作：${repairActionLabel(message.action)}`,
          message.deterministic
            ? "此动作只做无歧义的结构清理。"
            : "此动作要求同一模型重发；宿主没有猜测缺失内容。",
        ],
        repairMode: message.deterministic ? "deterministic" : "model-resend",
      };
    case "retry":
      return {
        ...common,
        title: message.attempt === 0 ? "恢复检查点" : "重试",
        summary:
          message.attempt === 0
            ? safeText(message.reason)
            : `第 ${message.attempt} 次 · ${safeText(message.reason)}`,
        details: [
          ...(message.delayMs === undefined
            ? []
            : [`退避等待：${message.delayMs}ms`]),
        ],
      };
    case "budget-added": {
      const dimension = message.record?.dimension;
      const amount = message.record?.amount;
      return {
        ...common,
        title: message.added ? "追加预算" : "预算记账",
        summary: message.added
          ? Object.entries(message.added)
              .map(([key, value]) => `${key} +${value ?? 0}`)
              .join(" · ")
          : `${dimension ?? "预算"} ${amount === null ? "用量未报告" : `+${amount ?? 0}`}`,
        details: [
          message.added
            ? "同一 run 的上限已追加，既有用量不会重置。"
            : `阶段：${message.record?.stage ?? "exploration"}`,
        ],
      };
    }
    case "final-synthesis":
      return {
        ...common,
        title: "最终综合",
        summary: message.stage === "started" ? "开始综合" : "综合完成",
        details: [
          `已读依据步骤：${message.basisEventIds.length}`,
          `未决问题：${message.unresolvedQuestions.length}`,
        ],
      };
    case "terminal":
      return {
        ...common,
        title: "运行终态",
        summary: `${resultLabels[message.terminal.result]} · ${reasonLabels[message.terminal.reason]}`,
        details: [
          agentTerminalMessage(message.terminal),
          `已确认引用：${message.citations.length}`,
          `未决问题：${message.unresolvedQuestions.length}`,
        ],
      };
  }
}

function formatBudgetValue(
  dimension: keyof AgentBudgetLimits,
  value: number | null,
): string {
  if (value === null) return "未报告";
  if (dimension === "wallMs")
    return value >= 1000
      ? `${(value / 1000).toFixed(value % 1000 === 0 ? 1 : 2)} 秒`
      : `${value}ms`;
  return value.toLocaleString("zh-CN");
}

function budgetRows(
  ledger: AgentBudgetLedger | undefined,
): AgentBudgetPresentationRow[] {
  if (!ledger) return [];
  const labels: Record<keyof AgentBudgetLimits, string> = {
    rounds: "轮次",
    calls: "调用",
    wallMs: "时间",
    tokens: "令牌",
  };
  return (["rounds", "calls", "wallMs", "tokens"] as const).map(
    (dimension) => ({
      dimension,
      label: labels[dimension],
      limit: formatBudgetValue(dimension, ledger.limits[dimension]),
      used: formatBudgetValue(dimension, ledger.used[dimension]),
      remaining: formatBudgetValue(dimension, ledger.remaining[dimension]),
    }),
  );
}

export function projectAgentTimeline(audit: AgentAudit | null): {
  nodes: AgentTimelineNode[];
  presentation: AgentRunPresentation | null;
} {
  if (
    audit?.kind !== "event-sourced" ||
    audit.run.schemaVersion !== 1 ||
    audit.events.some((event) => event.schemaVersion !== 1)
  )
    return { nodes: [], presentation: null };

  const events = [...audit.events].sort(
    (left, right) => left.sequence - right.sequence,
  );
  const nodes = events.map(timelineNode);
  const terminal = terminalEvent(audit)?.terminal;
  const repairCount = events.filter(
    (event) => event.message.kind === "protocol-repaired",
  ).length;
  const retryCount = events.filter(
    (event) => event.message.kind === "retry" && event.message.attempt > 0,
  ).length;
  const budget = budgetRows(audit.run.checkpoint.budget);
  if (terminal)
    return {
      nodes,
      presentation: {
        state: "terminal",
        resultLabel: resultLabels[terminal.result],
        reasonLabel: reasonLabels[terminal.reason],
        message: agentTerminalMessage(terminal),
        terminal,
        truncated:
          terminal.result === "partial" &&
          [
            "rounds_exhausted",
            "calls_exhausted",
            "wall_exhausted",
            "tokens_exhausted",
          ].includes(terminal.reason),
        protocolRepairCount: repairCount,
        retryCount,
        budget,
      },
    };

  const interrupted = audit.run.phase === "interrupted";
  return {
    nodes,
    presentation: {
      state: interrupted ? "interrupted" : "running",
      resultLabel: interrupted ? "已中断" : "进行中",
      reasonLabel: interrupted ? "完整步骤边界中断" : "尚未进入合法终态",
      message: interrupted
        ? "运行在最后一个完整步骤边界中断；轨迹与预算已保存，可继续深挖。"
        : "正在从持久化事件流更新本轮探索。",
      truncated: false,
      protocolRepairCount: repairCount,
      retryCount,
      budget,
    },
  };
}

function safeAuditId(value: string): string {
  return /^[a-z0-9._:-]+$/i.test(value) ? value.slice(0, 96) : "[标识已隐藏]";
}

/**
 * Promotion deliberately contains administrative provenance only. It has no
 * source text, search query, protocol payload, NoteCitation, or ReferenceChip.
 */
export function trajectoryPromotionDraft(
  runId: string,
  node: AgentTimelineNode,
): TrajectoryPromotionDraft {
  const stepLabel = `探索轨迹 · 步骤 ${node.sequence}`;
  return {
    title: `${stepLabel} · ${node.title}`.slice(0, 80),
    sourceText: stepLabel,
    sourceBlockText: `持久化 Agent 轨迹回链：run ${safeAuditId(runId)} · event ${safeAuditId(node.id)} · ${node.title}`,
  };
}
