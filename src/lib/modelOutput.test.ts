import assert from "node:assert/strict";
import test from "node:test";
import { visibleModelOutput } from "./modelOutput";

test("normal final output streams through unchanged", () => {
  assert.equal(
    visibleModelOutput("## 结论\n\n可以继续。"),
    "## 结论\n\n可以继续。",
  );
});

test("delimited thinking never reaches the visible card", () => {
  assert.equal(
    visibleModelOutput("<think>internal</think>\n最终答案"),
    "最终答案",
  );
  assert.equal(visibleModelOutput("<think>internal"), "");
});

test("gateway-style analysis preambles are buffered then removed", () => {
  assert.equal(visibleModelOutput("The user wants an answer"), "");
  assert.equal(
    visibleModelOutput("The user wants an answer.\n\n## 可交付回答\n\n正文"),
    "## 可交付回答\n\n正文",
  );
  assert.equal(
    visibleModelOutput("I notice a missing source.\n\n## 证据不足\n\n正文"),
    "## 证据不足\n\n正文",
  );
  assert.equal(
    visibleModelOutput(
      "用户提出了一个问题，我需要先分析。\n\n直接给用户的中文回答。",
    ),
    "直接给用户的中文回答。",
  );
});
