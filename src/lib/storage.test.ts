import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import test from "node:test";
import {
  applyChanges,
  clearWorkspace,
  db,
  diffAttention,
  diffWorkspace,
  loadAttentionState,
  loadWorkspace,
  saveAttentionState,
  saveWorkspace,
} from "./storage";
import type { AttentionSnapshot, WorkspaceSnapshot } from "./storage";

const snapshot = (): WorkspaceSnapshot => ({
  projects: [{ id: "p", name: "测试项目", pinned: false, updatedAt: 1 }],
  cards: [
    {
      id: "c",
      projectId: "p",
      title: "根卡",
      favorite: false,
      unread: false,
      answerMode: "sources-only",
      concepts: [],
      createdAt: 1,
      turns: [
        {
          id: "t",
          role: "user",
          content: "你好",
          createdAt: 1,
          status: "complete",
        },
      ],
    },
  ],
  edges: [],
  anchors: [],
  snapshots: [],
  references: [],
  view: {
    id: "main",
    activeProjectId: "p",
    currentCardId: "c",
    drafts: { p: "草稿" },
    lastCardByProject: { p: "c" },
    collapsed: [],
    scrollPositions: { c: 120 },
  },
  settings: { id: "app", model: "claude-opus-5" },
});

/** 两张卡片、共三条轮次，用来观察一次流式追加到底写了多少行。 */
const busySnapshot = (): WorkspaceSnapshot => {
  const base = snapshot();
  return {
    ...base,
    cards: [
      {
        ...base.cards[0],
        turns: [
          base.cards[0].turns[0],
          {
            id: "t-stream",
            role: "ai",
            content: "已生成",
            createdAt: 2,
            streaming: true,
            status: "streaming",
          },
        ],
      },
      {
        id: "c2",
        projectId: "p",
        title: "旁支卡片",
        favorite: false,
        unread: false,
        concepts: [],
        createdAt: 2,
        turns: [{ id: "t2", role: "user", content: "另一条", createdAt: 2 }],
      },
    ],
  };
};

/** 复刻 store.tsx 的更新惯用法：只有目标卡片和目标轮次换掉引用。 */
const appendStreamToken = (
  previous: WorkspaceSnapshot,
  text: string,
): WorkspaceSnapshot => ({
  ...previous,
  cards: previous.cards.map((card) =>
    card.id === "c"
      ? {
          ...card,
          turns: card.turns.map((turn) =>
            turn.id === "t-stream" ? { ...turn, content: text } : turn,
          ),
        }
      : card,
  ),
});

test("a streaming save writes exactly one turn row and never rewrites whole tables", async () => {
  const before = busySnapshot();
  const after = appendStreamToken(before, "已生成更多文本");
  const delta = diffWorkspace(before, after);

  // 唯一该落库的就是那条还在生成的轮次。
  assert.equal(delta.turns.upserts.length, 1);
  assert.equal(delta.turns.upserts[0].id, "t-stream");
  assert.equal(delta.turns.upserts[0].content, "已生成更多文本");
  assert.equal(delta.turns.upserts[0].cardId, "c");
  assert.deepEqual(delta.turns.deletes, []);

  // 卡片行不含 turns，只有 turns 变化时不该重写；其余表和单例行完全不动。
  assert.deepEqual(delta.cards, { upserts: [], deletes: [] });
  assert.deepEqual(delta.projects, { upserts: [], deletes: [] });
  assert.deepEqual(delta.edges, { upserts: [], deletes: [] });
  assert.deepEqual(delta.anchors, { upserts: [], deletes: [] });
  assert.deepEqual(delta.snapshots, { upserts: [], deletes: [] });
  assert.deepEqual(delta.references, { upserts: [], deletes: [] });
  assert.equal(delta.view, null);
  assert.equal(delta.settings, null);
});

test("incremental saves leave untouched rows in place", async () => {
  await db.delete();
  await db.open();
  const before = busySnapshot();
  await saveWorkspace(before);

  // 一行 store 状态里没有、只存在于库中的卡片。整表重写会把它抹掉。
  await db.cards.put({
    id: "ghost",
    projectId: "p",
    title: "旁路写入",
    favorite: false,
    unread: false,
    concepts: [],
    createdAt: 9,
  });

  await applyChanges(diffWorkspace(before, appendStreamToken(before, "增量")));

  assert.ok(await db.cards.get("ghost"), "增量保存不得清空整表");
  assert.equal((await db.turns.get("t-stream"))?.content, "增量");
  assert.equal((await db.turns.get("t2"))?.content, "另一条");
});

test("incremental saves round-trip edits, additions and cascading deletes", async () => {
  await db.delete();
  await db.open();
  let persisted = busySnapshot();
  await saveWorkspace(persisted);

  // 1. 改标题：卡片行要重写，轮次不动。
  const renamed: WorkspaceSnapshot = {
    ...persisted,
    cards: persisted.cards.map((card) =>
      card.id === "c2" ? { ...card, title: "改名后的旁支" } : card,
    ),
  };
  const renameDelta = diffWorkspace(persisted, renamed);
  assert.deepEqual(
    renameDelta.cards.upserts.map((card) => card.id),
    ["c2"],
  );
  assert.deepEqual(renameDelta.turns.upserts, []);
  await applyChanges(renameDelta);
  persisted = renamed;

  // 2. 删卡片：它的轮次必须跟着删，否则会留下孤儿行。
  const removed: WorkspaceSnapshot = {
    ...persisted,
    cards: persisted.cards.filter((card) => card.id !== "c2"),
  };
  const removeDelta = diffWorkspace(persisted, removed);
  assert.deepEqual(removeDelta.cards.deletes, ["c2"]);
  assert.deepEqual(removeDelta.turns.deletes, ["t2"]);
  await applyChanges(removeDelta);

  const restored = await loadWorkspace();
  assert.deepEqual(
    restored?.cards.map((card) => card.id),
    ["c"],
  );
  assert.equal(restored?.cards[0].turns.length, 2);
  assert.equal(await db.turns.get("t2"), undefined);
  assert.equal(restored?.view.drafts.p, "草稿");
});

test("attention events stay append-only across incremental saves", () => {
  const event = {
    id: "event-1",
    projectId: "p",
    sessionId: "session-1",
    type: "title-edited" as const,
    createdAt: 10,
    targetCardId: "c",
  };
  const before: AttentionSnapshot = {
    events: [event],
    sessions: [],
    proposals: [],
  };
  // 即使状态里不再出现这条事件，增量保存也绝不能删它。
  const delta = diffAttention(before, {
    events: [],
    sessions: [],
    proposals: [],
  });
  assert.deepEqual(delta.events, { upserts: [], deletes: [] });

  const appended = diffAttention(before, {
    ...before,
    events: [event, { ...event, id: "event-2", createdAt: 11 }],
  });
  assert.deepEqual(
    appended.events.upserts.map((entry) => entry.id),
    ["event-2"],
  );
  assert.deepEqual(appended.events.deletes, []);
});

test("IndexedDB restores cards, drafts and scroll positions", async () => {
  await db.delete();
  await db.open();
  await saveWorkspace(snapshot());
  const restored = await loadWorkspace();
  assert.equal(restored?.cards[0].turns[0].content, "你好");
  assert.equal(restored?.view.drafts.p, "草稿");
  assert.equal(restored?.view.scrollPositions.c, 120);
  assert.equal(restored?.cards[0].answerMode, "sources-only");
  await clearWorkspace();
  assert.equal(await loadWorkspace(), null);
});

test("v3 attention tables survive ordinary workspace snapshots and clear with local data", async () => {
  await db.delete();
  await db.open();
  await saveWorkspace(snapshot());
  await saveAttentionState({
    events: [
      {
        id: "event-1",
        projectId: "p",
        sessionId: "session-1",
        type: "title-edited",
        createdAt: 10,
        targetCardId: "c",
      },
    ],
    sessions: [
      {
        id: "session-1",
        projectId: "p",
        localDate: "2026-07-26",
        startedAt: 1,
        lastActiveAt: 10,
      },
    ],
    proposals: [
      {
        id: "proposal-1",
        projectId: "p",
        sessionId: "session-1",
        title: "方向",
        explorationQuestion: "接下来先验证什么？",
        reason: "测试",
        sourceAnchorIds: [],
        suggestedParentCardId: "c",
        suggestedRelation: "child",
        evidence: "human-signals",
        status: "queued",
        candidateKey: "card:c",
        signalScore: 6,
        signalEventIds: ["event-1"],
        createdAt: 10,
        lastSignalAt: 10,
        expiresAt: 20,
        purgeAt: 30,
      },
    ],
  });
  // This exercises the old whole-workspace auto-save path after v3 migration.
  await saveWorkspace(snapshot());
  const attention = await loadAttentionState();
  assert.equal(attention.events.length, 1);
  assert.equal(attention.sessions.length, 1);
  assert.equal(attention.proposals.length, 1);
  assert.equal(db.verno, 3);
  await clearWorkspace();
  const cleared = await loadAttentionState();
  assert.deepEqual(cleared, { events: [], sessions: [], proposals: [] });
});
