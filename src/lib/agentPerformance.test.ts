import assert from "node:assert/strict";
import test from "node:test";
import { agentRunPerformance } from "./agentPerformance";

test("performance record whitelists durations and cannot retain sensitive inputs", () => {
  const source = {
    sentAt: 100,
    firstModelRequestAt: 120,
    firstVisibleAt: 180,
    finishedAt: 220,
    prompt: "SECRET_PROMPT",
    toolArguments: '{"path":"/Users/private/note.md"}',
    apiKey: "sk-secret",
    noteBody: "PRIVATE_NOTE_BODY",
  };
  const record = agentRunPerformance(source);
  assert.deepEqual(record, {
    preflightMs: 20,
    firstVisibleMs: 80,
    totalMs: 120,
  });
  assert.deepEqual(Object.keys(record).sort(), [
    "firstVisibleMs",
    "preflightMs",
    "totalMs",
  ]);
  assert.doesNotMatch(
    JSON.stringify(record),
    /SECRET_PROMPT|toolArguments|sk-secret|Users|PRIVATE_NOTE_BODY/,
  );
});

test("host terminal without a model request omits preflight only", () => {
  assert.deepEqual(
    agentRunPerformance({
      sentAt: 100,
      firstVisibleAt: 105,
      finishedAt: 106,
    }),
    { firstVisibleMs: 5, totalMs: 6 },
  );
});
