import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import test from "node:test";
import {
  clearWorkspace,
  db,
  loadAttentionState,
  loadWorkspace,
  saveAttentionState,
  saveWorkspace,
} from "./storage";
import type { WorkspaceSnapshot } from "./storage";

const snapshot = (): WorkspaceSnapshot => ({
  projects: [{ id: "p", name: "测试项目", pinned: false, updatedAt: 1 }],
  cards: [
    {
      id: "c",
      projectId: "p",
      title: "根卡",
      favorite: false,
      unread: false,
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

test("IndexedDB restores cards, drafts and scroll positions", async () => {
  await db.delete();
  await db.open();
  await saveWorkspace(snapshot());
  const restored = await loadWorkspace();
  assert.equal(restored?.cards[0].turns[0].content, "你好");
  assert.equal(restored?.view.drafts.p, "草稿");
  assert.equal(restored?.view.scrollPositions.c, 120);
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
