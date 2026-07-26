import assert from "node:assert/strict";
import test from "node:test";
import { parseWikilinks, stripWikilinks } from "./wikilink";

test("plain, aliased and sectioned links all resolve to the note name", () => {
  assert.deepEqual(parseWikilinks("见 [[量子退相干]]。"), [
    { name: "量子退相干", label: "量子退相干" },
  ]);
  assert.deepEqual(parseWikilinks("见 [[量子退相干|退相干]]。"), [
    { name: "量子退相干", label: "退相干" },
  ]);
  assert.deepEqual(parseWikilinks("见 [[量子退相干#不是坍缩]]。"), [
    { name: "量子退相干", label: "量子退相干" },
  ]);
  assert.deepEqual(parseWikilinks("见 [[量子退相干#小节|退相干]]。"), [
    { name: "量子退相干", label: "退相干" },
  ]);
});

test("the same note linked twice is one reference", () => {
  assert.deepEqual(
    parseWikilinks("[[波函数]] 和 [[波函数|另一种叫法]]").map((l) => l.name),
    ["波函数"],
  );
});

test("non-links and malformed brackets are left alone", () => {
  assert.deepEqual(parseWikilinks("[[]] 空的"), []);
  assert.deepEqual(parseWikilinks("[单链](x.md)"), []);
  assert.deepEqual(parseWikilinks("没有链接"), []);
});

/**
 * `a[[0]]`、`matrix[[i]]` 在技术笔记里很常见。Obsidian 自己也不在代码块里解析双链，
 * 把它们当引用会凭空造出一堆指向不存在笔记的链接。
 */
test("brackets inside code are not links", () => {
  assert.deepEqual(parseWikilinks("行内 `a[[0]]` 是索引"), []);
  assert.deepEqual(parseWikilinks("```ts\nconst x = m[[i]];\n```"), []);
  // 代码之外的仍然要认出来。
  assert.deepEqual(
    parseWikilinks("`code[[0]]` 但正文里 [[真链接]] 要算").map((l) => l.name),
    ["真链接"],
  );
});

test("stripping keeps the visible text so excerpts never carry brackets", () => {
  assert.equal(
    stripWikilinks("参考 [[量子退相干|退相干]] 与 [[波函数]]。"),
    "参考 退相干 与 波函数。",
  );
});
