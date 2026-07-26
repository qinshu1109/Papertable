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

test("editing an old user question reroutes before that question instead of leaking it into the new branch", () => {
  const original = [
    ...turns,
    {
      id: "u2",
      role: "user" as const,
      content: "旧问题，不要带入",
      createdAt: 3,
    },
    {
      id: "a2",
      role: "ai" as const,
      content: "旧回答，不要带入",
      createdAt: 4,
    },
  ];
  const cards = [
    card("root", "根", original),
    card("reroute", "改写路径", [
      { id: "new-u", role: "user", content: "改写后的问题", createdAt: 5 },
    ]),
  ];
  const edge: CardEdge = {
    id: "e-reroute",
    type: "branch",
    sourceCardId: "root",
    targetCardId: "reroute",
    // UI 仍指向被编辑的旧问题，但快照明确截止在它之前。
    sourceTurnId: "u2",
    contextCutoffTurnId: "a1",
    contextPolicy: "history-through-turn",
    contextSnapshotId: "s-reroute",
  };
  const built = buildContext({
    cards,
    edges: [edge],
    snapshots: [
      {
        id: "s-reroute",
        edgeId: "e-reroute",
        createdAt: 5,
        sourceTitle: "根",
        sourceTurns: turns,
      },
    ],
    references: [],
    currentCardId: "reroute",
  });
  assert.match(built.messages[0].content, /父回答/);
  assert.doesNotMatch(built.messages[0].content, /旧问题，不要带入/);
  assert.doesNotMatch(built.messages[0].content, /旧回答，不要带入/);
  assert.equal(
    built.messages[built.messages.length - 1]?.content,
    "改写后的问题",
  );
});

test("assistant turns use the OpenAI-compatible assistant role on the wire", () => {
  const built = buildContext({
    cards: [card("root", "根", turns)],
    edges: [],
    snapshots: [],
    references: [],
    currentCardId: "root",
  });
  assert.deepEqual(
    built.messages.slice(1).map((message) => message.role),
    ["user", "assistant"],
  );
});

test("old cards default to general exploration and only the answer-mode instruction changes", () => {
  const edge: CardEdge = {
    id: "mode-edge",
    type: "child",
    sourceCardId: "root",
    targetCardId: "child",
    sourceText: "选区",
    contextPolicy: "topic-and-selection",
    contextSnapshotId: "mode-snapshot",
  };
  const snapshot: ContextSnapshot = {
    id: "mode-snapshot",
    edgeId: "mode-edge",
    createdAt: 1,
    sourceTitle: "根",
    sourceText: "选区",
  };
  const references: ReferenceChip[] = [
    {
      id: "mode-ref",
      projectId: "p",
      sourceTitle: "外部材料",
      excerpt: "按添加顺序保留",
      anchor: { cardId: "external", exact: "按添加顺序保留" },
    },
  ];
  const oldChild = card("child", "子", []);
  const general = buildContext({
    cards: [card("root", "根", turns), oldChild],
    edges: [edge],
    snapshots: [snapshot],
    references,
    currentCardId: "child",
  });
  const sourcesOnly = buildContext({
    cards: [
      card("root", "根", turns),
      { ...oldChild, answerMode: "sources-only" },
    ],
    edges: [edge],
    snapshots: [snapshot],
    references,
    currentCardId: "child",
  });

  assert.equal(general.answerMode, "general");
  assert.match(general.system[0], /可以使用通用知识/);
  assert.match(general.system[0], /区分.*材料.*通用知识.*推断/);
  assert.equal(sourcesOnly.answerMode, "sources-only");
  assert.match(sourcesOnly.system[0], /只能使用下方明确提供的上下文/);
  assert.match(sourcesOnly.system[0], /不得用通用知识补齐结论/);

  assert.deepEqual(general.provenance, sourcesOnly.provenance);
  assert.deepEqual(general.excluded, sourcesOnly.excluded);
  assert.deepEqual(general.system.slice(1), sourcesOnly.system.slice(1));
  assert.deepEqual(general.messages.slice(1), sourcesOnly.messages.slice(1));
});
