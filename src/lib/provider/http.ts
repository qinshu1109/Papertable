import type {
  AgentExecutionMode,
  CapabilityProbeProgressEvent,
  CapabilityStageResult,
  ProviderErrorCode,
  ProviderMessage,
  ProviderStreamEvent,
  ToolCall,
} from "../../types";
import type { OutputChannel } from "../modelOutput";
import { agentTerminalErrorMessage } from "../agentTerminal";
import type { ProviderUsage } from "../agentBudget";
import {
  OPENAI_GATEWAY_RESPONSE_SHAPE,
  PROTOCOL_ADAPTER_VERSION,
} from "./capabilityGate";

export interface ProviderHealth {
  configured: boolean;
  model: string;
  baseUrl: string;
  message: string;
}

/**
 * A typed, already-sanitised provider failure.  Provider transports are never
 * allowed to put an upstream URL, EOF detail, or server body into the UI.
 */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly code: ProviderErrorCode,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export function providerErrorMessage(code: ProviderErrorCode): string {
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
      return agentTerminalErrorMessage("provider-empty-response");
    case "invalid-response":
      return "模型服务返回了无法处理的响应，请重试。";
    case "service-unavailable":
      return "模型服务暂时不可用，请稍后重试。";
    case "upstream":
      return "模型请求未能完成，请重试。";
  }
}

export function providerErrorCodeForStatus(status: number): ProviderErrorCode {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 429) return "rate-limited";
  if (status === 408 || status === 504) return "timeout";
  if (status >= 500) return "service-unavailable";
  return "invalid-response";
}

function providerErrorFromStatus(status: number): ProviderError {
  const code = providerErrorCodeForStatus(status);
  return new ProviderError(providerErrorMessage(code), code);
}

async function readJsonSafely(
  response: Response,
): Promise<Record<string, unknown> | null> {
  const text = await response.text().catch(() => "");
  if (!text.trim()) return null;
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** 从本机服务读取的安全配置；永远不包含 API 密钥本身。 */
export interface ProviderConfig {
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
  message?: string;
}

export type ModelTask =
  "chat" | "agent" | "concept-preview" | "title" | "concepts" | "verdict-draft";

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
  protocolAdapterVersion: string;
  gatewayResponseShape: string;
  toolCallEmission: CapabilityStageResult;
  toolResultAcceptance: CapabilityStageResult;
  streamingToolCallDelta: CapabilityStageResult;
  testedAt: string;
  unavailableReason?: string;
}

export type CapabilityProbeProgressHandler = (
  event: CapabilityProbeProgressEvent,
) => void;

/** 密钥实际存在哪。Web 端为本机服务的 .env.local；桌面端为 0600 文件。 */
export type KeySource = "file" | "none";

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
  identifier: string;
  isolated: boolean;
}

export function getBuildInfo(): Promise<BuildInfo> {
  return Promise.resolve({
    version: "web",
    commit: "-",
    builtAt: "-",
    exe: "浏览器",
    installed: true,
    identifier: "web",
    isolated: true,
  });
}

export async function getProviderHealth(): Promise<ProviderHealth> {
  let response: Response;
  try {
    response = await fetch("/api/health", { cache: "no-store" });
  } catch {
    throw new ProviderError(
      providerErrorMessage("disconnected"),
      "disconnected",
    );
  }
  const body = await readJsonSafely(response);
  if (!response.ok) throw providerErrorFromStatus(response.status);
  if (
    !body ||
    typeof body.configured !== "boolean" ||
    typeof body.model !== "string" ||
    typeof body.baseUrl !== "string" ||
    typeof body.message !== "string"
  ) {
    throw new ProviderError(
      providerErrorMessage("invalid-response"),
      "invalid-response",
    );
  }
  return body as unknown as ProviderHealth;
}

export async function getProviderConfig(): Promise<ProviderConfig> {
  let response: Response;
  try {
    response = await fetch("/api/config", { cache: "no-store" });
  } catch {
    throw new ProviderError(
      providerErrorMessage("disconnected"),
      "disconnected",
    );
  }
  const body = await readJsonSafely(response);
  if (!response.ok) throw providerErrorFromStatus(response.status);
  if (
    !body ||
    typeof body.baseUrl !== "string" ||
    typeof body.model !== "string" ||
    typeof body.hasApiKey !== "boolean"
  ) {
    throw new ProviderError(
      providerErrorMessage("invalid-response"),
      "invalid-response",
    );
  }
  return body as unknown as ProviderConfig;
}

/**
 * The local host performs the actual probe so the API key never enters the
 * page.  This result is safe to cache by base URL + model in AppSettings.
 */
export async function probeProviderCapabilities(
  onProgress?: CapabilityProbeProgressHandler,
): Promise<ProviderCapabilityResult> {
  void onProgress;
  const response = await fetch("/api/llm/capabilities", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "same-origin",
  });
  const body = await readJsonSafely(response);
  if (!response.ok) throw providerErrorFromStatus(response.status);
  return normalizeProviderCapabilityResult(body);
}

function normalizeStage(
  value: unknown,
  fallback: string,
): CapabilityStageResult {
  const stage =
    value && typeof value === "object"
      ? (value as {
          status?: unknown;
          detail?: unknown;
          durationMs?: unknown;
        })
      : undefined;
  const status =
    stage?.status === "passed" ||
    stage?.status === "failed" ||
    stage?.status === "not-run"
      ? stage.status
      : "failed";
  return {
    status,
    ...(typeof stage?.detail === "string"
      ? { detail: stage.detail.slice(0, 240) }
      : status === "failed"
        ? { detail: fallback }
        : {}),
    ...(typeof stage?.durationMs === "number" &&
    Number.isFinite(stage.durationMs) &&
    stage.durationMs >= 0
      ? { durationMs: Math.round(stage.durationMs) }
      : {}),
  };
}

export function normalizeCapabilityProbeProgressEvent(
  value: unknown,
): CapabilityProbeProgressEvent | null {
  const event =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  if (
    event.stage !== "toolCallEmission" &&
    event.stage !== "toolResultAcceptance" &&
    event.stage !== "streamingToolCallDelta"
  )
    return null;
  if (
    event.status !== "started" &&
    event.status !== "passed" &&
    event.status !== "failed"
  )
    return null;
  return {
    stage: event.stage,
    status: event.status,
    ...(typeof event.durationMs === "number" &&
    Number.isFinite(event.durationMs) &&
    event.durationMs >= 0
      ? { durationMs: Math.round(event.durationMs) }
      : {}),
  };
}

/** Shared web/Tauri public-shape validator; unknown fields fail closed. */
export function normalizeProviderCapabilityResult(
  value: unknown,
): ProviderCapabilityResult {
  const body =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const toolCallEmission = normalizeStage(
    body.toolCallEmission,
    "探测结果缺少工具调用发出状态。",
  );
  const toolResultAcceptance = normalizeStage(
    body.toolResultAcceptance,
    "探测结果缺少工具结果回灌状态。",
  );
  const streamingToolCallDelta = normalizeStage(
    body.streamingToolCallDelta,
    "探测结果缺少流式工具调用增量状态。",
  );
  const protocolAdapterVersion =
    typeof body.protocolAdapterVersion === "string"
      ? body.protocolAdapterVersion
      : "unknown";
  const gatewayResponseShape =
    typeof body.gatewayResponseShape === "string"
      ? body.gatewayResponseShape
      : "unknown";
  const stagesPassed = [
    toolCallEmission,
    toolResultAcceptance,
    streamingToolCallDelta,
  ].every((stage) => stage.status === "passed");
  const testedAtValid =
    typeof body.testedAt === "string" &&
    !Number.isNaN(Date.parse(body.testedAt));
  const admitted =
    body.mode === "native-tools" &&
    stagesPassed &&
    testedAtValid &&
    protocolAdapterVersion === PROTOCOL_ADAPTER_VERSION &&
    gatewayResponseShape === OPENAI_GATEWAY_RESPONSE_SHAPE;
  return {
    mode: admitted ? "native-tools" : "unavailable",
    protocolAdapterVersion,
    gatewayResponseShape,
    toolCallEmission,
    toolResultAcceptance,
    streamingToolCallDelta,
    testedAt: testedAtValid
      ? (body.testedAt as string)
      : new Date().toISOString(),
    ...(typeof body.unavailableReason === "string"
      ? { unavailableReason: body.unavailableReason.slice(0, 240) }
      : {}),
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
  const body = await readJsonSafely(response);
  if (!response.ok) throw providerErrorFromStatus(response.status);
  if (
    !body ||
    typeof body.baseUrl !== "string" ||
    typeof body.model !== "string" ||
    typeof body.hasApiKey !== "boolean"
  ) {
    throw new ProviderError(
      providerErrorMessage("invalid-response"),
      "invalid-response",
    );
  }
  return body as unknown as ProviderConfig;
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
  let response: Response;
  try {
    response = await fetch("/api/llm/stream", {
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
  } catch (error) {
    if (input.signal.aborted) throw error;
    throw new ProviderError(
      providerErrorMessage("disconnected"),
      "disconnected",
    );
  }
  if (!response.ok || !response.body) {
    throw providerErrorFromStatus(response.status || 502);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let completed = false;
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
        let payload: {
          text?: string;
          message?: string;
          code?: ProviderErrorCode;
          channel?: OutputChannel;
          index?: number;
          id?: string;
          name?: string;
          arguments?: string;
          finishReason?: string;
          usage?: ProviderUsage;
          gatewayResponseShape?: string;
        };
        try {
          payload = JSON.parse(raw) as typeof payload;
        } catch {
          throw new ProviderError(
            providerErrorMessage("invalid-response"),
            "invalid-response",
          );
        }
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
        if (type === "error") {
          const code = payload.code ?? "upstream";
          throw new ProviderError(providerErrorMessage(code), code);
        }
        if (type === "done") {
          completed = true;
          yield {
            type: "done",
            ...(typeof payload.finishReason === "string"
              ? { finishReason: payload.finishReason }
              : {}),
            ...(payload.usage ? { usage: payload.usage } : {}),
            ...(typeof payload.gatewayResponseShape === "string"
              ? { gatewayResponseShape: payload.gatewayResponseShape }
              : {}),
          };
          return;
        }
      }
    }
    if (!completed && !input.signal.aborted) {
      throw new ProviderError(
        providerErrorMessage("disconnected"),
        "disconnected",
      );
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
}): Promise<{
  content: string;
  toolCalls: ToolCall[];
  usage?: ProviderUsage;
}> {
  let response: Response;
  try {
    response = await fetch("/api/llm/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  } catch {
    throw new ProviderError(
      providerErrorMessage("disconnected"),
      "disconnected",
    );
  }
  const body = (await readJsonSafely(response)) as {
    content?: string;
    toolCalls?: ToolCall[];
    usage?: ProviderUsage;
  } | null;
  if (
    !response.ok ||
    !body ||
    (typeof body.content !== "string" && !body.toolCalls?.length)
  )
    throw !response.ok
      ? providerErrorFromStatus(response.status)
      : new ProviderError(
          providerErrorMessage("empty-response"),
          "empty-response",
        );
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
    ...(body.usage ? { usage: body.usage as ProviderUsage } : {}),
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
