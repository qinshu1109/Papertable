import {
  createAssistantMessageEventStream,
  parseStreamingJson,
  type Api,
  type AssistantMessage,
  type Context,
  type Message,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";

export type RustProviderMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content?: string;
  toolCalls?: { id: string; name: string; arguments: string }[];
  toolCallId?: string;
};

export type RustProviderEvent =
  | { type: "token"; text: string; channel: "unknown" }
  | {
      type: "tool-call-delta";
      index: number;
      id?: string;
      name?: string;
      arguments?: string;
    }
  | { type: "done"; finishReason?: string };

export type RustProviderStream = (input: {
  task: "agent";
  messages: RustProviderMessage[];
  signal: AbortSignal;
  temperature?: number;
  tools?: {
    type: "function";
    function: {
      name: string;
      description: string;
      parameters: Record<string, unknown>;
    };
  }[];
  toolChoice: "auto";
}) => AsyncGenerator<RustProviderEvent>;

export const PAPERTABLE_PI_MODEL: Model<"openai-completions"> = {
  id: "papertable-configured-flagship",
  name: "Papertable configured flagship",
  api: "openai-completions",
  provider: "papertable-rust",
  baseUrl: "tauri://llm_stream",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 16_384,
};

const EMPTY_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function textOf(content: Message["content"], role: Message["role"]): string {
  if (typeof content === "string") return content;
  const unsupported = content.some((part) => part.type !== "text");
  if (unsupported) {
    throw new Error(`${role} message contains unsupported non-text content`);
  }
  return content.map((part) => part.text).join("");
}

export function toRustMessages(context: Context): RustProviderMessage[] {
  const messages: RustProviderMessage[] = [];
  if (context.systemPrompt?.trim()) {
    messages.push({ role: "system", content: context.systemPrompt });
  }
  for (const message of context.messages) {
    if (message.role === "user") {
      messages.push({
        role: "user",
        content: textOf(message.content, message.role),
      });
      continue;
    }
    if (message.role === "assistant") {
      const text = message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("");
      const toolCalls = message.content
        .filter((part) => part.type === "toolCall")
        .map((call) => ({
          id: call.id,
          name: call.name,
          arguments: JSON.stringify(call.arguments),
        }));
      messages.push({
        role: "assistant",
        ...(text ? { content: text } : {}),
        ...(toolCalls.length ? { toolCalls } : {}),
      });
      continue;
    }
    messages.push({
      role: "tool",
      toolCallId: message.toolCallId,
      content: textOf(message.content, message.role),
    });
  }
  return messages;
}

function copyMessage(message: AssistantMessage): AssistantMessage {
  return {
    ...message,
    content: message.content.map((part) => ({ ...part })),
    usage: {
      ...message.usage,
      cost: { ...message.usage.cost },
    },
  };
}

function failureMessage(
  model: Model<Api>,
  reason: "aborted" | "error",
  cause: unknown,
): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: EMPTY_USAGE,
    stopReason: reason,
    errorMessage:
      reason === "aborted"
        ? "Papertable Rust stream aborted"
        : cause instanceof Error
          ? cause.message
          : "Papertable Rust stream failed",
    timestamp: Date.now(),
  };
}

/**
 * Adapts Papertable's existing Rust-owned Tauri stream to Pi's StreamFn.
 * The API key is never accepted here: provider.json remains Rust-only.
 */
export function createPapertablePiStream(
  rustStream: RustProviderStream,
): StreamFn {
  return (
    model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions,
  ) => {
    const output = createAssistantMessageEventStream();
    const partial: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: EMPTY_USAGE,
      stopReason: "stop",
      timestamp: Date.now(),
    };
    output.push({ type: "start", partial: copyMessage(partial) });

    void (async () => {
      let textIndex: number | undefined;
      const calls = new Map<
        number,
        { contentIndex: number; rawArguments: string }
      >();
      try {
        const signal = options?.signal ?? new AbortController().signal;
        const tools = context.tools?.map((tool) => ({
          type: "function" as const,
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters as Record<string, unknown>,
          },
        }));
        for await (const event of rustStream({
          task: "agent",
          messages: toRustMessages(context),
          signal,
          temperature: options?.temperature,
          ...(tools?.length ? { tools } : {}),
          toolChoice: "auto",
        })) {
          if (signal.aborted) {
            throw new DOMException("Aborted", "AbortError");
          }
          if (event.type === "token") {
            if (textIndex === undefined) {
              textIndex = partial.content.length;
              partial.content.push({ type: "text", text: "" });
              output.push({
                type: "text_start",
                contentIndex: textIndex,
                partial: copyMessage(partial),
              });
            }
            const text = partial.content[textIndex];
            if (text?.type === "text") text.text += event.text;
            output.push({
              type: "text_delta",
              contentIndex: textIndex,
              delta: event.text,
              partial: copyMessage(partial),
            });
            continue;
          }
          if (event.type === "tool-call-delta") {
            let state = calls.get(event.index);
            if (!state) {
              state = {
                contentIndex: partial.content.length,
                rawArguments: "",
              };
              calls.set(event.index, state);
              partial.content.push({
                type: "toolCall",
                id: event.id ?? "",
                name: event.name ?? "",
                arguments: {},
              });
              output.push({
                type: "toolcall_start",
                contentIndex: state.contentIndex,
                partial: copyMessage(partial),
              });
            }
            const call = partial.content[state.contentIndex];
            if (call?.type !== "toolCall") {
              throw new Error("tool-call content index collision");
            }
            if (event.id) call.id = event.id;
            if (event.name) call.name = event.name;
            if (event.arguments !== undefined) {
              state.rawArguments += event.arguments;
              call.arguments = parseStreamingJson(state.rawArguments);
            }
            output.push({
              type: "toolcall_delta",
              contentIndex: state.contentIndex,
              delta: event.arguments ?? "",
              partial: copyMessage(partial),
            });
            continue;
          }

          if (textIndex !== undefined) {
            const text = partial.content[textIndex];
            output.push({
              type: "text_end",
              contentIndex: textIndex,
              content: text?.type === "text" ? text.text : "",
              partial: copyMessage(partial),
            });
          }
          for (const state of calls.values()) {
            const call = partial.content[state.contentIndex];
            if (call?.type !== "toolCall" || !call.id || !call.name) {
              throw new Error("Rust stream ended with an incomplete tool call");
            }
            output.push({
              type: "toolcall_end",
              contentIndex: state.contentIndex,
              toolCall: { ...call },
              partial: copyMessage(partial),
            });
          }
          const reason =
            event.finishReason === "length"
              ? "length"
              : calls.size > 0 || event.finishReason === "tool_calls"
                ? "toolUse"
                : "stop";
          partial.stopReason = reason;
          const message = copyMessage(partial);
          output.push({ type: "done", reason, message });
          return;
        }
        throw new Error("Papertable Rust stream ended without done");
      } catch (cause) {
        const aborted =
          options?.signal?.aborted ||
          (cause instanceof DOMException && cause.name === "AbortError");
        const error = failureMessage(
          model,
          aborted ? "aborted" : "error",
          cause,
        );
        output.push({
          type: "error",
          reason: aborted ? "aborted" : "error",
          error,
        });
      }
    })();

    return output;
  };
}
