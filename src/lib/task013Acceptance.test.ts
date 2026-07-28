import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  replayTask013GoldenFixtures,
  summarizeTask013Rows,
  task013RowsPass,
  task013SemanticDigest,
} from "./task013Acceptance";
import { runTask013DeterministicRuntimeMatrix } from "./task013Runtime";

const outputsRoot = new URL("../../harness-rebuild/outputs/", import.meta.url)
  .pathname;
const manifestPath = new URL(
  "../../harness-rebuild/outputs/task-013/golden-manifest.json",
  import.meta.url,
).pathname;

test("TASK-013 replays every TASK-004 through TASK-012 schema-v1 golden fixture", async () => {
  const rows = await replayTask013GoldenFixtures({
    outputsRoot,
    manifestPath,
  });

  assert.equal(rows.length, 32);
  assert.equal(task013RowsPass(rows), true, JSON.stringify(rows, null, 2));
  assert.deepEqual(summarizeTask013Rows(rows), {
    rows: 32,
    passed: 32,
    failed: 0,
    criteria: {
      "correct-tool-calls": { pass: 13, fail: 0, notApplicable: 19 },
      "correct-terminal-state": { pass: 15, fail: 0, notApplicable: 17 },
      "persisted-evidence": { pass: 32, fail: 0, notApplicable: 0 },
      "no-unauthorized-reads": { pass: 9, fail: 0, notApplicable: 23 },
      "no-unhandled-duplicate-calls": {
        pass: 9,
        fail: 0,
        notApplicable: 23,
      },
      "no-two-stage-on-protocol-failure": {
        pass: 9,
        fail: 0,
        notApplicable: 23,
      },
    },
  });
});

test("TASK-013 semantic projection ignores answer wording but alarms on terminal changes", async () => {
  const fixture = JSON.parse(
    await readFile(
      new URL(
        "../../harness-rebuild/outputs/task-004/rounds-exhausted-partial.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as {
    events: Array<{
      kind: string;
      answer?: string;
      terminal?: { result: string; reason: string };
    }>;
  };
  const original = task013SemanticDigest(fixture);
  const wordingOnly = structuredClone(fixture);
  const terminalEvent = wordingOnly.events.find(
    (event) => event.kind === "terminal",
  );
  assert.ok(terminalEvent);
  terminalEvent.answer = "Different wording with identical acceptance meaning.";
  assert.equal(task013SemanticDigest(wordingOnly), original);

  const semanticChange = structuredClone(fixture);
  const changedTerminal = semanticChange.events.find(
    (event) => event.kind === "terminal",
  )?.terminal;
  assert.ok(changedTerminal);
  changedTerminal.result = "failed";
  changedTerminal.reason = "protocol_error";
  assert.notEqual(task013SemanticDigest(semanticChange), original);
});

test("TASK-013 deterministic runtime matrix covers both fixed exhaustion cases and all six criteria", async () => {
  const rows = await runTask013DeterministicRuntimeMatrix();

  assert.deepEqual(
    rows.map((row) => row.id),
    [
      "natural-convergence",
      "exhaustion-successful-synthesis",
      "exhaustion-failed-repair",
      "no-progress-lure",
      "attachment-citation",
      "protocol-failure-injection",
    ],
  );
  assert.equal(task013RowsPass(rows), true, JSON.stringify(rows, null, 2));
  assert.deepEqual(summarizeTask013Rows(rows), {
    rows: 6,
    passed: 6,
    failed: 0,
    criteria: {
      "correct-tool-calls": { pass: 6, fail: 0, notApplicable: 0 },
      "correct-terminal-state": { pass: 6, fail: 0, notApplicable: 0 },
      "persisted-evidence": { pass: 6, fail: 0, notApplicable: 0 },
      "no-unauthorized-reads": { pass: 6, fail: 0, notApplicable: 0 },
      "no-unhandled-duplicate-calls": {
        pass: 6,
        fail: 0,
        notApplicable: 0,
      },
      "no-two-stage-on-protocol-failure": {
        pass: 6,
        fail: 0,
        notApplicable: 0,
      },
    },
  });
});
