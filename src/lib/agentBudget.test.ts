import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  addAgentBudget,
  assertAgentBudgetInvariants,
  consumeAgentBudget,
  createAgentBudgetLedger,
  markAgentBudgetExhausted,
  recordProviderUsage,
} from "./agentBudget";

test("budget remaining values are derived from limits and used values", () => {
  const ledger = createAgentBudgetLedger({
    rounds: 3,
    calls: 5,
    wallMs: 100,
    tokens: 50,
  });
  consumeAgentBudget(ledger, "rounds", 2, 1);
  consumeAgentBudget(ledger, "calls", 7, 2);
  consumeAgentBudget(ledger, "wallMs", 40, 3);
  recordProviderUsage(
    ledger,
    { inputTokens: 10, outputTokens: 15, totalTokens: 25 },
    4,
    "exploration",
  );

  assert.deepEqual(ledger.used, {
    rounds: 2,
    calls: 7,
    wallMs: 40,
    tokens: 25,
  });
  assert.deepEqual(ledger.remaining, {
    rounds: 1,
    calls: 0,
    wallMs: 60,
    tokens: 25,
  });
  assertAgentBudgetInvariants(ledger);
});

test("unreported or mixed provider usage stays explicitly unknown", () => {
  const unreported = createAgentBudgetLedger();
  recordProviderUsage(unreported, undefined, 1, "exploration");
  assert.equal(unreported.tokenReporting.state, "unreported");
  assert.equal(unreported.used.tokens, null);
  assert.equal(unreported.remaining.tokens, null);

  recordProviderUsage(unreported, { totalTokens: 9 }, 2, "exploration");
  assert.equal(unreported.tokenReporting.state, "partial");
  assert.equal(unreported.tokenReporting.reportedTokens, 9);
  assert.equal(unreported.used.tokens, null);
  assert.equal(unreported.remaining.tokens, null);
  assertAgentBudgetInvariants(unreported);
});

test("budget records are append-only and exhaustion is an explicit record", () => {
  const ledger = createAgentBudgetLedger({ rounds: 1 });
  const first = consumeAgentBudget(ledger, "rounds", 1, 1);
  const frozenFirst = structuredClone(first);
  const exhausted = markAgentBudgetExhausted(ledger, "rounds_exhausted", 2);

  assert.deepEqual(first, frozenFirst);
  assert.deepEqual(
    ledger.records.map((record) => record.sequence),
    [1, 2],
  );
  assert.equal(exhausted.exhaustionReason, "rounds_exhausted");
  assert.equal(ledger.exhaustionReason, "rounds_exhausted");
  assertAgentBudgetInvariants(ledger);
});

test("continuation adds limits without resetting TASK-005 usage", () => {
  const ledger = createAgentBudgetLedger({
    rounds: 1,
    calls: 2,
    wallMs: 100,
    tokens: 50,
  });
  consumeAgentBudget(ledger, "rounds", 1, 1);
  consumeAgentBudget(ledger, "calls", 2, 2);
  markAgentBudgetExhausted(ledger, "rounds_exhausted", 3);
  const records = structuredClone(ledger.records);

  addAgentBudget(ledger, {
    rounds: 2,
    calls: 3,
    wallMs: 50,
    tokens: 25,
  });

  assert.deepEqual(ledger.used, {
    rounds: 1,
    calls: 2,
    wallMs: 0,
    tokens: null,
  });
  assert.deepEqual(ledger.limits, {
    rounds: 3,
    calls: 5,
    wallMs: 150,
    tokens: 75,
  });
  assert.deepEqual(ledger.remaining, {
    rounds: 2,
    calls: 3,
    wallMs: 150,
    tokens: null,
  });
  assert.equal(ledger.exhaustionReason, undefined);
  assert.deepEqual(ledger.records, records, "usage records remain append-only");
  assertAgentBudgetInvariants(ledger);
});

test("legacy hard-coded Agent budget constants are absent from the loop", async () => {
  const source = await readFile(new URL("./agent.ts", import.meta.url), "utf8");
  assert.doesNotMatch(
    source,
    /\bMAX_TOOL_ROUNDS\b|\bMAX_TOOL_CALLS\b|\bMAX_WALL_MS\b/,
  );
});
