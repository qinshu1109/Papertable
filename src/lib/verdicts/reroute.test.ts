import assert from "node:assert/strict";
import test from "node:test";
import type { InteractionEvent, Turn } from "../../types";
import {
  aggregateRerouteVerdicts,
  cutoffBeforeRerouteRound,
  draftRerouteTombstone,
  extractCutRerouteRounds,
  rewriteRatio,
  verdictLine,
} from "./reroute";

const turn = (
  id: string,
  role: Turn["role"],
  content = id,
  status: Turn["status"] = "complete",
): Turn => ({ id, role, content, status, createdAt: 1 });

test("places a manual reroute cutoff before the selected question", () => {
  const turns = [
    turn("u1", "user"),
    turn("a1", "ai"),
    turn("u2", "user"),
    turn("a2-failed", "ai", "failed", "error"),
    turn("a2", "ai"),
  ];
  assert.equal(cutoffBeforeRerouteRound(turns, "a1"), null);
  assert.equal(cutoffBeforeRerouteRound(turns, "a2"), "a1");
  assert.equal(cutoffBeforeRerouteRound(turns, "missing"), undefined);
  assert.equal(cutoffBeforeRerouteRound([turn("a1", "ai")], "a1"), undefined);
});

test("extracts only complete user/assistant rounds after the explicit cutoff", () => {
  const turns = [
    turn("u1", "user"),
    turn("a1", "ai"),
    turn("u2", "user"),
    turn("a2", "ai"),
    turn("u3", "user"),
    turn("a3", "ai", "partial", "stopped"),
    turn("u4", "user"),
  ];
  assert.deepEqual(
    extractCutRerouteRounds(turns, "a1", "a2").map((round) => [
      round.user.id,
      round.assistant.id,
    ]),
    [["u2", "a2"]],
  );
});

test("uses sourceTurnId as the existing branch cutoff default", () => {
  const turns = [
    turn("u1", "user"),
    turn("a1", "ai"),
    turn("u2", "user"),
    turn("a2", "ai"),
  ];
  assert.deepEqual(
    extractCutRerouteRounds(turns, undefined, "a1").map(
      (round) => round.user.id,
    ),
    ["u2"],
  );
  assert.deepEqual(extractCutRerouteRounds(turns, undefined, "a2"), []);
  assert.deepEqual(
    extractCutRerouteRounds(turns, null, "a2").map((round) => round.user.id),
    ["u1", "u2"],
  );
});

test("edited-question cutoff includes the edited complete round but not an orphan", () => {
  const turns = [
    turn("u1", "user"),
    turn("a1", "ai"),
    turn("edited", "user"),
    turn("answer", "ai"),
    turn("orphan", "user"),
  ];
  assert.deepEqual(
    extractCutRerouteRounds(turns, "a1", "edited").map((round) => [
      round.user.id,
      round.assistant.id,
    ]),
    [["edited", "answer"]],
  );
});

test("verdict-draft contract accepts one safe line and rejects invalid output", async () => {
  assert.equal(verdictLine("  不再默认沿用旧假设。  "), "不再默认沿用旧假设。");
  assert.equal(verdictLine("第一行\n第二行"), null);
  assert.equal(
    await draftRerouteTombstone("材料", async (input) => {
      assert.equal(input.task, "verdict-draft");
      return "旧方向依赖已失效的前提，不再作为默认答案。";
    }),
    "旧方向依赖已失效的前提，不再作为默认答案。",
  );
  await assert.rejects(
    draftRerouteTombstone("材料", async () => "一\n二"),
    /有效的单行文本/,
  );
});

test("aggregates confirmation and first-ten major rewrite/abandon quality", () => {
  const event = (
    type: InteractionEvent["type"],
    card: string,
    createdAt: number,
    editRatio?: number,
  ): InteractionEvent => ({
    id: `${type}-${card}`,
    projectId: "p",
    sessionId: "s",
    type,
    targetCardId: card,
    createdAt,
    ...(editRatio === undefined ? {} : { editRatio }),
  });
  const events = [
    event("reroute-eligible", "a", 1),
    event("tombstone-confirmed", "a", 2),
    event("tombstone-rewritten", "a", 3, 0.2),
    event("reroute-eligible", "b", 4),
    event("tombstone-abandoned", "b", 5),
    event("reroute-eligible", "c", 6),
    event("tombstone-confirmed", "c", 7),
    event("tombstone-rewritten", "c", 8, 0.8),
  ];
  assert.deepEqual(aggregateRerouteVerdicts(events), {
    eligible: 3,
    confirmed: 2,
    rewritten: 2,
    abandoned: 1,
    confirmationRate: 2 / 3,
    firstTenSettled: 3,
    firstTenMajorRewriteOrAbandoned: 2,
  });
  assert.equal(rewriteRatio("完全相同", "完全相同"), 0);
  assert.ok(rewriteRatio("旧方向", "全新结论") >= 0.5);
});
