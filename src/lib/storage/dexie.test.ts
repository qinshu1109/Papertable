import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import test from "node:test";
import {
  applyAttentionChanges,
  applyChanges,
  clearWorkspace,
  db,
  deleteProjectCascade,
  deleteProposals,
  deleteReferences,
  loadAttentionState,
  loadWorkspace,
  putAttentionState,
  saveWorkspace,
  seedIfEmpty,
} from "./dexie";
import { diffAttention, diffWorkspace } from "../delta";
import type { AttentionSnapshot, WorkspaceSnapshot } from "../delta";

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

const freshDb = async () => {
  await db.delete();
  await db.open();
};

test("a streaming save writes exactly one turn row and never rewrites whole tables", () => {
  const before = busySnapshot();
  const after = appendStreamToken(before, "已生成更多文本");
  const upsert = diffWorkspace(before, after);

  // 唯一该落库的就是那条还在生成的轮次。
  assert.equal(upsert.turns.upserts.length, 1);
  assert.equal(upsert.turns.upserts[0].id, "t-stream");
  assert.equal(upsert.turns.upserts[0].content, "已生成更多文本");
  assert.equal(upsert.turns.upserts[0].cardId, "c");

  // 卡片行不含 turns，只有 turns 变化时不该重写；其余表和单例行完全不动。
  assert.deepEqual(upsert.cards, { upserts: [] });
  assert.deepEqual(upsert.projects, { upserts: [] });
  assert.deepEqual(upsert.edges, { upserts: [] });
  assert.deepEqual(upsert.anchors, { upserts: [] });
  assert.deepEqual(upsert.snapshots, { upserts: [] });
  assert.deepEqual(upsert.references, { upserts: [] });
  assert.equal(upsert.view, null);
  assert.equal(upsert.settings, null);
});

test("incremental saves leave untouched rows in place", async () => {
  await freshDb();
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

test("incremental saves round-trip edits without ever deleting a row", async () => {
  await freshDb();
  let persisted = busySnapshot();
  await saveWorkspace(persisted);

  // 1. 改标题：卡片行要重写，轮次不动。
  const renamed: WorkspaceSnapshot = {
    ...persisted,
    cards: persisted.cards.map((card) =>
      card.id === "c2" ? { ...card, title: "改名后的旁支" } : card,
    ),
  };
  const renameUpsert = diffWorkspace(persisted, renamed);
  assert.deepEqual(
    renameUpsert.cards.upserts.map((card: { id: string }) => card.id),
    ["c2"],
  );
  assert.deepEqual(renameUpsert.turns.upserts, []);
  await applyChanges(renameUpsert);
  persisted = renamed;

  // 2. 一张卡片从内存状态里消失，**绝不能**因此被删除。这里原来断言的是
  //    「轮次要跟着删」——那条断言把缺陷写成了需求：删除是从每个标签页私有、
  //    永不与库对账的基线推导出来的，于是一个陈旧的标签页会真删掉另一个标签页
  //    刚建的行。删除现在只能来自 deleteProjectCascade 这类显式意图。
  const shrunk: WorkspaceSnapshot = {
    ...persisted,
    cards: persisted.cards.filter((card) => card.id !== "c2"),
  };
  await applyChanges(diffWorkspace(persisted, shrunk));

  assert.ok(await db.cards.get("c2"), "增量保存绝不删行");
  assert.ok(await db.turns.get("t2"), "增量保存绝不删轮次");
  const restored = await loadWorkspace();
  assert.deepEqual(restored?.cards.map((card) => card.id).sort(), ["c", "c2"]);
  assert.equal(restored?.view.drafts.p, "草稿");
});

test("the upsert contract has no deletes field at all", () => {
  const upsert = diffWorkspace(busySnapshot(), snapshot());
  // 将来有人把推导式删除加回来时，这里会立刻失败。
  for (const [name, table] of Object.entries(upsert)) {
    if (table === null || name === "view" || name === "settings") continue;
    assert.ok(!("deletes" in table), `${name} 不应该有 deletes 字段`);
  }
  const attention = diffAttention(
    { events: [], sessions: [], proposals: [] },
    { events: [], sessions: [], proposals: [] },
  );
  for (const [name, table] of Object.entries(attention))
    assert.ok(!("deletes" in table), `attention.${name} 不应该有 deletes 字段`);
});

test("deleteProjectCascade removes rows no in-memory snapshot ever saw", async () => {
  await freshDb();
  await saveWorkspace(busySnapshot());
  // 另一个标签页刚建的卡片和轮次：本标签页的任何快照里都没有它们。
  await db.cards.put({
    id: "ghost",
    projectId: "p",
    title: "另一个标签页建的",
    favorite: false,
    unread: false,
    concepts: [],
    createdAt: 9,
  });
  await db.turns.put({
    id: "t-ghost",
    cardId: "ghost",
    role: "user",
    content: "另一个标签页写的",
    createdAt: 9,
  });
  // 另一个项目的行必须完好无损。
  await db.projects.put({
    id: "p2",
    name: "别的项目",
    pinned: false,
    updatedAt: 1,
  });
  await db.cards.put({
    id: "c-other",
    projectId: "p2",
    title: "别的项目的卡",
    favorite: false,
    unread: false,
    concepts: [],
    createdAt: 3,
  });

  const removed = await deleteProjectCascade("p");

  assert.equal(await db.cards.get("ghost"), undefined, "级联应按库内容定位");
  assert.equal(await db.turns.get("t-ghost"), undefined);
  assert.equal(await db.cards.get("c"), undefined);
  assert.equal(await db.projects.get("p"), undefined);
  assert.ok(await db.cards.get("c-other"), "不得波及其他项目");
  assert.ok(await db.projects.get("p2"));
  assert.ok(
    removed.workspace.cards.upserts.some((card) => card.id === "ghost"),
    "返回值要包含库里真正删掉的行",
  );
});

test("undo restores what the database held, including other tabs' rows", async () => {
  await freshDb();
  await saveWorkspace(busySnapshot());
  await db.cards.put({
    id: "ghost",
    projectId: "p",
    title: "另一个标签页建的",
    favorite: false,
    unread: false,
    concepts: [],
    createdAt: 9,
  });

  const removed = await deleteProjectCascade("p");
  await applyChanges(removed.workspace);
  await applyAttentionChanges(removed.attention);

  const restored = await loadWorkspace();
  assert.deepEqual(
    restored?.cards.map((card) => card.id).sort(),
    ["c", "c2", "ghost"],
    "撤销要还原库里删除前的内容，而不是本标签页记得的内容",
  );
  assert.equal(
    restored?.cards.find((card) => card.id === "c")?.turns.length,
    2,
  );
});

test("closing one tab must not destroy another tab's sessions and proposals", async () => {
  await freshDb();
  const proposal = (id: string) => ({
    id,
    projectId: "p",
    sessionId: "s1",
    title: "方向",
    explorationQuestion: "接下来先验证什么？",
    reason: "测试",
    sourceAnchorIds: [],
    suggestedParentCardId: "c",
    suggestedRelation: "child" as const,
    evidence: "human-signals" as const,
    status: "queued" as const,
    candidateKey: `card:${id}`,
    signalScore: 6,
    signalEventIds: [],
    createdAt: 10,
    lastSignalAt: 10,
    expiresAt: 20,
    purgeAt: 30,
  });
  const session = (id: string) => ({
    id,
    projectId: "p",
    localDate: "2026-07-27",
    startedAt: 1,
    lastActiveAt: 10,
  });
  await putAttentionState({
    events: [],
    sessions: [session("s1"), session("s2")],
    proposals: [proposal("pr1"), proposal("pr2")],
  });

  // 第二个标签页只知道自己那一份状态，pagehide 时把它写回去。
  await putAttentionState({
    events: [],
    sessions: [session("s1")],
    proposals: [proposal("pr1")],
  });

  const after = await loadAttentionState();
  assert.deepEqual(
    after.proposals.map((row) => row.id).sort(),
    ["pr1", "pr2"],
    "关闭一个标签页不得销毁另一个标签页生成的提案",
  );
  assert.deepEqual(after.sessions.map((row) => row.id).sort(), ["s1", "s2"]);
});

test("proposals and references are removed only by explicit id", async () => {
  await freshDb();
  await saveWorkspace({
    ...snapshot(),
    references: [
      {
        id: "r1",
        projectId: "p",
        sourceTitle: "来源",
        excerpt: "片段",
        anchor: { cardId: "c", text: "片段" },
      },
      {
        id: "r2",
        projectId: "p",
        sourceTitle: "来源二",
        excerpt: "片段二",
        anchor: { cardId: "c", text: "片段二" },
      },
    ],
  });
  await deleteReferences(["r1"]);
  assert.equal(await db.references.get("r1"), undefined);
  assert.ok(await db.references.get("r2"));

  await deleteProposals([]);
  await deleteReferences([]);
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
  const upsert = diffAttention(before, {
    events: [],
    sessions: [],
    proposals: [],
  });
  assert.deepEqual(upsert.events, { upserts: [] });

  const appended = diffAttention(before, {
    ...before,
    events: [event, { ...event, id: "event-2", createdAt: 11 }],
  });
  assert.deepEqual(
    appended.events.upserts.map((entry: { id: string }) => entry.id),
    ["event-2"],
  );
});

test("seeding twice keeps the first seed instead of rewriting it", async () => {
  await freshDb();
  const first = await seedIfEmpty(snapshot());
  assert.equal(first.cards.length, 1);
  await db.cards.put({
    id: "later",
    projectId: "p",
    title: "播种后新增",
    favorite: false,
    unread: false,
    concepts: [],
    createdAt: 5,
  });
  const second = await seedIfEmpty(snapshot());
  assert.deepEqual(
    second.cards.map((card) => card.id).sort(),
    ["c", "later"],
    "第二次播种必须返回库里已有的内容，而不是覆盖它",
  );
});

test("IndexedDB restores cards, drafts and scroll positions", async () => {
  await freshDb();
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
  await freshDb();
  await saveWorkspace(snapshot());
  await putAttentionState({
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
  // This exercises the whole-workspace reset path after v3 migration.
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
