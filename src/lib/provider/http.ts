import type { LlmMessage } from "../../types";
import type { OutputChannel } from "../modelOutput";

export interface ProviderHealth {
  configured: boolean;
  model: string;
  baseUrl: string;
  message: string;
}

/** 从本机服务读取的安全配置；永远不包含 API 密钥本身。 */
export interface ProviderConfig {
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
  message?: string;
}

export type ModelTask = "chat" | "concept-preview" | "title" | "concepts";

export async function getProviderHealth(): Promise<ProviderHealth> {
  const response = await fetch("/api/health", { cache: "no-store" });
  const body = (await response.json()) as ProviderHealth;
  if (!response.ok) throw new Error(body.message || "无法检查模型服务。");
  return body;
}

export async function getProviderConfig(): Promise<ProviderConfig> {
  const response = await fetch("/api/config", { cache: "no-store" });
  const body = (await response.json()) as ProviderConfig & { message?: string };
  if (!response.ok) throw new Error(body.message || "无法读取模型设置。");
  return body;
}

export async function saveProviderConfig(input: {
  baseUrl: string;
  model: string;
  /** 留空时由本机服务保留原来的密钥。 */
  apiKey?: string;
}): Promise<ProviderConfig> {
  const response = await fetch("/api/config", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(input),
  });
  const body = (await response
    .json()
    .catch(() => ({ message: "模型设置服务返回异常。" }))) as ProviderConfig & {
    message?: string;
  };
  if (!response.ok) throw new Error(body.message || "无法保存模型设置。");
  return body;
}

export async function* streamModel(input: {
  task: ModelTask;
  messages: LlmMessage[];
  signal: AbortSignal;
  temperature?: number;
}) {
  const response = await fetch("/api/llm/stream", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      task: input.task,
      messages: input.messages,
      temperature: input.temperature,
    }),
    signal: input.signal,
  });
  if (!response.ok || !response.body) {
    const body = await response
      .json()
      .catch(() => ({ message: "无法发起模型请求。" }));
    throw new Error(body.message || "无法发起模型请求。");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      const events = pending.split("\n\n");
      pending = events.pop() ?? "";
      for (const event of events) {
        const type = event.match(/^event:\s*(.+)$/m)?.[1]?.trim();
        const raw = event.match(/^data:\s*(.+)$/m)?.[1];
        if (!type || !raw) continue;
        const payload = JSON.parse(raw) as {
          text?: string;
          message?: string;
          channel?: OutputChannel;
        };
        // 推理事件只带长度、不带文本，仅用于进度指示，绝不进入正文。
        if (type === "reasoning") continue;
        if (type === "token" && payload.text)
          yield {
            type: "token" as const,
            text: payload.text,
            channel: payload.channel ?? ("unknown" as const),
          };
        if (type === "error")
          throw new Error(payload.message || "模型生成失败。");
        if (type === "done") return;
      }
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
}

export async function generateModel(input: {
  task: Exclude<ModelTask, "chat">;
  messages: LlmMessage[];
  temperature?: number;
}) {
  const response = await fetch("/api/llm/generate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = (await response
    .json()
    .catch(() => ({ message: "模型服务返回异常。" }))) as {
    content?: string;
    message?: string;
  };
  if (!response.ok || !body.content)
    throw new Error(body.message || "模型没有返回内容。");
  return body.content;
}
