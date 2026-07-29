import assert from "node:assert/strict";
import test from "node:test";
import type { InteractionEvent } from "../types";
import {
  summarizeTask018Ab,
  summarizeTask018Events,
  validateTask018Cases,
  type Task018AbRun,
} from "./task018Acceptance";

test("requires ten frozen human recurrence rules and never scores model text", () => {
  const cases = Array.from({ length: 10 }, (_, index) => ({
    id: `case-${index}`,
    question: `老问题 ${index}`,
    verdict: `不要复发方向 ${index}`,
    recurrenceRule: `回答把方向 ${index} 作为默认方案即复发`,
  }));
  assert.equal(validateTask018Cases({ cases }).length, 10);
  assert.throws(
    () => validateTask018Cases({ cases: cases.slice(1) }),
    /恰好包含 10 个/,
  );
  assert.throws(
    () =>
      validateTask018Cases({
        cases: cases.map((item, index) =>
          index ? item : { ...item, id: "replace-01" },
        ),
      }),
    /占位内容/,
  );
  const run: Task018AbRun = {
    promptVersion: "verdict-v1",
    generatedAt: "2026-07-29T00:00:00Z",
    provider: { model: "flagship", host: "example.invalid" },
    cases: cases.map((item, index) => ({
      ...item,
      off: { response: "不参与自动评分", recurrence: index < 6 },
      on: { response: "仍不参与自动评分", recurrence: index === 0 },
    })),
  };
  assert.deepEqual(summarizeTask018Ab(run), {
    sampleSize: 10,
    judged: 10,
    offRecurrences: 6,
    onRecurrences: 1,
    recurrenceHalved: true,
    status: "passed",
  });
});

test("event gates stay in progress until real sample counts are reached", () => {
  const event = (
    type: InteractionEvent["type"],
    card: string,
    createdAt: number,
  ): InteractionEvent => ({
    id: `${type}-${card}`,
    projectId: "p",
    sessionId: "s",
    type,
    targetCardId: card,
    createdAt,
  });
  const events = Array.from({ length: 10 }, (_, index) => [
    event("reroute-eligible", String(index), index * 3),
    event("tombstone-confirmed", String(index), index * 3 + 1),
  ]).flat();
  assert.deepEqual(summarizeTask018Events(events), {
    eligible: 10,
    confirmed: 10,
    rewritten: 0,
    abandoned: 0,
    confirmationRate: 1,
    firstTenSettled: 10,
    firstTenMajorRewriteOrAbandoned: 0,
    confirmationGate: "in_progress",
    draftQualityGate: "passed",
  });
});

test("event gates deduplicate retries and ignore orphan settlements", () => {
  const event = (
    type: InteractionEvent["type"],
    projectId: string,
    card: string,
    createdAt: number,
    editRatio?: number,
  ): InteractionEvent => ({
    id: `${type}-${projectId}-${card}-${createdAt}`,
    projectId,
    sessionId: "s",
    type,
    targetCardId: card,
    createdAt,
    ...(editRatio === undefined ? {} : { editRatio }),
  });
  const summary = summarizeTask018Events([
    event("tombstone-confirmed", "orphan", "x", 0),
    event("reroute-eligible", "p1", "same-card-id", 1),
    event("reroute-eligible", "p1", "same-card-id", 2),
    event("tombstone-confirmed", "p1", "same-card-id", 3),
    event("tombstone-confirmed", "p1", "same-card-id", 4),
    event("tombstone-rewritten", "p1", "same-card-id", 5, 0.8),
    event("reroute-eligible", "p2", "same-card-id", 6),
    event("tombstone-abandoned", "p2", "same-card-id", 7),
  ]);
  assert.deepEqual(summary, {
    eligible: 2,
    confirmed: 1,
    rewritten: 1,
    abandoned: 1,
    confirmationRate: 0.5,
    firstTenSettled: 2,
    firstTenMajorRewriteOrAbandoned: 2,
    confirmationGate: "in_progress",
    draftQualityGate: "in_progress",
  });
});
