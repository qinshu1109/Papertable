import assert from "node:assert/strict";
import test from "node:test";
import type { Card, CardEdge, ContextSnapshot, SourceAnchor } from "../types";
import {
  createdCardPersistenceUpsert,
  persistCreatedCardBeforeGeneration,
} from "./cardCreation";

const card: Card = {
  id: "child",
  projectId: "project",
  title: "深挖卡",
  favorite: false,
  unread: false,
  createdAt: 1,
  concepts: [],
  turns: [
    {
      id: "question",
      role: "user",
      content: "继续深挖",
      createdAt: 1,
      status: "complete",
    },
  ],
};

const edge: CardEdge = {
  id: "edge",
  type: "child",
  sourceCardId: "root",
  targetCardId: card.id,
  contextSnapshotId: "snapshot",
  contextPolicy: "topic-and-selection",
};

const snapshot: ContextSnapshot = {
  id: "snapshot",
  edgeId: edge.id,
  createdAt: 1,
  sourceTitle: "根卡",
};

const anchor: SourceAnchor = {
  id: "anchor",
  cardId: "root",
  text: "来源",
  exact: "来源",
  sourceRevision: "root:1",
};

test("created card persistence contains the parent row and seeded turn in one upsert", () => {
  const upsert = createdCardPersistenceUpsert({
    card,
    edge,
    snapshot,
    anchor,
  });

  assert.deepEqual(
    upsert.cards.upserts.map((row) => row.id),
    ["child"],
  );
  assert.deepEqual(upsert.turns.upserts, [
    {
      ...card.turns[0],
      cardId: "child",
    },
  ]);
  assert.deepEqual(upsert.edges.upserts, [edge]);
  assert.deepEqual(upsert.snapshots.upserts, [snapshot]);
  assert.deepEqual(upsert.anchors.upserts, [anchor]);
});

test("generation starts only after the created card transaction succeeds", async () => {
  const order: string[] = [];
  const upsert = createdCardPersistenceUpsert({ card, edge, snapshot });

  await persistCreatedCardBeforeGeneration({
    upsert,
    persist: async () => {
      order.push("persist-start");
      await Promise.resolve();
      order.push("persist-complete");
    },
    startGeneration: () => {
      order.push("generation-start");
    },
  });

  assert.deepEqual(order, [
    "persist-start",
    "persist-complete",
    "generation-start",
  ]);
});

test("a failed created-card transaction never starts generation", async () => {
  let started = false;
  const upsert = createdCardPersistenceUpsert({ card, edge, snapshot });

  await assert.rejects(
    persistCreatedCardBeforeGeneration({
      upsert,
      persist: async () => {
        throw new Error("write failed");
      },
      startGeneration: () => {
        started = true;
      },
    }),
    /write failed/,
  );

  assert.equal(started, false);
});
