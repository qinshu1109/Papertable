/**
 * 桌面端模型通道。走 Tauri 命令，而不是 `fetch("/api/…")`——打包后的应用里没有
 * 那个本机 HTTP 服务。
 *
 * 语义与 `server/index.mjs` 一致，并且同样由 Rust 侧持有目标地址：前端不能指定
 * 上游 URL，这不是开放代理。
 */
import { invoke, Channel } from "@tauri-apps/api/core";
import type { LlmMessage } from "../../types";
import type { OutputChannel } from "../modelOutput";
import type { ModelTask, ProviderConfig, ProviderHealth } from "./http";

export function getProviderHealth(): Promise<ProviderHealth> {
  return invoke<ProviderHealth>("provider_health");
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

type WireEvent =
  | { type: "token"; text: string; channel: OutputChannel }
  | { type: "reasoning"; chars: number }
  | { type: "error"; message: string }
  | { type: "done"; stopped: boolean };

/**
 * 把 Tauri 的 `Channel` 回调桥接成异步生成器，好让调用方的 `for await` 一行不用改。
 *
 * 回调可能比消费者快，所以要有队列；消费者也可能比回调快，所以要有等待者。两边
 * 各存一份，谁先到谁入队。
 */
export async function* streamModel(input: {
  task: ModelTask;
  messages: LlmMessage[];
  signal: AbortSignal;
  temperature?: number;
}) {
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

  const onAbort = () => push({ type: "done", stopped: true });
  input.signal.addEventListener("abort", onAbort, { once: true });

  void invoke<void>("llm_stream", {
    request: {
      task: input.task,
      messages: input.messages,
      temperature: input.temperature,
    },
    channel,
  }).catch((cause: unknown) =>
    push({
      type: "error",
      message: cause instanceof Error ? cause.message : String(cause),
    }),
  );

  const next = () =>
    queue.length
      ? Promise.resolve(queue.shift()!)
      : new Promise<WireEvent>((resolve) => waiters.push(resolve));

  try {
    while (!finished) {
      const event = await next();
      if (event.type === "reasoning") continue; // 只用于进度，永远不进正文
      if (event.type === "error") throw new Error(event.message);
      if (event.type === "done") {
        finished = true;
        return;
      }
      yield {
        type: "token" as const,
        text: event.text,
        channel: event.channel,
      };
    }
  } finally {
    input.signal.removeEventListener("abort", onAbort);
  }
}

export function generateModel(input: {
  task: Exclude<ModelTask, "chat">;
  messages: LlmMessage[];
  temperature?: number;
}): Promise<string> {
  return invoke<string>("llm_generate", { request: input });
}
