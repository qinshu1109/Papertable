import assert from "node:assert/strict";
import test from "node:test";
import { createAnswerGate, visibleModelOutput } from "./modelOutput";

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

// --- 泄漏回归 ---------------------------------------------------------------

/** 实际落盘并出现在已发布截图里的那一段。 */
const LEAK_PREAMBLE =
  "Since the user didn't provide specific card content beyond the topic " +
  "「量子退相干」, I'll draw on general knowledge to answer, making sure to " +
  "note that distinction clearly.";
const LEAK_BODY = "量子退相干是指系统与环境纠缠后相位信息扩散到环境中。";

test("the shipped leak is stripped, body survives", () => {
  assert.equal(
    visibleModelOutput(`${LEAK_PREAMBLE}\n\n${LEAK_BODY}`),
    LEAK_BODY,
  );
});

test("openings the anchored whitelist missed are all caught", () => {
  const preambles = [
    "Given that the user asked about decoherence, ",
    "Looking at the user's question, ",
    "Let me think about how to structure this. ",
    "First, I'll outline the key ideas. ",
    "Because the question is about decoherence, I need to define it. ",
    "好的，我先梳理一下这个问题。",
    "用户没有给出材料，我需要用通用知识。",
    "Okay, let me break this down. ",
  ];
  for (const preamble of preambles) {
    assert.equal(
      visibleModelOutput(`${preamble}\n\n${LEAK_BODY}`),
      LEAK_BODY,
      `未剥离前言：${preamble}`,
    );
    assert.equal(
      visibleModelOutput(preamble),
      "",
      `草稿未结束时不该释放：${preamble}`,
    );
  }
});

// --- 短回答仍要能流式 -------------------------------------------------------

test("a short answer still streams at sentence granularity", () => {
  const gate = createAnswerGate();
  gate.push("量子退相干");
  assert.equal(gate.visible(), "", "半句话不释放");
  gate.push("是指系统与环境纠缠。");
  assert.equal(gate.visible(), "量子退相干是指系统与环境纠缠。");
});

test("two-sentence answers with no heading survive verbatim", () => {
  assert.equal(
    visibleModelOutput("退相干很快。它不是坍缩。"),
    "退相干很快。它不是坍缩。",
  );
  assert.equal(
    visibleModelOutput("It is fast. It is not collapse."),
    "It is fast. It is not collapse.",
  );
  assert.equal(visibleModelOutput("退相干很快"), "退相干很快");
});

test("a structural head releases with zero lag", () => {
  const gate = createAnswerGate();
  gate.push("## 结");
  assert.equal(gate.visible(), "## 结");
});

// --- 不可收回 ---------------------------------------------------------------

test("visible output is append-only across arbitrary token splits", () => {
  const corpus = `${LEAK_PREAMBLE}\n\n## 结论\n\n${LEAK_BODY}\n\n它不是波函数坍缩。`;
  let seed = 20260727;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  for (let round = 0; round < 200; round++) {
    const gate = createAnswerGate();
    let previous = "";
    let index = 0;
    while (index < corpus.length) {
      const step = 1 + Math.floor(random() * 7);
      gate.push(corpus.slice(index, index + step));
      index += step;
      const current = gate.visible();
      assert.ok(
        current.startsWith(previous),
        `第 ${round} 轮出现回退：\n前 ${JSON.stringify(previous)}\n后 ${JSON.stringify(current)}`,
      );
      assert.ok(!current.includes("Since the user"), "草稿泄漏进可见输出");
      previous = current;
    }
    assert.equal(gate.finish().includes(LEAK_BODY), true);
  }
});

// --- 中断安全 ---------------------------------------------------------------

test("an interrupted draft is never visible without finish()", () => {
  const gate = createAnswerGate();
  for (const chunk of LEAK_PREAMBLE.match(/.{1,9}/gs) ?? []) gate.push(chunk);
  assert.equal(gate.visible(), "", "停止时可见内容必须为空");
  assert.ok(!gate.visible().includes("the user"));
});

// --- 定界标签 ---------------------------------------------------------------

test("delimiter tags are handled in every position", () => {
  assert.equal(visibleModelOutput("<thinking>plan</thinking>正文。"), "正文。");
  assert.equal(visibleModelOutput("<reasoning>plan"), "");
  assert.equal(
    visibleModelOutput("正文。<think>x</think>更多。"),
    "正文。更多。",
  );
});

test("a partial tag at the tail never renders literally", () => {
  const gate = createAnswerGate();
  gate.push("正文。<thi");
  assert.equal(gate.visible(), "正文。");
});

// --- 服务端分道 -------------------------------------------------------------

test("reasoning channel is dropped and final channel is trusted", () => {
  const gate = createAnswerGate();
  gate.push("Since the user asked, I will plan.", "reasoning");
  gate.push("量子退相干是指", "final");
  assert.equal(gate.visible(), "量子退相干是指");
  assert.ok(!gate.visible().includes("the user"));
});

// --- 误判护栏 ---------------------------------------------------------------

test("code fences mentioning markers are released untouched", () => {
  const answer =
    "```ts\n// the user id is required\nconst i = 1; // I need to keep this\n```";
  assert.equal(visibleModelOutput(answer), answer);
});

test("prose mentioning the user after the latch is not filtered", () => {
  const answer =
    "退相干很快。它不是坍缩。第三句提到 the user interface 也不该被过滤。";
  assert.equal(visibleModelOutput(answer), answer);
});
