import assert from "node:assert/strict";
import test from "node:test";
import {
  ANSWER_SENTINEL,
  createAnswerGate,
  visibleModelOutput,
} from "./modelOutput";

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

/**
 * 契约变更（有代价，刻意为之）：**没有哨兵时，散文开头的正文要等流结束才出现。**
 *
 * 旧行为是按句子边streaming释放，靠短语枚举判断每一句是不是推理。真机上模型输出了
 * 1573 字符的英文推理散文，一条都没命中，而 passthrough 闩锁把这一次漏判放大成了
 * 全量泄漏。散文开头就是无法区分的情形，宁可晚一点也不能混进推理。
 *
 * 我们自己的系统提示总会要求哨兵，所以这个代价只落在忽略格式要求的模型上。
 */
test("without a sentinel, prose is withheld until the stream ends", () => {
  const gate = createAnswerGate();
  gate.push("量子退相干");
  assert.equal(gate.visible(), "");
  gate.push("是指系统与环境纠缠。");
  assert.equal(gate.visible(), "", "散文开头，流中不放");
  assert.equal(gate.finish(), "量子退相干是指系统与环境纠缠。", "收尾时给出");
});

test("a sentinel streams everything after it, with zero heuristics", () => {
  const gate = createAnswerGate();
  gate.push("The core issue is that qubits are extremely fragile. ");
  assert.equal(gate.visible(), "", "哨兵之前一个字都不放");
  gate.push("For the metaphor, I'm thinking of it like a library. ");
  assert.equal(gate.visible(), "");
  gate.push(`${ANSWER_SENTINEL}\n\n量子退相干是指`);
  assert.equal(gate.visible(), "量子退相干是指", "哨兵之后立刻直通");
  gate.push("系统与环境纠缠。");
  assert.equal(gate.visible(), "量子退相干是指系统与环境纠缠。");
  assert.ok(!gate.visible().includes("The core issue"));
});

test("the real leaked transcript is split at the sentinel", () => {
  const gate = createAnswerGate();
  // 真机上模型把推理和正文之间连换行都没加：`accumulate.## 材料说明`
  gate.push(
    `${LEAK_PREAMBLE}accumulate.${ANSWER_SENTINEL}## 材料说明\n\n${LEAK_BODY}`,
  );
  const answer = gate.finish();
  assert.ok(answer.startsWith("## 材料说明"));
  assert.ok(answer.includes(LEAK_BODY));
  assert.ok(!answer.includes("Since the user"));
  assert.ok(!answer.includes("accumulate."));
});

test("a partial sentinel at the tail never renders literally", () => {
  const gate = createAnswerGate();
  gate.push("## 正文开始\n\n第一句。<<<PAPER");
  assert.ok(!gate.visible().includes("<<<PAPER"), "半个哨兵不能当字面量放出去");
  assert.equal(gate.visible(), "");
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

test("a structural head without a sentinel also waits for finish", () => {
  const gate = createAnswerGate();
  gate.push("## 结");
  assert.equal(gate.visible(), "");
  gate.push("论\n\n可以继续。");
  assert.equal(gate.visible(), "");
  assert.equal(gate.finish(), "## 结论\n\n可以继续。");
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

test("a partial thinking tag at the tail never renders literally", () => {
  // 散文开头，所以流中本就不放；收尾时未闭合的 <think 也不能变成字面量。
  assert.equal(visibleModelOutput("正文。<thi"), "正文。");
});

// --- 服务端标记不能越过正文闸门 ----------------------------------------------

test("a service-side final marker cannot bypass the sentinel", () => {
  const gate = createAnswerGate();
  gate.push("internal plan that must never be visible", "final");
  assert.equal(gate.visible(), "");
  gate.push(`${ANSWER_SENTINEL}\n完成`, "final");
  assert.equal(gate.visible(), "完成");
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

// --- 真机截图暴露的两个泄漏 -------------------------------------------------

/**
 * 服务端 metadata 只是兼容信号；哨兵才是唯一的正文起点。
 */
test("a service marker still strips the sentinel instead of rendering it", () => {
  const gate = createAnswerGate();
  gate.push(`${ANSWER_SENTINEL}\n\n完成`, "final");
  assert.equal(gate.visible(), "完成");
  assert.ok(!gate.visible().includes("PAPERTABLE"));
});

test("a sentinel split across token chunks never renders, even partially", () => {
  const gate = createAnswerGate();
  gate.push("<<<PAPERTABLE_", "final");
  assert.equal(gate.visible(), "", "半个哨兵一个字符都不能漏");
  gate.push("ANSWER>>", "final");
  assert.equal(gate.visible(), "");
  gate.push(">完成", "final");
  assert.equal(gate.visible(), "完成");
  assert.equal(gate.finish(), "完成");
});

test("text before a late sentinel is discarded instead of leaked", () => {
  const gate = createAnswerGate();
  gate.push("先到的正文。", "final");
  assert.equal(gate.visible(), "");
  gate.push(`${ANSWER_SENTINEL}后到的正文。`, "final");
  assert.equal(gate.visible(), "后到的正文。");
});

/** 真机卡片标题被改成了「I'm looking at the answer 同步」。 */
test("a leaked title preamble yields nothing rather than an English title", () => {
  assert.equal(
    visibleModelOutput(
      "I'm looking at the answer 同步复测, so a good title is 同步复测。",
    ),
    "",
    "识别不了就什么都不给——调用方会保留旧标题",
  );
  assert.equal(
    visibleModelOutput(`I'm looking at the answer.${ANSWER_SENTINEL}同步复测`),
    "同步复测",
  );
});
