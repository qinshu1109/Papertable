import assert from "node:assert/strict";
import test from "node:test";
import { buildContext } from "./context";
import type { Card, CardEdge, ContextSnapshot, ReferenceChip } from "../types";

const card = (id: string, title: string, turns: Card["turns"]): Card => ({
  id,
  projectId: "p",
  title,
  turns,
  favorite: false,
  unread: false,
  concepts: [],
  createdAt: 1,
});
const turns = [
  { id: "u1", role: "user" as const, content: "父问题", createdAt: 1 },
  { id: "a1", role: "ai" as const, content: "父回答", createdAt: 2 },
];

test("child context carries a frozen selection but not parent history", () => {
  const cards = [card("root", "根", turns), card("child", "子", [])];
  const edge: CardEdge = {
    id: "e",
    type: "child",
    sourceCardId: "root",
    targetCardId: "child",
    sourceText: "选区",
    contextPolicy: "topic-and-selection",
    contextSnapshotId: "s",
  };
  const snapshots: ContextSnapshot[] = [
    {
      id: "s",
      edgeId: "e",
      createdAt: 1,
      sourceTitle: "根",
      sourceText: "选区",
      sourceBlockText: "原始段落",
    },
  ];
  const built = buildContext({
    cards,
    edges: [edge],
    snapshots,
    references: [],
    currentCardId: "child",
    pendingUserText: "解释",
  });
  assert.match(built.messages[0].content, /精确选区：选区/);
  assert.doesNotMatch(built.messages[0].content, /父回答/);
});

test("divergent context carries only the source title", () => {
  const cards = [card("root", "根", turns), card("div", "发散", [])];
  const edge: CardEdge = {
    id: "e",
    type: "divergent",
    sourceCardId: "root",
    targetCardId: "div",
    contextPolicy: "topic-only",
  };
  const built = buildContext({
    cards,
    edges: [edge],
    snapshots: [],
    references: [],
    currentCardId: "div",
    pendingUserText: "换个方向",
  });
  assert.match(built.messages[0].content, /相关主题：根/);
  assert.doesNotMatch(built.messages[0].content, /父回答/);
});

test("branch context freezes history through its selected turn and preserves explicit reference order", () => {
  const cards = [card("root", "根", turns), card("branch", "改道", [])];
  const edge: CardEdge = {
    id: "e",
    type: "branch",
    sourceCardId: "root",
    targetCardId: "branch",
    sourceTurnId: "a1",
    contextPolicy: "history-through-turn",
    contextSnapshotId: "s",
  };
  const snapshots: ContextSnapshot[] = [
    {
      id: "s",
      edgeId: "e",
      createdAt: 1,
      sourceTitle: "根",
      sourceTurns: turns,
    },
  ];
  const refs: ReferenceChip[] = [
    {
      id: "r1",
      projectId: "p",
      sourceTitle: "资料 A",
      excerpt: "先引用",
      anchor: { cardId: "x", text: "先引用" },
    },
    {
      id: "r2",
      projectId: "p",
      sourceTitle: "资料 B",
      excerpt: "后引用",
      anchor: { cardId: "y", text: "后引用" },
    },
  ];
  const built = buildContext({
    cards,
    edges: [edge],
    snapshots,
    references: refs,
    currentCardId: "branch",
  });
  assert.match(built.messages[0].content, /父回答/);
  assert.ok(
    built.messages[0].content.indexOf("先引用") <
      built.messages[0].content.indexOf("后引用"),
  );
});
