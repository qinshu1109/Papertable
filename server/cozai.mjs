const encoder = new TextEncoder();

export function providerErrorCode(status) {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 429) return "rate-limited";
  if (status === 408 || status === 504) return "timeout";
  if (status >= 500) return "service-unavailable";
  return "invalid-response";
}

export function providerErrorMessage(code) {
  switch (code) {
    case "unauthorized":
      return "模型服务未配置或密钥无效，请在设置页检查。";
    case "rate-limited":
      return "模型服务暂时限流，请稍后重试。";
    case "timeout":
      return "请求超时，请重试。";
    case "disconnected":
      return "连接意外中断，请重试。";
    case "empty-response":
      return "模型服务没有返回可处理的内容，请重试。";
    case "invalid-response":
      return "模型服务返回了无法处理的响应，请重试。";
    case "service-unavailable":
      return "模型服务暂时不可用，请稍后重试。";
    default:
      return "模型请求未能完成，请重试。";
  }
}

export function friendlyProviderError(status) {
  return providerErrorMessage(providerErrorCode(status));
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

/** Normalize only real provider usage fields; absent/invalid usage stays absent. */
export function extractUsage(payload) {
  const usage = payload?.usage;
  if (!usage || typeof usage !== "object") return undefined;
  const finite = (value) =>
    Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
  const inputTokens = finite(usage.input_tokens ?? usage.prompt_tokens);
  const outputTokens = finite(usage.output_tokens ?? usage.completion_tokens);
  const explicitTotal = finite(usage.total_tokens);
  const totalTokens =
    explicitTotal ??
    (inputTokens !== undefined && outputTokens !== undefined
      ? inputTokens + outputTokens
      : undefined);
  if (totalTokens === undefined) return undefined;
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    totalTokens,
  };
}

export function sseEvent(event, payload) {
  return encoder.encode(
    `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`,
  );
}

export async function relayOpenAiStream({
  upstream,
  write,
  signal,
  timeoutCode,
}) {
  if (!upstream.ok || !upstream.body) {
    const body = await upstream.text();
    write(
      sseEvent("error", {
        message: friendlyProviderError(upstream.status, body),
        code: providerErrorCode(upstream.status),
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
  let usage;

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
          usage ??= extractUsage(payload);
        } catch {
          // Keep the UI stream alive if a non-JSON provider heartbeat arrives.
        }
      }
    }
  } catch {
    if (!signal?.aborted) {
      write(
        sseEvent("error", {
          message: providerErrorMessage("disconnected"),
          code: "disconnected",
        }),
      );
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }

  if (signal?.aborted && timeoutCode === "timeout") {
    write(
      sseEvent("error", {
        message: providerErrorMessage("timeout"),
        code: "timeout",
      }),
    );
  } else if (!emittedText && !emittedToolCall && !signal?.aborted) {
    write(
      sseEvent("error", {
        message: providerErrorMessage("empty-response"),
        code: "empty-response",
      }),
    );
  }
  write(
    sseEvent("done", {
      stopped: Boolean(signal?.aborted),
      ...(finishReason ? { finishReason } : {}),
      ...(usage ? { usage } : {}),
    }),
  );
}
