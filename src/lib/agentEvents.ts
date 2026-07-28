import type {
  AgentExecutionMode,
  AgentRunTrace,
  NoteCitation,
  ProviderMessage,
} from "../types";
import type { AgentTerminalState, StopReason } from "./agentTerminal";
import type { AgentBudgetLedger, AgentBudgetRecord } from "./agentBudget";

export const AGENT_EVENT_SCHEMA_VERSION = 1 as const;

export const AGENT_EVENT_TYPES = [
  "exploration-started",
  "search-requested",
  "search-completed",
  "read-requested",
  "read-completed",
  "duplicate-call-detected",
  "protocol-repaired",
  "retry",
  "budget-added",
  "final-synthesis",
  "terminal",
] as const;

export type AgentEventType = (typeof AGENT_EVENT_TYPES)[number];

export type AgentRunPhase =
  | "exploring"
  | "searching"
  | "reading"
  | "repairing"
  | "retrying"
  | "synthesizing"
  | "interrupted"
  | "terminal";

export interface AgentBudgetDelta {
  rounds?: number;
  calls?: number;
  wallMs?: number;
  tokens?: number;
}

/**
 * Source material kept in the complete audit log. It is intentionally richer
 * than a provider message: recovery can rebuild a bounded working set without
 * rereading a changed note, while no provider receives this object directly.
 */
export interface AgentAuditSource {
  chunkId: string;
  libraryId: string;
  documentId: string;
  title: string;
  relativePath: string;
  documentHash: string;
  text: string;
}

/**
 * Complete, structured audit messages. These are persisted as step events and
 * are never treated as provider-wire messages.
 */
export type AgentMessage =
  | {
      kind: "exploration-started";
      objective: string;
      mode: AgentExecutionMode;
      budget?: AgentBudgetDelta;
    }
  | {
      kind: "search-requested";
      query: string;
      callId?: string;
    }
  | {
      kind: "search-completed";
      query: string;
      callId?: string;
      hitCount: number;
      hitChunkIds: string[];
    }
  | {
      kind: "read-requested";
      chunkIds: string[];
      callId?: string;
    }
  | {
      kind: "read-completed";
      requestedChunkIds: string[];
      sources: AgentAuditSource[];
      callId?: string;
    }
  | {
      kind: "duplicate-call-detected";
      signature: string;
      occurrences: number;
    }
  | {
      kind: "protocol-repaired";
      issue: string;
      action: string;
      deterministic: boolean;
    }
  | {
      kind: "retry";
      attempt: number;
      reason: string;
      delayMs?: number;
    }
  | {
      kind: "budget-added";
      /** TASK-005 usage append; the event name stays stable for schema v1. */
      record?: AgentBudgetRecord;
      ledger?: AgentBudgetLedger;
      /** Backward-compatible explicit budget extension for TASK-008. */
      added?: AgentBudgetDelta;
      reason?: string;
    }
  | {
      kind: "final-synthesis";
      stage: "started" | "completed";
      basisEventIds: string[];
      unresolvedQuestions: string[];
    }
  | {
      kind: "terminal";
      terminal: AgentTerminalState;
      answer?: string;
      citations: NoteCitation[];
      unresolvedQuestions: string[];
    };

/**
 * The compact run state updated in the same transaction as each appended
 * event. The event log remains authoritative; this checkpoint is the
 * crash-recovery cursor and may be rebuilt from those events.
 */
export interface AgentRunCheckpoint {
  phase: AgentRunPhase;
  objective: string;
  executedSearches: string[];
  readChunkIds: string[];
  confirmedCitationChunkIds: string[];
  unresolvedQuestions: string[];
  addedBudget: AgentBudgetDelta;
  /** Frozen by the host when the run starts; never accepted from model JSON. */
  hostScope?: {
    projectId: string;
    libraryIds: string[];
  };
  /** TASK-005 persisted per-run ledger; absent only on pre-TASK-005 rows. */
  budget?: AgentBudgetLedger;
  stopReason?: StopReason;
  terminal?: AgentTerminalState;
}

export interface AgentRunRecord {
  id: string;
  turnId: string;
  schemaVersion: typeof AGENT_EVENT_SCHEMA_VERSION;
  phase: AgentRunPhase;
  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
  lastSequence: number;
  checkpoint: AgentRunCheckpoint;
}

export interface AgentEventRecord {
  id: string;
  runId: string;
  sequence: number;
  schemaVersion: typeof AGENT_EVENT_SCHEMA_VERSION;
  eventType: AgentEventType;
  occurredAt: number;
  message: AgentMessage;
}

export interface AppendAgentStepInput {
  runId: string;
  turnId: string;
  schemaVersion: typeof AGENT_EVENT_SCHEMA_VERSION;
  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
  /** Optimistic cursor used to atomically claim one continuation generation. */
  expectedLastSequence?: number;
  checkpoint: AgentRunCheckpoint;
  event: {
    id: string;
    schemaVersion: typeof AGENT_EVENT_SCHEMA_VERSION;
    occurredAt: number;
    message: AgentMessage;
  };
}

export type AgentAudit =
  | {
      kind: "event-sourced";
      run: AgentRunRecord;
      events: AgentEventRecord[];
    }
  | {
      /**
       * Turns created before event-schema v1 stay readable through their old
       * summary trace. Opening a database never manufactures event rows.
       */
      kind: "legacy";
      turnId: string;
      trace: AgentRunTrace | null;
    };

/**
 * Explicit future model-working-set shape from ADR-006. It is deliberately
 * not AgentMessage[]: full audit messages cannot accidentally cross the
 * provider boundary.
 */
export interface AgentWorkingSet {
  objective: string;
  executedSearches: Array<{ query: string; resultEventId: string }>;
  readSources: AgentAuditSource[];
  confirmedCitations: NoteCitation[];
  unresolvedQuestions: string[];
  previousStopReason?: StopReason;
  addedBudget: AgentBudgetDelta;
}

/** Future projection boundary; TASK-003 defines it but does not wire it. */
export type BuildAgentWorkingSet = (
  messages: readonly AgentMessage[],
) => AgentWorkingSet;

/** Future provider conversion boundary; TASK-003 defines it but does not wire it. */
export type ConvertToLlm = (
  workingSet: Readonly<AgentWorkingSet>,
) => ProviderMessage[];

export function isAgentEventType(value: string): value is AgentEventType {
  return (AGENT_EVENT_TYPES as readonly string[]).includes(value);
}
