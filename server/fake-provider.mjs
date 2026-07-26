import { sseEvent } from "./cozai.mjs";

/** 与 src/lib/modelOutput.ts 的 ANSWER_SENTINEL 保持一致。 */
const S = "<<<PAPERTABLE_ANSWER>>>";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const DECOHERENCE_BODY =
  "量子退相干是指系统与环境纠缠后相位信息扩散到环境中。\n\n它不是波函数坍缩。";

/**
 * 隐藏推理场景。按最后一条用户消息里的标签分流，而不是用环境变量——环境变量
 * 会作用于整个 Playwright run，并强制在用例之间重启服务。
 */
const LEAK_SCENARIOS = [
  // 真机形态：推理是普通说明文英语，与正文之间**连换行都没有**，靠短语枚举
  // 一条也识别不出来。只有哨兵能切开。
  {
    tag: "思考泄漏",
    content:
      "The core issue is that qubits are extremely fragile—decoherence and gate " +
      "errors accumulate rapidly. For the metaphor, I'm thinking of it like a " +
      `library.${S}${DECOHERENCE_BODY}`,
  },
  // 模型完全不给哨兵、且用散文开头：正文只能等流结束才出现。
  {
    tag: "无哨兵",
    content: "这是没有哨兵的散文回答。它应当在流结束时整体出现。",
  },
  {
    tag: "思考标签",
    content: `<think>internal plan</think>${S}${DECOHERENCE_BODY}`,
  },
  { tag: "思考未闭合", content: "<think>internal plan that never closes" },
  // 真机形态（CozAI × claude-opus-5）：推理走独立字段，**同时** content 里仍带哨兵
  // ——模型只是照系统提示办事。可信直通路径必须剥掉它；曾经没剥，
  // `<<<PAPERTABLE_ANSWER>>>` 被原样渲染进正文并落盘。
  {
    tag: "思考分道",
    reasoning: "internal plan the gateway kept in its own field",
    content: `${S}${DECOHERENCE_BODY}`,
  },
  // 停止用例需要一个「首句很早完成、整体足够长」的回答，这样「等到有内容再停止」
  // 不必和流式速度赛跑。
  {
    tag: "停止测试",
    content:
      `${S}第一句已经完成。\n\n` +
      "后面还有很长的内容，用于确保点击停止时这条流仍在进行中。".repeat(10),
  },
  // 概念浮层曾经完全绕过闸门，原始流会同时进入浮层、缓存、引用和转正式卡片。
  {
    tag: "量子退相干",
    task: "concept-preview",
    content:
      "The user didn't give me a source sentence, so I'll draw on general " +
      `knowledge here.${S}退相干描述的是相位相干性向环境泄漏的过程。`,
  },
];

function lastUserMessage(payload) {
  return (
    [...payload.messages].reverse().find((message) => message.role === "user")
      ?.content ?? ""
  );
}

export function fakeScenario(payload) {
  if (payload.task === "title" || payload.task === "concepts") return null;
  const lastUser = lastUserMessage(payload);
  return (
    LEAK_SCENARIOS.find(
      (scenario) =>
        (scenario.task
          ? payload.task === scenario.task
          : payload.task === "chat") && lastUser.includes(scenario.tag),
    ) ?? null
  );
}

export function fakeCompletion(payload) {
  const lastUser = lastUserMessage(payload);
  const topic = lastUser.replace(/\s+/g, " ").slice(0, 42) || "这个问题";
  if (payload.task === "title") return `${S}本地验收测试`;
  // 概念必须逐字出现在正文里；给概念浮层用例一个可点击的词。
  if (payload.task === "concepts")
    return lastUser.includes("量子退相干") ? `${S}["量子退相干"]` : `${S}[]`;
  const scenario = fakeScenario(payload);
  if (scenario) return scenario.content;
  // 默认回答也带哨兵：系统提示要求它，fake provider 必须反映真实契约，
  // 否则 e2e 验的是一条真机上不存在的路径。
  return `${S}这是本地验收用的流式回答：${topic}。\n\n它用于验证卡片、上下文、停止与自动保存链路；正式运行时会由 CozAI · Claude Opus 5 回答。`;
}

export async function emitFakeStream({ payload, write, signal }) {
  const scenario = fakeScenario(payload);
  const content = fakeCompletion(payload);
  // 网关把推理放进独立字段的情形：只发长度，content 标注为可信的最终正文。
  if (scenario?.reasoning) {
    write(sseEvent("reasoning", { chars: scenario.reasoning.length }));
  }
  const channel = scenario?.reasoning ? "final" : "unknown";
  // 按码点切块。曾经用 `content.match(/.{1,8}/gu)`，而 `.` 不匹配换行符——它会
  // 静默吞掉流式内容里的每一个 \n，段落边界因此永远不会到达前端。
  const points = Array.from(content);
  for (let i = 0; i < points.length; i += 8) {
    if (signal?.aborted) break;
    write(
      sseEvent("token", { text: points.slice(i, i + 8).join(""), channel }),
    );
    await sleep(25);
  }
  write(sseEvent("done", { stopped: Boolean(signal?.aborted) }));
}
