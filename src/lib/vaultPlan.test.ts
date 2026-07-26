import assert from "node:assert/strict";
import test from "node:test";
import { planProjectSync, syncableCards, vaultRelativeDir } from "./vaultPlan";
import type { Card, CardEdge, Project, TurnStatus } from "../types";

const project: Project = {
  id: "p",
  name: "量子计算机与极低温",
  pinned: false,
  updatedAt: 1,
};

const card = (input: {
  id: string;
  title: string;
  status?: TurnStatus;
  question?: string;
  answer?: string;
  trashed?: boolean;
}): Card => ({
  id: input.id,
  projectId: "p",
  title: input.title,
  favorite: false,
  unread: false,
  concepts: [],
  createdAt: 1,
  trashed: input.trashed,
  turns: [
    {
      id: `${input.id}-u`,
      role: "user",
      content: input.question ?? "问题",
      createdAt: 1,
    },
    {
      id: `${input.id}-a`,
      role: "ai",
      content: input.answer ?? "## 小节\n\n答案正文。",
      createdAt: 2,
      status: input.status ?? "complete",
    },
  ],
});

const plan = (cards: Card[], edges: CardEdge[] = []) =>
  planProjectSync({ project, cards, edges, syncedAt: 1785000000000 });

test("only completed, untrashed cards are written", () => {
  const cards = [
    card({ id: "c1", title: "完成的" }),
    card({ id: "c2", title: "生成中的", status: "streaming" }),
    card({ id: "c3", title: "出错的", status: "error" }),
    card({ id: "c4", title: "停止的", status: "stopped" }),
    card({ id: "c5", title: "回收站里的", trashed: true }),
  ];
  assert.deepEqual(
    syncableCards(cards, "p").map((c) => c.id),
    ["c1"],
    "半句话的笔记比没有笔记更糟",
  );
  const notes = plan(cards);
  // 一篇卡片 + _索引.md + _关系.canvas
  assert.equal(notes.length, 3);
  assert.deepEqual(notes[0].relative, ["量子计算机与极低温", "完成的.md"]);
});

/**
 * `Turn.status` 是可选的：导入的、demo 播种的、早期版本留下的轮次都没有它。
 * 要求 `status === "complete"` 会把这些卡片全部悄悄排除，真机表现是开了同步却一个
 * 文件都不写、也不报错。
 */
test("cards without an explicit status still count as deliverable", () => {
  const legacy: Card = {
    id: "c-legacy",
    projectId: "p",
    title: "导入进来的卡片",
    favorite: false,
    unread: false,
    concepts: [],
    createdAt: 1,
    turns: [
      { id: "u", role: "user", content: "问题", createdAt: 1 },
      { id: "a", role: "ai", content: "答案正文。", createdAt: 2 },
    ],
  };
  assert.deepEqual(
    syncableCards([legacy], "p").map((c) => c.id),
    ["c-legacy"],
  );
});

test("a card whose only answer is empty is not written", () => {
  const blank: Card = {
    id: "c-blank",
    projectId: "p",
    title: "空的",
    favorite: false,
    unread: false,
    concepts: [],
    createdAt: 1,
    turns: [
      { id: "u", role: "user", content: "问题", createdAt: 1 },
      { id: "a", role: "ai", content: "   ", createdAt: 2 },
    ],
  };
  assert.deepEqual(syncableCards([blank], "p"), []);
});

test("an empty project writes nothing at all", () => {
  assert.deepEqual(
    plan([card({ id: "c", title: "生成中", status: "streaming" })]),
    [],
  );
});

test("filenames drop the id suffix unless titles actually collide", () => {
  const unique = plan([
    card({ id: "c1", title: "退相干" }),
    card({ id: "c2", title: "波函数" }),
  ]);
  assert.deepEqual(unique[0].relative[1], "退相干.md");
  assert.deepEqual(unique[1].relative[1], "波函数.md");

  const collide = plan([
    card({ id: "card-aaaaaaaa", title: "同名" }),
    card({ id: "card-bbbbbbbb", title: "同名" }),
  ]);
  assert.deepEqual(collide[0].relative[1], "同名-aaaaaaaa.md");
  assert.deepEqual(collide[1].relative[1], "同名-bbbbbbbb.md");
});

test("project-level artefacts carry no cardId so they never suspend on conflict", () => {
  const notes = plan([card({ id: "c1", title: "卡片" })]);
  const index = notes.find((n) => n.relative[1] === "_索引.md")!;
  const canvas = notes.find((n) => n.relative[1] === "_关系.canvas")!;
  assert.equal(index.cardId, null);
  assert.equal(canvas.cardId, null);
  assert.equal(notes.find((n) => n.relative[1] === "卡片.md")!.cardId, "c1");
});

test("the canvas references vault-relative paths that match the notes written", () => {
  const cards = [
    card({ id: "c1", title: "根" }),
    card({ id: "c2", title: "子" }),
  ];
  const edges: CardEdge[] = [
    {
      id: "e1",
      type: "child",
      sourceCardId: "c1",
      targetCardId: "c2",
      contextPolicy: "topic-and-selection",
    },
  ];
  const notes = plan(cards, edges);
  const canvas = JSON.parse(
    notes.find((n) => n.relative[1] === "_关系.canvas")!.content,
  ) as { nodes: { file: string }[]; edges: { label: string }[] };

  const written = new Set(
    notes
      .filter((n) => n.relative[1].endsWith(".md"))
      .map((n) => `${vaultRelativeDir(project)}/${n.relative[1]}`),
  );
  for (const node of canvas.nodes)
    assert.ok(
      written.has(node.file),
      `canvas 指向了不存在的文件：${node.file}`,
    );
  assert.deepEqual(
    canvas.edges.map((e) => e.label),
    ["深挖"],
  );
});

test("edges to cards that were not written are dropped, not left dangling", () => {
  const cards = [
    card({ id: "c1", title: "完成的" }),
    card({ id: "c2", title: "生成中的", status: "streaming" }),
  ];
  const edges: CardEdge[] = [
    {
      id: "e1",
      type: "child",
      sourceCardId: "c1",
      targetCardId: "c2",
      contextPolicy: "topic-and-selection",
    },
  ];
  const canvas = JSON.parse(
    plan(cards, edges).find((n) => n.relative[1] === "_关系.canvas")!.content,
  ) as { nodes: unknown[]; edges: unknown[] };
  assert.equal(canvas.nodes.length, 1);
  assert.deepEqual(canvas.edges, [], "指向未写出卡片的边会让 canvas 打不开");
});

test("a single-question card reads as knowledge, not as a transcript", () => {
  const note = plan([
    card({
      id: "c1",
      title: "量子退相干",
      question: "深挖：退相干是坍缩吗？",
      answer: "## 不是坍缩\n\n两者的差别在于……",
    }),
  ])[0].content;

  assert.ok(note.startsWith("---\n"), "要有 frontmatter");
  assert.ok(note.includes("papertable_id: c1"));
  assert.ok(note.includes("# 量子退相干"));
  assert.ok(note.includes("> [!question] 深挖：退相干是坍缩吗？"));
  assert.ok(note.includes("## 不是坍缩"));
  assert.ok(
    !note.includes("## 用户") && !note.includes("## 助手"),
    "单问单答不该套角色标题——那会让 Obsidian 的大纲错乱",
  );
  assert.ok(!note.includes("papertable_hash"), "哈希只存在 sync_state 里");
});

test("frontmatter keys stay contiguous under alphabetical sorting", () => {
  const note = plan([card({ id: "c1", title: "卡片" })])[0].content;
  const keys = note
    .slice(4, note.indexOf("\n---\n"))
    .split("\n")
    .map((line) => line.split(":")[0]);
  assert.ok(
    keys.every((key) => key.startsWith("papertable_")),
    "统一前缀，Linter 的 yaml-key-sort 重排后才会稳定且连续",
  );
});
