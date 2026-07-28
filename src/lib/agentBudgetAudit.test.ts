import assert from "node:assert/strict";
import test from "node:test";
import type { AgentRunTrace } from "../types";
import {
  consumeAgentBudget,
  createAgentBudgetLedger,
  markAgentBudgetExhausted,
} from "./agentBudget";
import {
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
