const encoder = new TextEncoder();

export function friendlyProviderError(status, body = "") {
  if (status === 401) return "模型服务未配置或密钥无效，请检查 .env.local。";
  if (status === 429) return "模型服务暂时限流，请稍后重试。";
  if (status >= 500) return "模型服务暂时不可用，请稍后重试。";
  return body.slice(0, 280) || "模型服务返回了无法处理的响应。";
}

/**
 * 分离最终正文与草稿推理。网关把推理放进独立字段时，`content` 才是可信的最终
 * 正文——这个事实要传给前端，否则闸门只能靠文本启发式判断。
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

export function extractMessage(payload) {
  return payload?.choices?.[0]?.message?.content ?? "";
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
  let emitted = false;
  let sawReasoning = false;

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
          const delta = extractDelta(JSON.parse(data));
          if (delta.reasoning) {
            sawReasoning = true;
            // 只发长度，不发文本：推理绝不离开本机服务。
            write(sseEvent("reasoning", { chars: delta.reasoning.length }));
          }
          if (delta.content) {
            // `emitted` 只由 content 驱动，只有推理没有正文时仍要报错。
            emitted = true;
            write(
              sseEvent("token", {
                text: delta.content,
                channel: sawReasoning ? "final" : "unknown",
              }),
            );
          }
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

  if (!emitted && !signal?.aborted) {
    write(sseEvent("error", { message: "模型没有返回可显示的文本，请重试。" }));
  }
  write(sseEvent("done", { stopped: Boolean(signal?.aborted) }));
}
