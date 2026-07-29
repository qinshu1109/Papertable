import assert from "node:assert/strict";
import test from "node:test";
import type { Card } from "../../types";
import type { Verdict } from "./types";
import { buildVerdictLedger } from "./ledger";

const verdict = (
  id: string,
  verdictType: Verdict["verdictType"],
  supersedesMemoryId: string | null = null,
  projectId = "p",
): Verdict => ({
  id,
  projectId,
  verdictType,
  sourceKind: verdictType === "gold" ? "turn" : "edge",
  sourceId: id,
  content: `${id} 的判决`,
  concepts: [id],
  status: "confirmed",
  idempotencyKey: `${id}-key`,
  supersedesMemoryId,
});

test("ledger keeps chain tails, nests old versions and only counts local reuse", () => {
  const old = verdict("old", "tombstone");
  const tail = verdict("tail", "tombstone", old.id);
  const gold = verdict("gold", "gold");
  const foreign = verdict("foreign", "gold", null, "other");
  const cards = [
    {
      id: "card",
      projectId: "p",
      title: "卡片",
      turns: [
        {
          id: "turn",
          role: "ai",
          content: "回答",
          createdAt: 1,
          verdictTrace: {
            promptVersion: "verdict-v1",
            injectionEnabled: true,
            query: "问题",
            availability: "available",
            verdicts: [
              { id: tail.id, verdictType: "tombstone", snapshot: tail.content },
              { id: tail.id, verdictType: "tombstone", snapshot: tail.content },
              { id: old.id, verdictType: "tombstone", snapshot: old.content },
            ],
          },
        },
        {
          id: "ab-off",
          role: "ai",
          content: "关闭注入的回答",
          createdAt: 2,
          verdictTrace: {
            promptVersion: "verdict-v1",
            injectionEnabled: false,
            query: "问题",
            availability: "available",
            verdicts: [
              { id: tail.id, verdictType: "tombstone", snapshot: tail.content },
            ],
          },
        },
      ],
    },
  ] as Card[];
  const ledger = buildVerdictLedger(
    "p",
    {
      verdicts: [tail, gold, foreign],
      history: [old, tail, gold, foreign],
    },
    cards,
  );
  assert.deepEqual(
    ledger.tombstones.map((entry) => ({
      id: entry.verdict.id,
      reuseCount: entry.reuseCount,
      old: entry.superseded.map((item) => [item.verdict.id, item.reuseCount]),
    })),
    [{ id: "tail", reuseCount: 1, old: [["old", 1]] }],
  );
  assert.deepEqual(
    ledger.gold.map((entry) => entry.verdict.id),
    ["gold"],
  );
});
