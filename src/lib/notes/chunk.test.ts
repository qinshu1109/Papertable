import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_NOTE_CHUNK_CHARS,
  NOTE_CHUNK_OVERLAP_CHARS,
  chunkMarkdown,
  noteContentHash,
  noteDocumentId,
} from "./chunk";

test("Markdown 标题层级、frontmatter 和代码围栏会被正确处理", () => {
  const content = `---
title: "量子笔记"
tags:
  - quantum
  - #physics
---

# 量子计算

根章节的引言。

## 退相干

环境会让相位关系消失。

\`\`\`markdown
# 这不是标题
也不应切开代码块。
\`\`\`

### 工程含义

需要隔离、制冷与纠错。
`;
  const result = chunkMarkdown({
    libraryId: "lib",
    relativePath: "研究/量子.md",
    content,
    updatedAt: 10,
  });

  assert.equal(result.document.title, "量子笔记");
  assert.deepEqual(result.document.tags, ["quantum", "physics"]);
  assert.equal(result.chunks.length, 3);
  assert.deepEqual(result.chunks[0].titlePath, ["量子计算"]);
  assert.deepEqual(result.chunks[1].titlePath, ["量子计算", "退相干"]);
  assert.deepEqual(result.chunks[2].titlePath, [
    "量子计算",
    "退相干",
    "工程含义",
  ]);
  assert.match(result.chunks[1].text, /# 这不是标题/);
  assert.equal(
    content.slice(result.chunks[1].start, result.chunks[1].end),
    result.chunks[1].text,
  );
});

test("超长段落以最多 800 字符切块，并保留约 80 字重叠", () => {
  const sentence =
    "量子系统需要在低温下维持相干性，因此工程必须同时处理噪声、控制和测量。";
  const content = `# 长文\n\n${sentence.repeat(80)}`;
  const result = chunkMarkdown({
    libraryId: "lib",
    relativePath: "long.md",
    content,
  });

  assert.ok(result.chunks.length >= 3);
  for (const chunk of result.chunks) {
    assert.ok(chunk.end - chunk.start <= MAX_NOTE_CHUNK_CHARS);
    assert.equal(content.slice(chunk.start, chunk.end), chunk.text);
  }
  for (let index = 1; index < result.chunks.length; index += 1) {
    const previous = result.chunks[index - 1];
    const current = result.chunks[index];
    const shared = previous.end - current.start;
    assert.ok(shared >= NOTE_CHUNK_OVERLAP_CHARS - 2);
    assert.equal(
      content.slice(current.start, previous.end),
      content.slice(previous.end - shared, previous.end),
    );
  }
});

test("版本哈希、文档 ID 和字符范围对同一文本保持确定性", () => {
  const input = {
    libraryId: "library-a",
    relativePath: "./产品\\设计.md",
    content: "# 设计\r\n\r\n第一段。\r\n\r\n第二段。\r\n",
  };
  const first = chunkMarkdown(input);
  const second = chunkMarkdown(input);

  assert.equal(first.document.versionHash, second.document.versionHash);
  assert.equal(first.document.id, noteDocumentId("library-a", "产品/设计.md"));
  assert.equal(first.chunks[0].id, second.chunks[0].id);
  assert.equal(noteContentHash("a\r\nb"), noteContentHash("a\nb"));
  assert.deepEqual(
    first.chunks.map((chunk) => [chunk.ordinal, chunk.start, chunk.end]),
    second.chunks.map((chunk) => [chunk.ordinal, chunk.start, chunk.end]),
  );
});

test("没有标题的 Markdown 使用文件名作为标题路径", () => {
  const result = chunkMarkdown({
    libraryId: "lib",
    relativePath: "收集/未分类笔记.md",
    content: "没有标题，但仍然应可检索。",
  });

  assert.equal(result.document.title, "未分类笔记");
  assert.deepEqual(result.chunks[0].titlePath, ["未分类笔记"]);
});
