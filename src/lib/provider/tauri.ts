/**
 * 桌面端模型通道。走 Tauri 命令，而不是 `fetch("/api/…")`——打包后的应用里没有
 * 那个本机 HTTP 服务。工具协议与 `provider/http.ts` 保持同构，避免桌面版悄悄退回
 * 文本聊天；上游目标地址和 API 密钥仍只存在 Rust 进程里。
 */
import { Channel, invoke } from "@tauri-apps/api/core";
import type {
  AgentExecutionMode,
  ProviderErrorCode,
  ProviderMessage,
  ProviderStreamEvent,
  ToolCall,
} from "../../types";
import type { OutputChannel } from "../modelOutput";
import type {
  BuildInfo,
  KeySource,
  ModelTask,
  ProviderCapabilityResult,
  ProviderConfig,
  ProviderHealth,
  ProviderTool,
} from "./http";
import { ProviderError, providerErrorMessage } from "./http";

export function getProviderHealth(): Promise<ProviderHealth> {
  return invoke<ProviderHealth>("provider_health");
}

export function getBuildInfo(): Promise<BuildInfo> {
  return invoke<BuildInfo>("build_info");
}

export function getKeySource(): Promise<KeySource> {
  return invoke<KeySource>("provider_key_source");
}

export function getProviderConfig(): Promise<ProviderConfig> {
  return invoke<ProviderConfig>("provider_config");
}

export function saveProviderConfig(input: {
  baseUrl: string;
  model: string;
  apiKey?: string;
}): Promise<ProviderConfig> {
  return invoke<ProviderConfig>("save_provider_config", { input });
}

function asIso(value: unknown) {
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0)
      return new Date(parsed).toISOString();
    if (!Number.isNaN(Date.parse(value))) return value;
  }
  return new Date().toISOString();
}

export async function probeProviderCapabilities(): Promise<ProviderCapabilityResult> {
  const result = await invoke<{
    mode?: AgentExecutionMode;
    streamingToolCalls?: boolean;
    toolResultAccepted?: boolean;
    testedAt?: string;
    error?: string;
  }>("provider_probe_capability");
  return {
    mode: result.mode === "native-tools" ? "native-tools" : "two-stage",
    streamingToolCalls: Boolean(result.streamingToolCalls),
    toolResultAccepted: Boolean(result.toolResultAccepted),
    testedAt: asIso(result.testedAt),
    ...(typeof result.error === "string" ? { error: result.error } : {}),
  };
}

type WireEvent =
  | { type: "token"; text: string; channel: OutputChannel }
  | {
      type: "toolCallDelta";
      index: number;
      id?: string;
      name?: string;
      arguments?: string;
    }
  | { type: "error"; message: string; code?: ProviderErrorCode }
  | { type: "done"; stopped: boolean; finishReason?: string };

/** Tauri Channel 回调桥接成与 Web 完全一样的异步事件流。 */
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
  const requestId = crypto.randomUUID();
  const queue: WireEvent[] = [];
  const waiters: ((event: WireEvent) => void)[] = [];
  let finished = false;
  const push = (event: WireEvent) => {
    const waiter = waiters.shift();
    if (waiter) waiter(event);
    else queue.push(event);
  };
  const channel = new Channel<WireEvent>();
  channel.onmessage = push;

  const onAbort = () => {
    void invoke<void>("llm_cancel_stream", { requestId });
    push({ type: "done", stopped: true });
  };
  input.signal.addEventListener("abort", onAbort, { once: true });
  if (input.signal.aborted) {
    onAbort();
    return;
  }
  void invoke<void>("llm_stream", {
    requestId,
    request: {
      task: input.task,
      messages: input.messages,
      temperature: input.temperature,
      ...(input.tools?.length ? { tools: input.tools } : {}),
      ...(input.toolChoice !== undefined
        ? { toolChoice: input.toolChoice }
        : {}),
    },
    channel,
  }).catch((cause: unknown) =>
    push({
      type: "error",
      // Tauri invoke errors may contain internal IPC diagnostics. The message
      // is intentionally not surfaced; all normal provider failures arrive as
      // typed StreamEvent::Error from Rust.
      message:
        cause instanceof Error && input.signal.aborted
          ? cause.message
          : providerErrorMessage("service-unavailable"),
      code: "service-unavailable",
    }),
  );

  const next = () =>
    queue.length
      ? Promise.resolve(queue.shift()!)
      : new Promise<WireEvent>((resolve) => waiters.push(resolve));
  try {
    while (!finished) {
      const event = await next();
      if (event.type === "error") {
        const code = event.code ?? "upstream";
        throw new ProviderError(providerErrorMessage(code), code);
      }
      if (event.type === "done") {
        finished = true;
        yield {
          type: "done",
          ...(event.finishReason ? { finishReason: event.finishReason } : {}),
        };
        return;
      }
      if (event.type === "toolCallDelta") {
        yield {
          type: "tool-call-delta",
          index: event.index,
          ...(typeof event.id === "string" ? { id: event.id } : {}),
          ...(typeof event.name === "string" ? { name: event.name } : {}),
          ...(typeof event.arguments === "string"
            ? { arguments: event.arguments }
            : {}),
        };
        continue;
      }
      yield {
        type: "token",
        text: event.text,
        channel: event.channel,
      };
    }
  } finally {
    input.signal.removeEventListener("abort", onAbort);
    if (!finished) void invoke<void>("llm_cancel_stream", { requestId });
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
  const result = await invoke<{ content?: string; toolCalls?: ToolCall[] }>(
    "llm_complete",
    { request: input },
  );
  const toolCalls = Array.isArray(result.toolCalls)
    ? result.toolCalls.filter(
        (call): call is ToolCall =>
          Boolean(call) &&
          typeof call.id === "string" &&
          (call.name === "search_notes" ||
            call.name === "read_notes" ||
            call.name === "papertable_probe") &&
          typeof call.arguments === "string",
      )
    : [];
  if (typeof result.content !== "string" && !toolCalls.length)
    throw new Error("模型没有返回内容。");
  return { content: result.content ?? "", toolCalls };
}

/** Text-only helper retained for title/concept/preview callers. */
export async function generateModel(input: {
  task: Exclude<ModelTask, "chat">;
  messages: ProviderMessage[];
  temperature?: number;
}): Promise<string> {
  const result = await completeModel(input);
  if (!result.content) throw new Error("模型没有返回内容。");
  return result.content;
}
