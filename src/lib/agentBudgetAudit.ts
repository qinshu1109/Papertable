import type { AgentRunTrace, NoteCitation } from "../types";
import type { NoteChunk } from "./notes/types";
import {
  AGENT_EVENT_SCHEMA_VERSION,
  type AgentMessage,
  type AgentRunCheckpoint,
  type AppendAgentStepInput,
} from "./agentEvents";
import type { AgentTerminalState } from "./agentTerminal";
import type { AgentBudgetLedger, AgentBudgetRecord } from "./agentBudget";
import type { StopReason } from "./agentTerminal";
import type { AgentBudgetDelta } from "./agentEvents";

export interface AgentAuditPersistence {
  runId: string;
  turnId: string;
  appendStep(input: AppendAgentStepInput): Promise<unknown>;
  hostScope?: {
    projectId: string;
    libraryIds: string[];
    cardId?: string;
    attachmentScope?: string;
  };
  /** Prevents event-id collisions when one persisted run has several exits. */
  eventIdSuffix?: string;
  objective?: string;
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
    addedBudget?: AgentBudgetDelta;
    confirmedCitationChunkIds?: string[];
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
    confirmedCitationChunkIds: options.confirmedCitationChunkIds ?? [],
    unresolvedQuestions:
      options.unresolvedQuestions ??
      (ledger.exhaustionReason ? [`预算耗尽：${ledger.exhaustionReason}`] : []),
    addedBudget: options.addedBudget ?? {},
    budget: cloneLedger(ledger),
    ...(stopReason ? { stopReason } : {}),
    ...(terminal ? { terminal } : {}),
  };
}

function eventId(persistence: AgentAuditPersistence, base: string): string {
  return persistence.eventIdSuffix
    ? `${base}-${persistence.eventIdSuffix}`
    : base;
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
    addedBudget?: AgentBudgetDelta;
    confirmedCitationChunkIds?: string[];
    expectedLastSequence?: number;
  } = {},
): Promise<void> {
  const nextCheckpoint = checkpoint(trace, ledger, phase, terminal, options);
  if (persistence.objective) nextCheckpoint.objective = persistence.objective;
  if (persistence.hostScope)
    nextCheckpoint.hostScope = {
      projectId: persistence.hostScope.projectId,
      libraryIds: [...persistence.hostScope.libraryIds],
      ...(persistence.hostScope.cardId
        ? { cardId: persistence.hostScope.cardId }
        : {}),
      ...(persistence.hostScope.attachmentScope
        ? { attachmentScope: persistence.hostScope.attachmentScope }
        : {}),
    };
  await persistence.appendStep({
    runId: persistence.runId,
    turnId: persistence.turnId,
    schemaVersion: AGENT_EVENT_SCHEMA_VERSION,
    startedAt: trace.startedAt,
    updatedAt: occurredAt,
    ...(terminal ? { finishedAt: occurredAt } : {}),
    ...(options.expectedLastSequence === undefined
      ? {}
      : { expectedLastSequence: options.expectedLastSequence }),
    checkpoint: nextCheckpoint,
    event: {
      id: eventId(persistence, id),
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

export async function appendAgentSearchRequested(
  persistence: AgentAuditPersistence,
  trace: AgentRunTrace,
  ledger: AgentBudgetLedger,
  query: string,
  callId: string,
  sequence: number,
  occurredAt: number,
): Promise<void> {
  await append(
    persistence,
    trace,
    ledger,
    `${persistence.runId}-search-requested-${sequence}`,
    occurredAt,
    { kind: "search-requested", query, callId },
    "searching",
  );
}

export async function appendAgentSearchCompleted(
  persistence: AgentAuditPersistence,
  trace: AgentRunTrace,
  ledger: AgentBudgetLedger,
  query: string,
  callId: string,
  hitChunkIds: string[],
  sequence: number,
  occurredAt: number,
): Promise<void> {
  await append(
    persistence,
    trace,
    ledger,
    `${persistence.runId}-search-completed-${sequence}`,
    occurredAt,
    {
      kind: "search-completed",
      query,
      callId,
      hitCount: hitChunkIds.length,
      hitChunkIds: [...hitChunkIds],
    },
    "searching",
  );
}

export async function appendAgentReadRequested(
  persistence: AgentAuditPersistence,
  trace: AgentRunTrace,
  ledger: AgentBudgetLedger,
  chunkIds: string[],
  callId: string,
  sequence: number,
  occurredAt: number,
): Promise<void> {
  await append(
    persistence,
    trace,
    ledger,
    `${persistence.runId}-read-requested-${sequence}`,
    occurredAt,
    { kind: "read-requested", chunkIds: [...chunkIds], callId },
    "reading",
  );
}

export async function appendAgentReadCompleted(
  persistence: AgentAuditPersistence,
  trace: AgentRunTrace,
  ledger: AgentBudgetLedger,
  requestedChunkIds: string[],
  chunks: NoteChunk[],
  callId: string,
  sequence: number,
  occurredAt: number,
): Promise<void> {
  await append(
    persistence,
    trace,
    ledger,
    `${persistence.runId}-read-completed-${sequence}`,
    occurredAt,
    {
      kind: "read-completed",
      requestedChunkIds: [...requestedChunkIds],
      callId,
      sources: chunks.map((chunk) => ({
        chunkId: chunk.id,
        libraryId: chunk.libraryId,
        documentId: chunk.documentId,
        title: chunk.titlePath.join(" / "),
        relativePath: chunk.relativePath,
        documentHash: chunk.documentVersionHash,
        text: chunk.text,
      })),
    },
    "reading",
  );
}

export async function appendAgentProtocolAction(
  persistence: AgentAuditPersistence,
  trace: AgentRunTrace,
  ledger: AgentBudgetLedger,
  issue: string,
  action: string,
  sequence: number,
  occurredAt: number,
  deterministic = false,
): Promise<void> {
  await append(
    persistence,
    trace,
    ledger,
    `${persistence.runId}-protocol-${sequence}`,
    occurredAt,
    { kind: "protocol-repaired", issue, action, deterministic },
    "repairing",
  );
}

export async function appendAgentRetry(
  persistence: AgentAuditPersistence,
  trace: AgentRunTrace,
  ledger: AgentBudgetLedger,
  attempt: number,
  reason: string,
  delayMs: number | undefined,
  sequence: number,
  occurredAt: number,
): Promise<void> {
  await append(
    persistence,
    trace,
    ledger,
    `${persistence.runId}-retry-${sequence}`,
    occurredAt,
    {
      kind: "retry",
      attempt,
      reason,
      ...(delayMs === undefined ? {} : { delayMs }),
    },
    "retrying",
  );
}

export async function appendAgentFinalSynthesis(
  persistence: AgentAuditPersistence,
  trace: AgentRunTrace,
  ledger: AgentBudgetLedger,
  stage: "started" | "completed",
  sequence: number,
  occurredAt: number,
): Promise<void> {
  await append(
    persistence,
    trace,
    ledger,
    `${persistence.runId}-final-synthesis-${stage}-${sequence}`,
    occurredAt,
    {
      kind: "final-synthesis",
      stage,
      basisEventIds: trace.readChunkIds.map(
        (chunkId) => `${persistence.runId}-read-${chunkId}`,
      ),
      unresolvedQuestions: ledger.exhaustionReason
        ? [`预算耗尽：${ledger.exhaustionReason}`]
        : [],
    },
    "synthesizing",
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
      objective: persistence.objective ?? "回答用户问题",
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
    {
      unresolvedQuestions,
      confirmedCitationChunkIds: (options.citations ?? []).map(
        (citation) => citation.chunkId,
      ),
    },
  );
}

/**
 * Atomically claims a bounded continuation: the schema-v1 budget-added event
 * and the reopened checkpoint either both commit or neither does.
 */
export async function appendAgentBudgetContinuation(
  persistence: AgentAuditPersistence,
  trace: AgentRunTrace,
  ledger: AgentBudgetLedger,
  added: AgentBudgetDelta,
  expectedLastSequence: number,
  occurredAt: number,
): Promise<void> {
  await append(
    persistence,
    trace,
    ledger,
    `${persistence.runId}-continuation-${expectedLastSequence}`,
    occurredAt,
    {
      kind: "budget-added",
      added: { ...added },
      ledger: cloneLedger(ledger),
      reason: "user-requested same-run continuation",
    },
    "exploring",
    undefined,
    {
      addedBudget: { ...added },
      unresolvedQuestions: [],
      expectedLastSequence,
    },
  );
}

/** Settle a killed in-flight run at its last committed step without ending it. */
export async function appendAgentInterruptedCheckpoint(
  persistence: AgentAuditPersistence,
  trace: AgentRunTrace,
  ledger: AgentBudgetLedger,
  expectedLastSequence: number,
  occurredAt: number,
  addedBudget: AgentBudgetDelta = {},
): Promise<void> {
  await append(
    persistence,
    trace,
    ledger,
    `${persistence.runId}-interrupted-${expectedLastSequence}`,
    occurredAt,
    {
      kind: "retry",
      attempt: 0,
      reason: "interrupted-recovery",
    },
    "interrupted",
    undefined,
    {
      addedBudget: { ...addedBudget },
      unresolvedQuestions: ["运行在完整步骤边界后中断，可从该检查点继续。"],
      expectedLastSequence,
    },
  );
}

/**
 * Reclaims an interrupted continuation whose budget was already committed.
 * This cursor-only event prevents crash/reopen from charging the same
 * continuation twice.
 */
export async function appendAgentInterruptedContinuationClaim(
  persistence: AgentAuditPersistence,
  trace: AgentRunTrace,
  ledger: AgentBudgetLedger,
  addedBudget: AgentBudgetDelta,
  expectedLastSequence: number,
  occurredAt: number,
): Promise<void> {
  await append(
    persistence,
    trace,
    ledger,
    `${persistence.runId}-continuation-recovered-${expectedLastSequence}`,
    occurredAt,
    {
      kind: "retry",
      attempt: 0,
      reason: "interrupted-continuation-resumed",
    },
    "exploring",
    undefined,
    {
      addedBudget: { ...addedBudget },
      unresolvedQuestions: [],
      expectedLastSequence,
    },
  );
}
