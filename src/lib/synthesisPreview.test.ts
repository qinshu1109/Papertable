import assert from "node:assert/strict";
import test from "node:test";
import { createSynthesisPreviewGate } from "./synthesisPreview";

test("preview requires the sentinel and streams safe final prose", () => {
  const gate = createSynthesisPreviewGate();
  assert.deepEqual(gate.push("hidden reasoning", "unknown"), {
    content: "",
    blocked: false,
  });
  assert.deepEqual(
    gate.push("<<<PAPERTABLE_ANSWER>>>\n正文第一段。", "unknown"),
    { content: "正文第一段。", blocked: false },
  );
  assert.deepEqual(gate.push("正文第二段。", "unknown"), {
    content: "正文第一段。正文第二段。",
    blocked: false,
  });
});

test("preview holds split protocol prefixes and clears the leaking attempt", () => {
  const gate = createSynthesisPreviewGate();
  gate.push("<<<PAPERTABLE_ANSWER>>>安全正文。<too", "unknown");
  assert.deepEqual(gate.push("l_call", "unknown"), {
    content: "安全正文。",
    blocked: false,
  });
  assert.deepEqual(gate.push(">泄漏", "unknown"), {
    content: "",
    blocked: true,
  });
  assert.deepEqual(gate.push("不得恢复", "unknown"), {
    content: "",
    blocked: true,
  });
});

test("preview never exposes citation control markers as validated citations", () => {
  const gate = createSynthesisPreviewGate();
  gate.push("<<<PAPERTABLE_ANSWER>>>事实成立 [[sou", "unknown");
  assert.deepEqual(gate.push("rce:read-1]]，继续。", "unknown"), {
    content: "事实成立 ，继续。",
    blocked: false,
  });
});
