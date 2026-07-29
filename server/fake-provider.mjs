import { sseEvent } from "./cozai.mjs";

/** 与 src/lib/modelOutput.ts 的 ANSWER_SENTINEL 保持一致。 */
const S = "<<<PAPERTABLE_ANSWER>>>";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function fakeProviderDelayMs(
  value = process.env.PAPERTABLE_FAKE_LLM_DELAY_MS,
) {
  if (value === undefined || value === "") return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.min(60_000, Math.max(0, Math.round(parsed)))
    : 0;
}

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

const TASK_022_TAGS = [
  "安全最终预览",
  "预览协议重发",
  "预览停止",
  "预览崩溃",
  "预览无哨兵",
  "预览伪引用",
  "预览长度重发",
  "预览空响应重发",
];

function task022Tag(payload) {
  const text = lastUserMessage(payload);
  return TASK_022_TAGS.find((tag) => text.includes(tag)) ?? null;
}

function finalSynthesis(payload) {
  const choice = payload.toolChoice ?? payload.tool_choice;
  return (
    payload.task === "agent" &&
    choice === "none" &&
    !Array.isArray(payload.tools)
  );
}

function finalSynthesisRepair(payload) {
  return (payload.messages ?? []).some((message) =>
    message?.content?.includes("协议修复：上一次最终综合"),
  );
}

function finalEvidenceChunkId(payload) {
  const text = (payload.messages ?? [])
    .map((message) => message?.content ?? "")
    .join("\n");
  return (
    text.match(/"verifiedReadChunks":\[\{"chunkId":"([^"]+)"/u)?.[1] ??
    "forged-preview-id"
  );
}

function requestedToolName(payload) {
  const tools = Array.isArray(payload.tools) ? payload.tools : [];
  if (!tools.length) return null;
  const available = new Set(
    tools
      .map((tool) => tool?.function?.name ?? tool?.name)
      .filter((name) => typeof name === "string" && name),
  );
  const choice = payload.toolChoice ?? payload.tool_choice;
  const forcedName =
    choice && typeof choice === "object"
      ? (choice.function?.name ?? choice.name)
      : undefined;
  if (typeof forcedName === "string" && available.has(forcedName))
    return forcedName;
  return available.values().next().value ?? null;
}

/**
 * The local fake provider behaves like an OpenAI tool-capable model so browser
 * E2E can verify the protocol without hitting CozAI.  Once a tool result is
 * present it returns ordinary visible text instead of asking for it again.
 */
export function fakeToolCalls(payload) {
  const toolMessages = (payload.messages ?? []).filter(
    (message) => message?.role === "tool",
  );
  const latestTool = toolMessages.at(-1);
  if (latestTool) {
    // Native-tool browser tests must exercise the full host gate, not just a
    // cosmetic first search.  The fake model reads only an id returned in its
    // own preceding search result, exactly like a well-behaved provider.
    try {
      const result = JSON.parse(latestTool.content ?? "{}");
      const firstHit = Array.isArray(result.hits) ? result.hits[0] : null;
      if (typeof firstHit?.chunkId === "string") {
        return [
          {
            id: "fake-tool-call-read-1",
            name: "read_notes",
            arguments: JSON.stringify({ chunkIds: [firstHit.chunkId] }),
          },
        ];
      }
    } catch {
      // Tool-result parsing is deliberately best-effort in the fake only.
    }
    return [];
  }
  const name = requestedToolName(payload);
  if (!name) return [];
  const userText = lastUserMessage(payload).slice(0, 160);
  const argumentsByName = {
    search_notes: JSON.stringify({ query: userText || "测试资料", limit: 3 }),
    read_notes: JSON.stringify({ chunkIds: ["fake-note-chunk-1"] }),
    papertable_probe: JSON.stringify({ probe: "ok" }),
  };
  return [
    {
      id: "fake-tool-call-1",
      name,
      arguments: argumentsByName[name] ?? "{}",
    },
  ];
}

export function fakeScenario(payload) {
  if (
    payload.task === "title" ||
    payload.task === "concepts" ||
    payload.task === "verdict-draft"
  )
    return null;
  const lastUser = lastUserMessage(payload);
  return (
    LEAK_SCENARIOS.find(
      (scenario) =>
        (scenario.task
          ? payload.task === scenario.task
          : // Ordinary chat now enters the shared Harness stream entry point,
            // even when no library is bound.  Keep legacy fixture scenarios
            // valid for that safe no-tool path as well.
            payload.task === "chat" || payload.task === "agent") &&
        lastUser.includes(scenario.tag),
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
  if (payload.task === "verdict-draft")
    return (payload.messages ?? []).some((message) =>
      message?.content?.includes("可独立复用的结论"),
    )
      ? `${S}这轮回答中最值得复用的一条结论`
      : "旧方向依赖被裁掉对话中的旧前提，不再作为默认答案。";
  const systemText = (payload.messages ?? [])
    .filter((message) => message?.role === "system")
    .map((message) => message.content ?? "")
    .join("\n");
  const previewTag = task022Tag(payload);
  if (previewTag && finalSynthesis(payload)) {
    const id = finalEvidenceChunkId(payload);
    if (previewTag === "预览协议重发")
      return finalSynthesisRepair(payload)
        ? `${S}协议修复后的唯一正式回答。[[source:${id}]]`
        : `${S}${"旧预览草稿不得保留。".repeat(8)}<tool_call>泄漏协议</tool_call>`;
    if (previewTag === "预览无哨兵")
      return "这是没有哨兵的最终综合，只能在完整校验后整体提交。";
    if (previewTag === "预览伪引用")
      return (
        `${S}可信事实正在逐字预览。[[source:${id}]]` +
        "引用控制标记在正式校验前只按普通控制数据处理。".repeat(6) +
        "伪引用不会成为有效引用。[[source:forged-preview-id]]"
      );
    if (previewTag === "预览长度重发" && finalSynthesisRepair(payload))
      return `${S}长度修复后的唯一正式回答。[[source:${id}]]`;
    if (previewTag === "预览空响应重发" && finalSynthesisRepair(payload))
      return `${S}空响应修复后的唯一正式回答。[[source:${id}]]`;
    return (
      `${S}${previewTag}第一句已经进入临时预览。` +
      "后续正文持续到达，但在完整协议、长度和引用门禁通过前不会写入正式轮次。".repeat(
        8,
      ) +
      `[[source:${id}]]`
    );
  }
  if (payload.task === "agent" && systemText.includes("只读笔记检索规划器")) {
    return JSON.stringify({ queries: [topic] });
  }
  const toolContent = (payload.messages ?? [])
    .filter((message) => message?.role === "tool")
    .map((message) => message.content ?? "")
    .join("\n");
  const citedId =
    toolContent.match(/"chunkId"\s*:\s*"([^"]+)"/)?.[1] ??
    systemText.match(/\[chunkId=([^\]\s]+)\]/)?.[1];
  if (payload.task === "agent" && citedId)
    return `${S}我已阅读本轮检索到的资料，并据此给出回答。[[source:${citedId}]]`;
  const scenario = fakeScenario(payload);
  if (scenario) return scenario.content;
  // 默认回答也带哨兵：系统提示要求它，fake provider 必须反映真实契约，
  // 否则 e2e 验的是一条真机上不存在的路径。
  return `${S}这是本地验收用的流式回答：${topic}。\n\n它用于验证卡片、上下文、停止与自动保存链路；正式运行时会由 CozAI · Claude Opus 5 回答。`;
}

export async function emitFakeStream({
  payload,
  write,
  signal,
  delayMs = fakeProviderDelayMs(),
  sleepFor = sleep,
}) {
  if (delayMs) await sleepFor(delayMs);
  const toolCalls = fakeToolCalls(payload);
  if (toolCalls.length) {
    for (const [index, toolCall] of toolCalls.entries()) {
      if (signal?.aborted) break;
      write(
        sseEvent("tool-call-delta", {
          index,
          id: toolCall.id,
          name: toolCall.name,
          arguments: toolCall.arguments,
        }),
      );
    }
    write(
      sseEvent("done", {
        stopped: Boolean(signal?.aborted),
        finishReason: "tool_calls",
      }),
    );
    return;
  }
  const content = fakeCompletion(payload);
  const previewTag = task022Tag(payload);
  const isFinalSynthesis = finalSynthesis(payload);
  const isRepair = finalSynthesisRepair(payload);
  if (previewTag === "预览空响应重发" && isFinalSynthesis && !isRepair) {
    write(sseEvent("done", { stopped: false }));
    return;
  }
  // 真实网关会在本机丢弃独立草稿；前端仍以正文哨兵而非服务端标记放行。
  const channel = "unknown";
  // 按码点切块。曾经用 `content.match(/.{1,8}/gu)`，而 `.` 不匹配换行符——它会
  // 静默吞掉流式内容里的每一个 \n，段落边界因此永远不会到达前端。
  const points = Array.from(content);
  const protocolStart =
    previewTag === "预览协议重发" && isFinalSynthesis && !isRepair
      ? points.join("").indexOf("<tool_call>")
      : -1;
  const chunks =
    protocolStart >= 0
      ? [
          points.slice(0, protocolStart + 4).join(""),
          points.slice(protocolStart + 4, protocolStart + 9).join(""),
          points.slice(protocolStart + 9).join(""),
        ]
      : Array.from({ length: Math.ceil(points.length / 8) }, (_, index) =>
          points.slice(index * 8, index * 8 + 8).join(""),
        );
  for (const text of chunks) {
    if (signal?.aborted) break;
    write(sseEvent("token", { text, channel }));
    await sleepFor(25);
  }
  const forceSynthesis =
    previewTag &&
    !isFinalSynthesis &&
    (payload.messages ?? []).some(
      (message) =>
        message?.role === "tool" &&
        (message?.content ?? "").includes('"chunks"'),
    );
  write(
    sseEvent("done", {
      stopped: Boolean(signal?.aborted),
      ...(forceSynthesis ||
      (previewTag === "预览长度重发" && isFinalSynthesis && !isRepair)
        ? { finishReason: "length" }
        : {}),
    }),
  );
}
