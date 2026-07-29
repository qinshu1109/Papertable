import assert from "node:assert/strict";
import test from "node:test";
import type { Turn } from "../../types";
import { adoptGoldTurn, isGoldEligible } from "./adoption";
import type {
  Verdict,
  VerdictHost,
  VerdictInput,
  VerdictResponse,
  VerdictWriteResult,
} from "./types";

const completeTurn = (overrides: Partial<Turn> = {}): Turn => ({
  id: "turn-1",
  role: "ai",
  content: "完整回答",
  createdAt: 1,
  status: "complete",
  ...overrides,
});

const verdict = (
  id: string,
  input: VerdictInput,
  supersedesMemoryId: string | null = null,
): Verdict => ({
  id,
  ...input,
  status: "confirmed",
  idempotencyKey: `key-${id}`,
  supersedesMemoryId,
});

function host(options: {
  history?: Verdict[];
  failConfirm?: boolean;
  calls: Array<{ kind: string; input?: VerdictInput; id?: string }>;
}): VerdictHost {
  const ok = <T>(data: T): VerdictResponse<T> => ({ available: true, data });
  return {
    health: async () => ok({ available: true, cubeId: "papertable-verdicts" }),
    ensureCube: async () =>
      ok({ cubeId: "papertable-verdicts", created: false }),
    list: async (projectId) => {
      options.calls.push({ kind: "list", id: projectId });
      return ok({
        verdicts: options.history ?? [],
        history: options.history ?? [],
      });
    },
    confirm: async (input) => {
      options.calls.push({ kind: "confirm", input });
      if (options.failConfirm)
        return {
          available: false,
          error: { code: "unavailable", message: "写入失败" },
        };
      return ok<VerdictWriteResult>({
        verdict: verdict("gold-1", input),
        created: true,
      });
    },
    supersede: async (id, input) => {
      options.calls.push({ kind: "supersede", id, input });
      return ok({
        verdict: verdict("gold-2", input, id),
        created: true,
      });
    },
  };
}

test("only complete non-empty AI turns are eligible", () => {
  assert.equal(isGoldEligible(completeTurn()), true);
  for (const turn of [
    completeTurn({ role: "user" }),
    completeTurn({ status: "streaming", streaming: true }),
    completeTurn({ status: "stopped" }),
    completeTurn({ status: "error" }),
    completeTurn({ content: "  " }),
  ])
    assert.equal(isGoldEligible(turn), false);
});

test("confirmed gold carries project, card, turn, conclusion and handle", async () => {
  const calls: Array<{ kind: string; input?: VerdictInput; id?: string }> = [];
  const result = await adoptGoldTurn({
    host: host({ calls }),
    projectId: "project-1",
    cardId: "card-1",
    turn: completeTurn(),
    conclusion: "  一行  结论 ",
    conceptHandle: " 证据纪律 ",
  });
  assert.equal(result.id, "gold-1");
  assert.deepEqual(calls[0], {
    kind: "confirm",
    input: {
      projectId: "project-1",
      verdictType: "gold",
      sourceKind: "turn",
      sourceId: "turn-1",
      sourceCardId: "card-1",
      sourceTurnId: "turn-1",
      content: "一行 结论",
      concepts: ["证据纪律"],
    },
  });
});

test("empty handle and write failure never return a minted verdict", async () => {
  const calls: Array<{ kind: string; input?: VerdictInput; id?: string }> = [];
  await assert.rejects(
    adoptGoldTurn({
      host: host({ calls }),
      projectId: "project-1",
      cardId: "card-1",
      turn: completeTurn(),
      conclusion: "结论",
      conceptHandle: " ",
    }),
    /概念把手不能为空/,
  );
  assert.equal(calls.length, 0);
  await assert.rejects(
    adoptGoldTurn({
      host: host({ calls, failConfirm: true }),
      projectId: "project-1",
      cardId: "card-1",
      turn: completeTurn(),
      conclusion: "结论",
      conceptHandle: "把手",
    }),
    /写入失败/,
  );
});

test("repeat is idempotent while changed content supersedes", async () => {
  const baseInput: VerdictInput = {
    projectId: "project-1",
    verdictType: "gold",
    sourceKind: "turn",
    sourceId: "turn-1",
    sourceCardId: "card-1",
    sourceTurnId: "turn-1",
    content: "旧结论",
    concepts: ["把手"],
  };
  const current = verdict("gold-1", baseInput);
  const turn = completeTurn({ favorite: true, verdictId: current.id });
  const repeatCalls: Array<{
    kind: string;
    input?: VerdictInput;
    id?: string;
  }> = [];
  assert.equal(
    (
      await adoptGoldTurn({
        host: host({ calls: repeatCalls, history: [current] }),
        projectId: "project-1",
        cardId: "card-1",
        turn,
        conclusion: "旧结论",
        conceptHandle: "把手",
      })
    ).id,
    "gold-1",
  );
  assert.deepEqual(
    repeatCalls.map((call) => call.kind),
    ["list"],
  );

  const revisionCalls: Array<{
    kind: string;
    input?: VerdictInput;
    id?: string;
  }> = [];
  const revised = await adoptGoldTurn({
    host: host({ calls: revisionCalls, history: [current] }),
    projectId: "project-1",
    cardId: "card-1",
    turn,
    conclusion: "新结论",
    conceptHandle: "把手",
  });
  assert.equal(revised.supersedesMemoryId, "gold-1");
  assert.deepEqual(
    revisionCalls.map((call) => call.kind),
    ["list", "supersede"],
  );
});

test("revision cannot cross project or lose its original record", async () => {
  const calls: Array<{ kind: string; input?: VerdictInput; id?: string }> = [];
  await assert.rejects(
    adoptGoldTurn({
      host: host({ calls, history: [] }),
      projectId: "project-2",
      cardId: "card-1",
      turn: completeTurn({ verdictId: "foreign" }),
      conclusion: "新结论",
      conceptHandle: "把手",
    }),
    /原采纳记录不可用/,
  );
  assert.deepEqual(
    calls.map((call) => call.kind),
    ["list"],
  );

  const foreignSource = verdict("foreign", {
    projectId: "project-2",
    verdictType: "gold",
    sourceKind: "turn",
    sourceId: "other-turn",
    sourceCardId: "other-card",
    sourceTurnId: "other-turn",
    content: "旧结论",
    concepts: ["把手"],
  });
  await assert.rejects(
    adoptGoldTurn({
      host: host({ calls, history: [foreignSource] }),
      projectId: "project-2",
      cardId: "card-1",
      turn: completeTurn({ verdictId: "foreign" }),
      conclusion: "新结论",
      conceptHandle: "把手",
    }),
    /来源不匹配/,
  );
  assert.equal(calls.filter((call) => call.kind === "supersede").length, 0);
});
