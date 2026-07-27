import assert from "node:assert/strict";
import test from "node:test";
import {
  LIBRARY_BACKUP_SCHEMA,
  backupCounts,
  buildLibraryBackup,
  diffBackupCounts,
  parseLibraryBackup,
} from "./backup";
import type { AttentionSnapshot, WorkspaceSnapshot } from "./delta";

const workspace = (): WorkspaceSnapshot => ({
  projects: [{ id: "p", name: "项目", pinned: false, updatedAt: 1 }],
  cards: [
    {
      id: "c",
      projectId: "p",
      title: "卡片",
      favorite: false,
      unread: false,
      concepts: [],
      createdAt: 1,
      turns: [
        { id: "t1", role: "user", content: "问", createdAt: 1 },
        { id: "t2", role: "ai", content: "答", createdAt: 2 },
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
    scrollPositions: { c: 42 },
  },
  settings: { id: "app", model: "claude-opus-5" },
});

const attention = (): AttentionSnapshot => ({
  events: [
    {
      id: "e1",
      projectId: "p",
      sessionId: "s1",
      type: "title-edited",
      createdAt: 10,
      targetCardId: "c",
    },
  ],
  sessions: [
    {
      id: "s1",
      projectId: "p",
      localDate: "2026-07-27",
      startedAt: 1,
      lastActiveAt: 10,
    },
  ],
  proposals: [],
});

const sample = () =>
  buildLibraryBackup({
    workspace: workspace(),
    attention: attention(),
    exportedAt: 1785000000000,
  });

test("a library backup round-trips through JSON without losing a row", () => {
  const backup = sample();
  const restored = parseLibraryBackup(JSON.stringify(backup));
  assert.deepEqual(restored, backup);
  // 这是 S2 首启导入后必须在 UI 上展示的那个校验。
  assert.deepEqual(diffBackupCounts(backup, restored), {
    equal: true,
    mismatches: [],
  });
});

test("it carries the tables the per-project bundle export leaves out", () => {
  const restored = parseLibraryBackup(JSON.stringify(sample()));
  // view / settings / 注意力三表正是迁移必须带上、而按项目导出不含的部分。
  assert.equal(restored.workspace.view.drafts.p, "草稿");
  assert.equal(restored.workspace.view.scrollPositions.c, 42);
  assert.equal(restored.workspace.settings.model, "claude-opus-5");
  assert.equal(restored.attention.events.length, 1);
  assert.equal(restored.attention.sessions.length, 1);
  assert.equal(backupCounts(restored).turns, 2);
});

test("v2 full backup preserves card answer mode and imported read-only corpus", () => {
  const richWorkspace = workspace();
  richWorkspace.cards[0].answerMode = "sources-only";
  const backup = buildLibraryBackup({
    workspace: richWorkspace,
    attention: attention(),
    exportedAt: 1785000000000,
    noteCorpus: {
      libraries: [
        {
          id: "library-a",
          name: "研究资料",
          kind: "web-import",
          createdAt: 1,
          updatedAt: 2,
        },
      ],
      documents: [
        {
          id: "document-a",
          libraryId: "library-a",
          relativePath: "研究/唯一事实.md",
          content: "唯一事实只能由资料库检索到。",
          updatedAt: 2,
        },
      ],
      bindings: [{ projectId: "p", libraryId: "library-a" }],
    },
  });

  const restored = parseLibraryBackup(JSON.stringify(backup));
  assert.equal(restored.schema, LIBRARY_BACKUP_SCHEMA);
  assert.equal(restored.workspace.cards[0].answerMode, "sources-only");
  assert.deepEqual(restored.noteCorpus, backup.noteCorpus);
  assert.deepEqual(backupCounts(restored), {
    projects: 1,
    cards: 1,
    turns: 2,
    edges: 0,
    anchors: 0,
    snapshots: 0,
    references: 0,
    events: 1,
    sessions: 1,
    proposals: 0,
    noteLibraries: 1,
    noteDocuments: 1,
  });
});

test("a dropped table is reported instead of silently importing half a library", () => {
  const backup = sample();
  const damaged = structuredClone(backup);
  damaged.workspace.cards = [];
  const result = diffBackupCounts(backup, damaged);
  assert.equal(result.equal, false);
  assert.deepEqual(result.mismatches, [
    "cards: 期望 1，实际 0",
    "turns: 期望 2，实际 0",
  ]);
});

test("malformed or wrong-version backups are refused before any write", () => {
  assert.throws(() => parseLibraryBackup("{"), /不是合法 JSON/);
  assert.throws(
    () => parseLibraryBackup(JSON.stringify({ ...sample(), schema: 99 })),
    /只认 1/,
  );
  assert.throws(
    () =>
      parseLibraryBackup(
        JSON.stringify({ schema: LIBRARY_BACKUP_SCHEMA, exportedAt: "x" }),
      ),
    /缺少工作区数据/,
  );
  const noAttention = JSON.stringify({
    schema: LIBRARY_BACKUP_SCHEMA,
    exportedAt: "x",
    workspace: workspace(),
  });
  assert.throws(() => parseLibraryBackup(noAttention), /缺少注意力实验数据/);
});
