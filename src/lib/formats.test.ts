import assert from "node:assert/strict";
import test from "node:test";
import JSZip from "jszip";
import { cardMarkdown, formatAdapters, projectBundle } from "./formats";
import type { PortableProject } from "../types";

const project = (): PortableProject => ({
  version: 1,
  project: { id: "p", name: "格式测试", pinned: false, updatedAt: 1 },
  cards: [
    {
      id: "root",
      projectId: "p",
      title: "根卡",
      favorite: false,
      unread: false,
      answerMode: "sources-only",
      concepts: [],
      createdAt: 1,
      turns: [
        {
          id: "u",
          role: "user",
          content: "问题",
          createdAt: 1,
          status: "complete",
        },
      ],
    },
    {
      id: "child",
      projectId: "p",
      title: "子卡",
      favorite: false,
      unread: false,
      answerMode: "general",
      concepts: [],
      createdAt: 2,
      turns: [
        {
          id: "a",
          role: "ai",
          content: "答案",
          createdAt: 2,
          status: "complete",
          favorite: true,
          verdictId: "gold-1",
          citations: [
            {
              chunkId: "chunk-quantum",
              libraryId: "library",
              documentId: "doc",
              title: "量子笔记",
              relativePath: "notes/quantum.md",
              documentHash: "frozen-hash",
              excerpt: "此处是冻结的来源片段。",
            },
          ],
          agentRun: {
            mode: "unavailable",
            startedAt: 1,
            finishedAt: 2,
            searchQueries: ["量子"],
            hitCount: 1,
            readChunkIds: ["chunk-quantum"],
            performance: {
              preflightMs: 12,
              firstVisibleMs: 345,
              totalMs: 456,
            },
          },
          verdictTrace: {
            promptVersion: "verdict-v1",
            injectionEnabled: true,
            query: "量子 子卡",
            availability: "available",
            verdicts: [
              { id: "v1", verdictType: "gold", snapshot: "保留可核证据" },
            ],
          },
        },
      ],
    },
  ],
  edges: [
    {
      id: "edge",
      type: "child",
      sourceCardId: "root",
      targetCardId: "child",
      contextPolicy: "topic-and-selection",
      contextSnapshotId: "snapshot",
    },
  ],
  anchors: [{ id: "anchor", cardId: "root", exact: "问题", text: "问题" }],
  snapshots: [
    {
      id: "snapshot",
      edgeId: "edge",
      createdAt: 2,
      sourceTitle: "根卡",
      sourceText: "问题",
    },
  ],
  references: [],
});

test("native project package preserves graph, snapshots and cards", async () => {
  const artifact = await projectBundle(project());
  const bytes = await artifact.blob.arrayBuffer();
  const zip = await JSZip.loadAsync(bytes);
  assert.ok(
    Object.keys(zip.files).some((name) => name.endsWith("manifest.json")),
  );
  assert.ok(Object.keys(zip.files).some((name) => name.includes("assets/")));
  const file = new File([bytes], artifact.filename, {
    type: "application/zip",
  });
  const restored = await formatAdapters.bundle.import({
    format: "bundle",
    files: [file],
  });
  assert.equal(restored.cards.length, 2);
  assert.equal(restored.edges[0].contextSnapshotId, "snapshot");
  assert.equal(restored.snapshots[0].sourceText, "问题");
  assert.equal(restored.cards[0].answerMode, "sources-only");
  assert.equal(restored.cards[1].answerMode, "general");
  assert.equal(
    restored.cards[1].turns[0].citations?.[0].chunkId,
    "chunk-quantum",
  );
  assert.equal(restored.cards[1].turns[0].agentRun?.mode, "unavailable");
  assert.equal(
    restored.cards[1].turns[0].verdictTrace?.verdicts[0].snapshot,
    "保留可核证据",
  );
  assert.equal(restored.cards[1].turns[0].favorite, true);
  assert.equal(restored.cards[1].turns[0].verdictId, "gold-1");
  assert.deepEqual(restored.cards[1].turns[0].agentRun?.performance, {
    preflightMs: 12,
    firstVisibleMs: 345,
    totalMs: 456,
  });
});

test("Markdown 和 Canvas 导出给人可读的笔记引用，但不公开 answerMode frontmatter", async () => {
  const portable = project();
  const markdown = cardMarkdown(portable, portable.cards[1]);
  const frontmatter = markdown.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
  assert.doesNotMatch(frontmatter, /answerMode/);
  assert.match(markdown, /### 本轮引用的笔记/);
  assert.match(markdown, /\*\*量子笔记\*\*/);
  assert.match(markdown, /`notes\/quantum\.md`/);
  assert.match(markdown, /此处是冻结的来源片段/);
  assert.doesNotMatch(markdown, /verdictTrace|保留可核证据/);
  assert.doesNotMatch(markdown, /gold-1|verdictId/);

  const [canvas] = await formatAdapters.canvas.export(portable);
  const zip = await JSZip.loadAsync(await canvas.blob.arrayBuffer());
  const child = Object.values(zip.files).find((file) =>
    file.name.includes("子卡-child.md"),
  );
  assert.ok(child);
  const childText = await child!.async("text");
  assert.match(childText, /### 本轮引用的笔记/);
  assert.doesNotMatch(childText, /verdictTrace|保留可核证据/);
});

test("normal exports exclude experimental attention events and ghost proposals", async () => {
  const portable = project() as PortableProject & {
    proposals?: unknown[];
    interactionEvents?: unknown[];
  };
  portable.proposals = [{ id: "ghost", explorationQuestion: "不应导出" }];
  portable.interactionEvents = [{ id: "event", type: "title-edited" }];
  const artifact = await projectBundle(portable);
  const zip = await JSZip.loadAsync(await artifact.blob.arrayBuffer());
  const graph = Object.values(zip.files).find((file) =>
    file.name.endsWith("graph.json"),
  );
  assert.ok(graph);
  const content = await graph!.async("text");
  assert.doesNotMatch(content, /不应导出/);
  assert.doesNotMatch(content, /interactionEvents/);
});

test("Markdown 双链导入为引用，而不是伪造出一条继承边", async () => {
  const files = [
    new File(
      ["# 退相干\n\n参见 [[波函数]] 与 [[外部笔记|别名]]。\n"],
      "退相干.md",
      { type: "text/markdown" },
    ),
    new File(["# 波函数\n\n正文。\n"], "波函数.md", { type: "text/markdown" }),
  ];
  const imported = await formatAdapters["md-dir"].import({
    format: "md-dir",
    files,
  });

  // README 一直声称有这个行为，但它此前从未被实现过。
  assert.equal(imported.references.length, 2);
  const names = imported.references.map((r) => r.sourceTitle).sort();
  assert.deepEqual(names, ["外部笔记", "波函数"]);
  // 双链没有 ContextSnapshot，由它推断边等于凭空伪造出处。
  assert.deepEqual(imported.edges, []);
  // 摘录里不能带 [[ ]]。
  assert.ok(imported.references.every((r) => !r.excerpt.includes("[[")));
});
