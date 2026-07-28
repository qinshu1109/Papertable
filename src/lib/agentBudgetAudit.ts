import type { AgentRunTrace, NoteCitation } from "../types";
import {
  AGENT_EVENT_SCHEMA_VERSION,
  type AgentMessage,
  type AgentRunCheckpoint,
  type AppendAgentStepInput,
} from "./agentEvents";
import type { AgentTerminalState } from "./agentTerminal";
import type { AgentBudgetLedger, AgentBudgetRecord } from "./agentBudget";
import type { StopReason } from "./agentTerminal";

export interface AgentAuditPersistence {
  runId: string;
  turnId: string;
  appendStep(input: AppendAgentStepInput): Promise<unknown>;
}

function cloneLedger(ledger: AgentBudgetLedger): AgentBudgetLedger {
  return structuredClone(ledger);
}

function checkpoint(
  trace: AgentRunTrace,
  ledger: AgentBudgetLedger,
  phase: AgentRunCheckpoint["phase"],
  terminal?: AgentTerminalState,
  options: {
    stopReason?: StopReason;
    unresolvedQuestions?: string[];
  } = {},
): AgentRunCheckpoint {
  const stopReason =
    options.stopReason ??
    (terminal?.reason === "no_progress" ? terminal.reason : undefined) ??
    ledger.exhaustionReason;
  return {
    phase,
    objective: "回答用户问题",
    executedSearches: [...trace.searchQueries],
    readChunkIds: [...trace.readChunkIds],
    confirmedCitationChunkIds: [],
    unresolvedQuestions:
      options.unresolvedQuestions ??
      (ledger.exhaustionReason ? [`预算耗尽：${ledger.exhaustionReason}`] : []),
    addedBudget: {},
    budget: cloneLedger(ledger),
    ...(stopReason ? { stopReason } : {}),
    ...(terminal ? { terminal } : {}),
  };
}

async function append(
  persistence: AgentAuditPersistence,
  trace: AgentRunTrace,
  ledger: AgentBudgetLedger,
  id: string,
  occurredAt: number,
  message: AgentMessage,
  phase: AgentRunCheckpoint["phase"],
  terminal?: AgentTerminalState,
  options: {
    stopReason?: StopReason;
    unresolvedQuestions?: string[];
  } = {},
): Promise<void> {
  await persistence.appendStep({
    runId: persistence.runId,
    turnId: persistence.turnId,
    schemaVersion: AGENT_EVENT_SCHEMA_VERSION,
    startedAt: trace.startedAt,
    updatedAt: occurredAt,
    ...(terminal ? { finishedAt: occurredAt } : {}),
    checkpoint: checkpoint(trace, ledger, phase, terminal, options),
    event: {
      id,
      schemaVersion: AGENT_EVENT_SCHEMA_VERSION,
      occurredAt,
      message,
    },
  });
}

export async function appendAgentDuplicateCall(
  persistence: AgentAuditPersistence,
  trace: AgentRunTrace,
  ledger: AgentBudgetLedger,
  signature: string,
  occurrences: number,
  occurredAt: number,
): Promise<void> {
  const stopped = occurrences >= 3;
  const unresolvedQuestions = [
    stopped
      ? "同一成功工具调用再次重复，探索未取得新进展。"
      : "同一成功工具调用已重复，等待模型选择不同操作。",
  ];
  await append(
    persistence,
    trace,
    ledger,
    `${persistence.runId}-duplicate-${signature}-${occurrences}`,
    occurredAt,
    {
      kind: "duplicate-call-detected",
      signature,
      occurrences,
    },
    "repairing",
    undefined,
    {
      ...(stopped ? { stopReason: "no_progress" as const } : {}),
      unresolvedQuestions,
    },
  );
}

export async function appendAgentBudgetStart(
  persistence: AgentAuditPersistence,
  trace: AgentRunTrace,
  ledger: AgentBudgetLedger,
): Promise<void> {
  await append(
    persistence,
    trace,
    ledger,
    `${persistence.runId}-exploration-started`,
    trace.startedAt,
    {
      kind: "exploration-started",
      objective: "回答用户问题",
      mode: trace.mode,
      budget: { ...ledger.limits },
    },
    "exploring",
  );
}

export async function appendAgentBudgetRecord(
  persistence: AgentAuditPersistence,
  trace: AgentRunTrace,
  ledger: AgentBudgetLedger,
  record: AgentBudgetRecord,
): Promise<void> {
  await append(
    persistence,
    trace,
    ledger,
    `${persistence.runId}-budget-${record.sequence}`,
    record.occurredAt,
    {
      kind: "budget-added",
      record: structuredClone(record),
      ledger: cloneLedger(ledger),
      reason: "TASK-005 usage append",
    },
    record.stage === "synthesis" ? "synthesizing" : "exploring",
  );
}

export async function appendAgentBudgetTerminal(
  persistence: AgentAuditPersistence,
  trace: AgentRunTrace,
  terminal: AgentTerminalState,
  occurredAt: number,
  options: {
    answer?: string;
    citations?: NoteCitation[];
  } = {},
): Promise<void> {
  if (!trace.budget) throw new Error("Agent budget ledger is missing");
  const unresolvedQuestions =
    terminal.reason === "no_progress"
      ? ["重复工具调用未取得新进展。"]
      : trace.budget.exhaustionReason
        ? [`预算耗尽：${trace.budget.exhaustionReason}`]
        : [];
  await append(
    persistence,
    trace,
    trace.budget,
    `${persistence.runId}-terminal`,
    occurredAt,
    {
      kind: "terminal",
      terminal,
      ...(options.answer ? { answer: options.answer } : {}),
      citations: options.citations ?? [],
      unresolvedQuestions,
    },
    "terminal",
    terminal,
    { unresolvedQuestions },
  );
}
