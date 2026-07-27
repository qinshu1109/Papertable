import type {
  AgentExecutionMode,
  ProviderMessage,
  ProviderStreamEvent,
  ToolCall,
} from "../../types";
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

export type ModelTask =
  "chat" | "agent" | "concept-preview" | "title" | "concepts";

/** OpenAI-compatible function schema.  Only the Harness owns the two names. */
export interface ProviderTool {
  type?: "function";
  function: {
    name: "search_notes" | "read_notes" | "papertable_probe";
    description?: string;
    parameters: Record<string, unknown>;
  };
}

export interface ProviderCapabilityResult {
  mode: AgentExecutionMode;
  streamingToolCalls: boolean;
  toolResultAccepted: boolean;
  testedAt: string;
  error?: string;
}

/** 密钥实际存在哪。web 端只有本机服务的 .env.local 这一种。 */
export type KeySource = "keychain" | "file" | "none";

export async function getKeySource(): Promise<KeySource> {
  const config = await getProviderConfig();
  return config.hasApiKey ? "file" : "none";
}

/** 这一份构建是什么。web 端没有多份 bundle 的问题，返回固定说明。 */
export interface BuildInfo {
  version: string;
  commit: string;
  builtAt: string;
  exe: string;
  installed: boolean;
}

export function getBuildInfo(): Promise<BuildInfo> {
  return Promise.resolve({
    version: "web",
    commit: "-",
    builtAt: "-",
    exe: "浏览器",
    installed: true,
  });
}

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

/**
 * The local host performs the actual probe so the API key never enters the
 * page.  This result is safe to cache by base URL + model in AppSettings.
 */
export async function probeProviderCapabilities(): Promise<ProviderCapabilityResult> {
  const response = await fetch("/api/llm/capabilities", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "same-origin",
  });
  const body = (await response.json().catch(() => ({}))) as Partial<
    ProviderCapabilityResult & { message: string }
  >;
  if (!response.ok) throw new Error(body.message || "模型能力探测失败。");
  return {
    mode: body.mode === "native-tools" ? "native-tools" : "two-stage",
    streamingToolCalls: Boolean(body.streamingToolCalls),
    toolResultAccepted: Boolean(body.toolResultAccepted),
    testedAt:
      typeof body.testedAt === "string"
        ? body.testedAt
        : new Date().toISOString(),
    ...(typeof body.error === "string" ? { error: body.error } : {}),
  };
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
  messages: ProviderMessage[];
  signal: AbortSignal;
  temperature?: number;
  tools?: ProviderTool[];
  toolChoice?:
    | "auto"
    | "none"
    | "required"
    | {
        type: "function";
        function: { name: ProviderTool["function"]["name"] };
      };
}): AsyncGenerator<ProviderStreamEvent> {
  const response = await fetch("/api/llm/stream", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      task: input.task,
      messages: input.messages,
      temperature: input.temperature,
      ...(input.tools?.length ? { tools: input.tools } : {}),
      ...(input.toolChoice !== undefined
        ? { toolChoice: input.toolChoice }
        : {}),
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
          index?: number;
          id?: string;
          name?: string;
          arguments?: string;
          finishReason?: string;
        };
        if (type === "token" && payload.text)
          yield {
            type: "token" as const,
            text: payload.text,
            channel: payload.channel ?? ("unknown" as const),
          };
        if (type === "tool-call-delta") {
          if (!Number.isInteger(payload.index) || payload.index! < 0) continue;
          yield {
            type: "tool-call-delta",
            index: payload.index!,
            ...(typeof payload.id === "string" ? { id: payload.id } : {}),
            ...(typeof payload.name === "string" ? { name: payload.name } : {}),
            ...(typeof payload.arguments === "string"
              ? { arguments: payload.arguments }
              : {}),
          };
        }
        if (type === "error")
          throw new Error(payload.message || "模型生成失败。");
        if (type === "done") {
          yield {
            type: "done",
            ...(typeof payload.finishReason === "string"
              ? { finishReason: payload.finishReason }
              : {}),
          };
          return;
        }
      }
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
}

export async function completeModel(input: {
  task: Exclude<ModelTask, "chat">;
  messages: ProviderMessage[];
  temperature?: number;
  tools?: ProviderTool[];
  toolChoice?:
    | "auto"
    | "none"
    | "required"
    | {
        type: "function";
        function: { name: ProviderTool["function"]["name"] };
      };
}): Promise<{ content: string; toolCalls: ToolCall[] }> {
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
    toolCalls?: ToolCall[];
  };
  if (
    !response.ok ||
    (typeof body.content !== "string" && !body.toolCalls?.length)
  )
    throw new Error(body.message || "模型没有返回内容。");
  return {
    content: body.content ?? "",
    toolCalls: Array.isArray(body.toolCalls)
      ? body.toolCalls.filter(
          (call): call is ToolCall =>
            Boolean(call) &&
            typeof call.id === "string" &&
            (call.name === "search_notes" ||
              call.name === "read_notes" ||
              call.name === "papertable_probe") &&
            typeof call.arguments === "string",
        )
      : [],
  };
}

/** Text-only helper retained for existing title/concept/preview callers. */
export async function generateModel(input: {
  task: Exclude<ModelTask, "chat">;
  messages: ProviderMessage[];
  temperature?: number;
}): Promise<string> {
  const result = await completeModel(input);
  if (!result.content) throw new Error("模型没有返回内容。");
  return result.content;
}
