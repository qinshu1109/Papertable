import assert from "node:assert/strict";
import test from "node:test";
import { chunkMarkdown } from "./chunk";
import { isConfidentNoteHit, noteTokens, rankNoteChunks } from "./search";
import type { NoteChunk } from "./types";

/**
 * Small, fixed Chinese corpus.  These are deliberately not lorem ipsum: each
 * query names a fact that appears in exactly one note, so a regression in
 * CJK tokenization/ranking is visible without any model call.
 */
const goldenDocuments = [
  ["量子/低温.md", "# 低温工程\n\n蓝隙冷却指标要求在 18mK 下完成读出校准。"],
  [
    "量子/退相干.md",
    "# 退相干\n\n相位漂移哨兵用于记录一次退相干实验的异常峰值。",
  ],
  ["Agent/上下文.md", "# 上下文边界\n\n冻结分支快照只能携带分支点之前的历史。"],
  [
    "Agent/工具门禁.md",
    "# 工具门禁\n\n猜测的 chunkId 必须被主机拒绝，不能读取陌生片段。",
  ],
  ["产品/注意力.md", "# 注意力观察\n\n幽灵分支只在用户确认后才物化正式卡片。"],
  ["产品/引用.md", "# 可验证引用\n\n来源哈希变化时应提示引用来源已更新。"],
  ["写作/长文.md", "# 长文输入\n\n纸飞机编辑器会在十行后收起到内部滚动区。"],
  [
    "研究/检索.md",
    "# 只读检索\n\n海盐索引是给中文 Markdown 的离线检索黄金样本。",
  ],
  ["工程/桌面.md", "# 桌面存储\n\n琥珀 SQLite 迁移不能删除已有卡片和轮次。"],
  [
    "工程/前端.md",
    "# 前端性能\n\n蓝松 Worker 负责把 MiniSearch 索引移出主线程。",
  ],
  ["笔记/导入.md", "# 导入格式\n\n石墨 JSON Canvas 只是一种可视化交换格式。"],
  [
    "安全/提示注入.md",
    "# 不可信资料\n\n雨幕指令注入不得改变系统规则或扩大读取范围。",
  ],
] as const;

const chunks: NoteChunk[] = goldenDocuments.flatMap(
  ([relativePath, content]) =>
    chunkMarkdown({
      libraryId: "golden-library",
      relativePath,
      content,
      updatedAt: 1,
    }).chunks,
);

test("Chinese tokenization keeps both words and individual CJK characters", () => {
  const tokens = noteTokens("海盐索引 MiniSearch-Worker");
  assert.ok(tokens.includes("海盐索引"));
  assert.ok(tokens.includes("海"));
  assert.ok(tokens.includes("minisearch-worker"));
});

test("twelve-note Chinese golden corpus puts every expected note in top three", () => {
  const cases = [
    ["蓝隙冷却", "量子/低温.md"],
    ["相位漂移哨兵", "量子/退相干.md"],
    ["冻结分支快照", "Agent/上下文.md"],
    ["猜测 chunkId", "Agent/工具门禁.md"],
    ["幽灵分支物化", "产品/注意力.md"],
    ["来源哈希", "产品/引用.md"],
    ["纸飞机编辑器", "写作/长文.md"],
    ["海盐索引", "研究/检索.md"],
    ["琥珀 SQLite", "工程/桌面.md"],
    ["蓝松 Worker", "工程/前端.md"],
  ] as const;

  for (const [query, expectedPath] of cases) {
    const results = rankNoteChunks(chunks, query, 3);
    assert.ok(results.length > 0, `${query} should return a result`);
    assert.ok(
      results.some((result) => result.chunk.relativePath === expectedPath),
      `${query} should put ${expectedPath} in top three, got ${results
        .map((result) => result.chunk.relativePath)
        .join(", ")}`,
    );
  }
});

test("ranking has a stable exact-match lift and never exceeds the host limit", () => {
  const results = rankNoteChunks(chunks, "雨幕指令注入", 99);
  assert.ok(results.length <= 8, "the adapter contract caps every search at 8");
  assert.equal(results[0]?.chunk.relativePath, "安全/提示注入.md");
});

test("agent evidence gate rejects a CJK character-overlap false positive", () => {
  const [onlyChunk] = chunkMarkdown({
    libraryId: "acceptance-library",
    relativePath: "海蓝计划.md",
    content: "# 海蓝计划\n\n唯一事实：海蓝计划的内部代号是 ORBIT-97。",
    updatedAt: 1,
  }).chunks;
  const trueHit = rankNoteChunks(
    [onlyChunk],
    "海蓝计划的内部代号是什么？",
    3,
  )[0];
  const falseHit = rankNoteChunks(
    [onlyChunk],
    "资料库里没有出现的赤霄项目代号是什么？",
    3,
  )[0];
  assert.ok(trueHit);
  assert.ok(falseHit, "MiniSearch may offer a weak fuzzy candidate");
  assert.equal(isConfidentNoteHit(trueHit, "海蓝计划的内部代号是什么？"), true);
  assert.equal(
    isConfidentNoteHit(falseHit, "资料库里没有出现的赤霄项目代号是什么？"),
    false,
  );
  assert.equal(
    isConfidentNoteHit(trueHit, "ORBIT-97 属于哪个计划？"),
    true,
    "identifier punctuation must not turn an otherwise exact source into a miss",
  );
});
