const encoder = new TextEncoder();

export function friendlyProviderError(status, body = "") {
  if (status === 401) return "模型服务未配置或密钥无效，请检查 .env.local。";
  if (status === 429) return "模型服务暂时限流，请稍后重试。";
  if (status >= 500) return "模型服务暂时不可用，请稍后重试。";
  return body.slice(0, 280) || "模型服务返回了无法处理的响应。";
}

/**
 * 识别正文与草稿推理字段。草稿绝不转发、记录或展示；正文仍要经过客户端哨兵闸门。
 */
export function extractDelta(payload) {
  const delta = payload?.choices?.[0]?.delta ?? {};
  const reasoning =
    delta.reasoning_content ?? delta.reasoning ?? delta.thinking ?? "";
  return {
    content: typeof delta.content === "string" ? delta.content : "",
    reasoning: typeof reasoning === "string" ? reasoning : "",
  };
}

/**
 * OpenAI-compatible providers stream tool calls in `delta.tool_calls`.  Keep
 * this separate from `extractDelta`: tool arguments are protocol data, never
 * visible model prose and therefore must not pass through the answer gate.
 */
export function extractToolCallDeltas(payload) {
  const calls = payload?.choices?.[0]?.delta?.tool_calls;
  if (!Array.isArray(calls)) return [];
  return calls.flatMap((call, fallbackIndex) => {
    if (!call || typeof call !== "object") return [];
    const functionCall = call.function;
    const event = {
      index: Number.isInteger(call.index) ? call.index : fallbackIndex,
      ...(typeof call.id === "string" && call.id ? { id: call.id } : {}),
      ...(typeof functionCall?.name === "string" && functionCall.name
        ? { name: functionCall.name }
        : {}),
      ...(typeof functionCall?.arguments === "string"
        ? { arguments: functionCall.arguments }
        : {}),
    };
    return Object.keys(event).length > 1 ? [event] : [];
  });
}

/** Return normalized completed tool calls from a non-streaming response. */
export function extractToolCalls(payload) {
  const calls = payload?.choices?.[0]?.message?.tool_calls;
  if (!Array.isArray(calls)) return [];
  return calls.flatMap((call) => {
    const functionCall = call?.function;
    if (
      typeof call?.id !== "string" ||
      !call.id ||
      typeof functionCall?.name !== "string" ||
      !functionCall.name
    ) {
      return [];
    }
    return [
      {
        id: call.id,
        name: functionCall.name,
        arguments:
          typeof functionCall.arguments === "string"
            ? functionCall.arguments
            : "{}",
      },
    ];
  });
}

export function extractMessage(payload) {
  const content = payload?.choices?.[0]?.message?.content;
  return typeof content === "string" ? content : "";
}

export function extractFinishReason(payload) {
  const finishReason = payload?.choices?.[0]?.finish_reason;
  return typeof finishReason === "string" && finishReason
    ? finishReason.slice(0, 80)
    : undefined;
}

export function sseEvent(event, payload) {
  return encoder.encode(
    `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`,
  );
}

export async function relayOpenAiStream({ upstream, write, signal }) {
  if (!upstream.ok || !upstream.body) {
    const body = await upstream.text();
    write(
      sseEvent("error", {
        message: friendlyProviderError(upstream.status, body),
        status: upstream.status,
      }),
    );
    write(sseEvent("done", { stopped: false }));
    return;
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let emittedText = false;
  let emittedToolCall = false;
  let finishReason;

  try {
    while (!signal?.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        try {
          const payload = JSON.parse(data);
          const delta = extractDelta(payload);
          if (delta.content) {
            // 只有正文走 answer gate；工具调用和独立推理都绝不作为正文。
            emittedText = true;
            write(
              sseEvent("token", {
                text: delta.content,
                channel: "unknown",
              }),
            );
          }
          for (const toolCall of extractToolCallDeltas(payload)) {
            emittedToolCall = true;
            write(sseEvent("tool-call-delta", toolCall));
          }
          finishReason ??= extractFinishReason(payload);
        } catch {
          // Keep the UI stream alive if a non-JSON provider heartbeat arrives.
        }
      }
    }
  } catch {
    if (!signal?.aborted) {
      write(sseEvent("error", { message: "模型连接中断，请重试。" }));
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }

  if (!emittedText && !emittedToolCall && !signal?.aborted) {
    write(sseEvent("error", { message: "模型没有返回可显示的文本，请重试。" }));
  }
  write(
    sseEvent("done", {
      stopped: Boolean(signal?.aborted),
      ...(finishReason ? { finishReason } : {}),
    }),
  );
}
