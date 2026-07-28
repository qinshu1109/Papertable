import type { StopReason } from "./agentTerminal";

export const AGENT_BUDGET_SCHEMA_VERSION = 1 as const;

export interface AgentBudgetLimits {
  rounds: number;
  calls: number;
  wallMs: number;
  tokens: number;
}

export const DEFAULT_AGENT_BUDGET_LIMITS: Readonly<AgentBudgetLimits> =
  Object.freeze({
    rounds: 4,
    calls: 8,
    wallMs: 120_000,
    tokens: 32_000,
  });

export type AgentBudgetDimension = keyof AgentBudgetLimits;
export type AgentBudgetExhaustionReason = Extract<
  StopReason,
  "rounds_exhausted" | "calls_exhausted" | "wall_exhausted" | "tokens_exhausted"
>;

export interface ProviderUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens: number;
}

export type TokenReportingState = "unreported" | "partial" | "reported";

export interface AgentBudgetRecord {
  sequence: number;
  occurredAt: number;
  dimension: AgentBudgetDimension;
  amount: number | null;
  source: "agent" | "clock" | "provider" | "provider-unreported";
  stage: "exploration" | "synthesis";
  usage?: ProviderUsage;
  exhaustionReason?: AgentBudgetExhaustionReason;
}

export interface AgentBudgetLedger {
  schemaVersion: typeof AGENT_BUDGET_SCHEMA_VERSION;
  limits: AgentBudgetLimits;
  used: {
    rounds: number;
    calls: number;
    wallMs: number;
    /** Null means at least one provider request did not report usage. */
    tokens: number | null;
  };
  remaining: {
    rounds: number;
    calls: number;
    wallMs: number;
    /** Null means a truthful remaining token value cannot be calculated. */
    tokens: number | null;
  };
  tokenReporting: {
    state: TokenReportingState;
    reportedTokens: number;
    reportedRequests: number;
    unreportedRequests: number;
  };
  exhaustionReason?: AgentBudgetExhaustionReason;
  records: AgentBudgetRecord[];
}

function finiteNonNegative(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0)
    throw new Error(`Invalid Agent budget ${name}`);
  return Math.floor(value);
}

export function createAgentBudgetLedger(
  overrides: Partial<AgentBudgetLimits> = {},
): AgentBudgetLedger {
  const limits: AgentBudgetLimits = {
    rounds: finiteNonNegative(
      overrides.rounds ?? DEFAULT_AGENT_BUDGET_LIMITS.rounds,
      "rounds",
    ),
    calls: finiteNonNegative(
      overrides.calls ?? DEFAULT_AGENT_BUDGET_LIMITS.calls,
      "calls",
    ),
    wallMs: finiteNonNegative(
      overrides.wallMs ?? DEFAULT_AGENT_BUDGET_LIMITS.wallMs,
      "wallMs",
    ),
    tokens: finiteNonNegative(
      overrides.tokens ?? DEFAULT_AGENT_BUDGET_LIMITS.tokens,
      "tokens",
    ),
  };
  return {
    schemaVersion: AGENT_BUDGET_SCHEMA_VERSION,
    limits,
    used: { rounds: 0, calls: 0, wallMs: 0, tokens: null },
    remaining: {
      rounds: limits.rounds,
      calls: limits.calls,
      wallMs: limits.wallMs,
      tokens: null,
    },
    tokenReporting: {
      state: "unreported",
      reportedTokens: 0,
      reportedRequests: 0,
      unreportedRequests: 0,
    },
    records: [],
  };
}

function appendRecord(
  ledger: AgentBudgetLedger,
  record: Omit<AgentBudgetRecord, "sequence" | "exhaustionReason">,
): AgentBudgetRecord {
  const exhaustionReason = ledger.exhaustionReason;
  const appended: AgentBudgetRecord = {
    ...record,
    sequence: ledger.records.length + 1,
    ...(exhaustionReason ? { exhaustionReason } : {}),
  };
  ledger.records.push(appended);
  return appended;
}

export function consumeAgentBudget(
  ledger: AgentBudgetLedger,
  dimension: Exclude<AgentBudgetDimension, "tokens">,
  amount: number,
  occurredAt: number,
  stage: AgentBudgetRecord["stage"] = "exploration",
): AgentBudgetRecord {
  const normalized = finiteNonNegative(amount, dimension);
  ledger.used[dimension] += normalized;
  ledger.remaining[dimension] = Math.max(
    0,
    ledger.limits[dimension] - ledger.used[dimension],
  );
  return appendRecord(ledger, {
    occurredAt,
    dimension,
    amount: normalized,
    source: dimension === "wallMs" ? "clock" : "agent",
    stage,
  });
}

export function recordProviderUsage(
  ledger: AgentBudgetLedger,
  usage: ProviderUsage | undefined,
  occurredAt: number,
  stage: AgentBudgetRecord["stage"],
): AgentBudgetRecord {
  if (usage) {
    const totalTokens = finiteNonNegative(usage.totalTokens, "tokens");
    ledger.tokenReporting.reportedTokens += totalTokens;
    ledger.tokenReporting.reportedRequests += 1;
    ledger.tokenReporting.state =
      ledger.tokenReporting.unreportedRequests > 0 ? "partial" : "reported";
    ledger.used.tokens =
      ledger.tokenReporting.state === "reported"
        ? ledger.tokenReporting.reportedTokens
        : null;
    ledger.remaining.tokens =
      ledger.used.tokens === null
        ? null
        : Math.max(0, ledger.limits.tokens - ledger.used.tokens);
    return appendRecord(ledger, {
      occurredAt,
      dimension: "tokens",
      amount: totalTokens,
      source: "provider",
      stage,
      usage,
    });
  }

  ledger.tokenReporting.unreportedRequests += 1;
  ledger.tokenReporting.state =
    ledger.tokenReporting.reportedRequests > 0 ? "partial" : "unreported";
  ledger.used.tokens = null;
  ledger.remaining.tokens = null;
  return appendRecord(ledger, {
    occurredAt,
    dimension: "tokens",
    amount: null,
    source: "provider-unreported",
    stage,
  });
}

export function markAgentBudgetExhausted(
  ledger: AgentBudgetLedger,
  reason: AgentBudgetExhaustionReason,
  occurredAt: number,
  stage: AgentBudgetRecord["stage"] = "exploration",
): AgentBudgetRecord {
  ledger.exhaustionReason ??= reason;
  const dimension: AgentBudgetDimension =
    reason === "rounds_exhausted"
      ? "rounds"
      : reason === "calls_exhausted"
        ? "calls"
        : reason === "wall_exhausted"
          ? "wallMs"
          : "tokens";
  return appendRecord(ledger, {
    occurredAt,
    dimension,
    amount: 0,
    source: dimension === "wallMs" ? "clock" : "agent",
    stage,
  });
}

export function assertAgentBudgetInvariants(ledger: AgentBudgetLedger): void {
  for (const dimension of ["rounds", "calls", "wallMs"] as const) {
    if (
      ledger.remaining[dimension] !==
      Math.max(0, ledger.limits[dimension] - ledger.used[dimension])
    )
      throw new Error(`Agent budget remaining invariant failed: ${dimension}`);
  }
  if (
    (ledger.used.tokens === null) !== (ledger.remaining.tokens === null) ||
    (ledger.used.tokens !== null &&
      ledger.remaining.tokens !==
        Math.max(0, ledger.limits.tokens - ledger.used.tokens))
  )
    throw new Error("Agent budget remaining invariant failed: tokens");
  ledger.records.forEach((record, index) => {
    if (record.sequence !== index + 1)
      throw new Error("Agent budget record sequence is not append-only");
  });
}
