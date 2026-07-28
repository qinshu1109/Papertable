import assert from "node:assert/strict";
import test from "node:test";
import type { AgentRunTrace } from "../types";
import {
  consumeAgentBudget,
  createAgentBudgetLedger,
  markAgentBudgetExhausted,
} from "./agentBudget";
import {
  appendAgentDuplicateCall,
  appendAgentBudgetRecord,
  appendAgentBudgetStart,
  appendAgentBudgetTerminal,
  type AgentAuditPersistence,
} from "./agentBudgetAudit";
import type { AppendAgentStepInput } from "./agentEvents";

test("budget audit keeps schema v1 and appends start, usage, terminal in order", async () => {
  const appended: AppendAgentStepInput[] = [];
  const persistence: AgentAuditPersistence = {
    runId: "run-budget",
    turnId: "turn-budget",
    appendStep: async (input) => {
      appended.push(structuredClone(input));
    },
  };
  const ledger = createAgentBudgetLedger({ calls: 1 });
  const trace: AgentRunTrace = {
    mode: "native-tools",
    startedAt: 10,
    finishedAt: 10,
    searchQueries: [],
    hitCount: 0,
    readChunkIds: [],
    budget: ledger,
  };

  await appendAgentBudgetStart(persistence, trace, ledger);
  consumeAgentBudget(ledger, "calls", 1, 11);
  const exhaustion = markAgentBudgetExhausted(ledger, "calls_exhausted", 12);
  await appendAgentBudgetRecord(persistence, trace, ledger, exhaustion);
  await appendAgentBudgetTerminal(
    persistence,
    trace,
    { result: "partial", reason: "calls_exhausted" },
    13,
    { answer: "真实综合" },
  );

  assert.deepEqual(
    appended.map((input) => input.event.message.kind),
    ["exploration-started", "budget-added", "terminal"],
  );
  assert.deepEqual(
    appended.map((input) => input.schemaVersion),
    [1, 1, 1],
  );
  assert.equal(appended[1]?.checkpoint.budget?.remaining.calls, 0);
  assert.equal(appended[2]?.checkpoint.phase, "terminal");
  assert.deepEqual(appended[2]?.checkpoint.terminal, {
    result: "partial",
    reason: "calls_exhausted",
  });
  assert.equal(appended[2]?.finishedAt, 13);
});

test("duplicate-call events persist schema-v1 checkpoints and no-progress terminal state", async () => {
  const appended: AppendAgentStepInput[] = [];
  const persistence: AgentAuditPersistence = {
    runId: "run-duplicate",
    turnId: "turn-duplicate",
    appendStep: async (input) => {
      appended.push(structuredClone(input));
    },
  };
  const ledger = createAgentBudgetLedger();
  const trace: AgentRunTrace = {
    mode: "native-tools",
    startedAt: 10,
    finishedAt: 10,
    searchQueries: ["重复查询"],
    hitCount: 1,
    readChunkIds: ["qualified-evidence"],
    budget: ledger,
  };

  await appendAgentBudgetStart(persistence, trace, ledger);
  await appendAgentDuplicateCall(
    persistence,
    trace,
    ledger,
    "read_notes:stable",
    2,
    11,
  );
  await appendAgentDuplicateCall(
    persistence,
    trace,
    ledger,
    "read_notes:stable",
    3,
    12,
  );
  await appendAgentBudgetTerminal(
    persistence,
    trace,
    { result: "partial", reason: "no_progress" },
    13,
    { answer: "基于已读证据的部分结果" },
  );

  assert.deepEqual(
    appended.map((input) => input.event.message.kind),
    [
      "exploration-started",
      "duplicate-call-detected",
      "duplicate-call-detected",
      "terminal",
    ],
  );
  assert.deepEqual(
    appended.map((input) => input.schemaVersion),
    [1, 1, 1, 1],
  );
  assert.equal(appended[1]?.checkpoint.stopReason, undefined);
  assert.equal(appended[2]?.checkpoint.stopReason, "no_progress");
  assert.deepEqual(appended[2]?.checkpoint.readChunkIds, [
    "qualified-evidence",
  ]);
  assert.deepEqual(appended[3]?.checkpoint.terminal, {
    result: "partial",
    reason: "no_progress",
  });
  assert.equal(appended[3]?.checkpoint.stopReason, "no_progress");
});
