import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { LEGACY_EXIT_TERMINAL_MATRIX } from "./agent";
import { isLegalAgentTerminalState } from "./agentTerminal";

const EXPECTED_PATHS = "ABCDEFGHIJKLMNOPQ".split("");

test("the migration matrix covers exactly the 17 legacy A-Q paths", () => {
  assert.deepEqual(Object.keys(LEGACY_EXIT_TERMINAL_MATRIX), EXPECTED_PATHS);
});

for (const [path, terminals] of Object.entries(LEGACY_EXIT_TERMINAL_MATRIX)) {
  test(`legacy exit ${path} maps only to validated legal terminal states`, () => {
    assert.ok(terminals.length > 0);
    for (const terminal of terminals)
      assert.equal(
        isLegalAgentTerminalState(terminal.result, terminal.reason),
        true,
        `${path}: ${terminal.result}/${terminal.reason}`,
      );
  });
}

test("legacy L explicitly separates user abort from wall-time failure", () => {
  assert.deepEqual(LEGACY_EXIT_TERMINAL_MATRIX.L, [
    { result: "aborted", reason: "user_abort" },
    { result: "failed", reason: "none" },
  ]);
});

test("the TASK-013 legacy replay fixture stays synchronized with the executable matrix", async () => {
  const fixture = JSON.parse(
    await readFile(
      new URL(
        "../../harness-rebuild/outputs/task-004/legacy-exit-matrix.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as { paths: typeof LEGACY_EXIT_TERMINAL_MATRIX };
  assert.deepEqual(fixture.paths, LEGACY_EXIT_TERMINAL_MATRIX);
});
