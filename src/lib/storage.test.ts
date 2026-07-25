import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import test from "node:test";
import { clearWorkspace, db, loadWorkspace, saveWorkspace } from "./storage";
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
