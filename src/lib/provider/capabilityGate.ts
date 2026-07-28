import type {
  AppSettings,
  CapabilityStageResult,
  ProviderCapability,
} from "../../types";
import type { ProviderCapabilityResult } from "./http";

export const DEFAULT_CAPABILITY_TTL_MS = 24 * 60 * 60 * 1_000;
export const MIN_CAPABILITY_TTL_MS = 60_000;
export const MAX_CAPABILITY_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
export const PROTOCOL_ADAPTER_VERSION = "openai-native-tools-v1";
export const OPENAI_GATEWAY_RESPONSE_SHAPE = "openai-chat-completions-v1";

export type CapabilityInvalidationReason =
  | "settings-changed"
  | "adapter-version-changed"
  | "runtime-protocol-error"
  | "gateway-response-shape-changed"
  | "ttl-expired"
  | "manual-reprobe";

export function capabilityCacheKey(input: {
  baseUrl: string;
  model: string;
  protocolAdapterVersion?: string;
}) {
  return [
    input.baseUrl,
    input.model,
    input.protocolAdapterVersion ?? PROTOCOL_ADAPTER_VERSION,
  ].join("\u001f");
}

export function clampCapabilityTtl(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_CAPABILITY_TTL_MS;
  return Math.min(
    MAX_CAPABILITY_TTL_MS,
    Math.max(MIN_CAPABILITY_TTL_MS, Math.round(value!)),
  );
}

export function capabilityStagesPassed(
  input: Pick<
    ProviderCapability,
    "toolCallEmission" | "toolResultAcceptance" | "streamingToolCallDelta"
  >,
) {
  return (
    input.toolCallEmission.status === "passed" &&
    input.toolResultAcceptance.status === "passed" &&
    input.streamingToolCallDelta.status === "passed"
  );
}

export function capabilityUnavailableReason(
  input: Pick<
    ProviderCapability,
    "toolCallEmission" | "toolResultAcceptance" | "streamingToolCallDelta"
  >,
) {
  const failed = [
    ["工具调用发出", input.toolCallEmission],
    ["工具结果回灌", input.toolResultAcceptance],
    ["流式工具调用增量", input.streamingToolCallDelta],
  ] as const;
  const item = failed.find(([, stage]) => stage.status !== "passed");
  if (!item) return undefined;
  const [label, stage] = item;
  return `${label}${stage.status === "not-run" ? "未完成" : "未通过"}${
    stage.detail ? `：${stage.detail}` : ""
  }`;
}

export function isCapabilityAdmitted(
  capability: ProviderCapability | undefined,
  now = Date.now(),
): capability is ProviderCapability & { mode: "native-tools" } {
  return Boolean(
    capability &&
    capability.schemaVersion === 1 &&
    capability.mode === "native-tools" &&
    capability.protocolAdapterVersion === PROTOCOL_ADAPTER_VERSION &&
    capability.gatewayResponseShape === OPENAI_GATEWAY_RESPONSE_SHAPE &&
    now < capability.expiresAt &&
    capabilityStagesPassed(capability),
  );
}

export function capabilityInvalidationReason(input: {
  capability: ProviderCapability;
  baseUrl: string;
  model: string;
  now: number;
  observedGatewayResponseShape?: string;
}): CapabilityInvalidationReason | undefined {
  const { capability } = input;
  if (capability.baseUrl !== input.baseUrl || capability.model !== input.model)
    return "settings-changed";
  if (capability.protocolAdapterVersion !== PROTOCOL_ADAPTER_VERSION)
    return "adapter-version-changed";
  if (
    input.observedGatewayResponseShape &&
    capability.gatewayResponseShape !== input.observedGatewayResponseShape
  )
    return "gateway-response-shape-changed";
  if (input.now >= capability.expiresAt) return "ttl-expired";
  return undefined;
}

export function currentCapability(
  settings: AppSettings,
  now = Date.now(),
): ProviderCapability | undefined {
  const baseUrl = settings.providerBaseUrl ?? "https://cozai.net/v1";
  return settings.providerCapabilities?.find(
    (capability) =>
      !capabilityInvalidationReason({
        capability,
        baseUrl,
        model: settings.model,
        now,
      }),
  );
}

/** Drops pre-TASK-010 capability rows that cannot prove three-stage admission. */
export function migrateCapabilityCache(value: unknown): ProviderCapability[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is ProviderCapability => {
    if (!entry || typeof entry !== "object") return false;
    const candidate = entry as Partial<ProviderCapability>;
    return (
      candidate.schemaVersion === 1 &&
      typeof candidate.baseUrl === "string" &&
      typeof candidate.model === "string" &&
      typeof candidate.protocolAdapterVersion === "string" &&
      typeof candidate.gatewayResponseShape === "string" &&
      typeof candidate.testedAt === "number" &&
      typeof candidate.expiresAt === "number" &&
      typeof candidate.ttlMs === "number" &&
      Boolean(candidate.toolCallEmission) &&
      Boolean(candidate.toolResultAcceptance) &&
      Boolean(candidate.streamingToolCallDelta)
    );
  });
}

export function invalidateCapabilityEntries(
  entries: ProviderCapability[] | undefined,
  input: {
    baseUrl: string;
    model: string;
    reason: CapabilityInvalidationReason;
    nextBaseUrl?: string;
    nextModel?: string;
  },
) {
  const targets = new Set([
    `${input.baseUrl}\u001f${input.model}`,
    ...(input.nextBaseUrl && input.nextModel
      ? [`${input.nextBaseUrl}\u001f${input.nextModel}`]
      : []),
  ]);
  return (entries ?? []).filter(
    (entry) => !targets.has(`${entry.baseUrl}\u001f${entry.model}`),
  );
}

function safeStage(
  stage: CapabilityStageResult | undefined,
  fallback: string,
): CapabilityStageResult {
  if (
    stage?.status === "passed" ||
    stage?.status === "failed" ||
    stage?.status === "not-run"
  )
    return {
      status: stage.status,
      ...(typeof stage.detail === "string"
        ? { detail: stage.detail.slice(0, 240) }
        : {}),
    };
  return { status: "failed", detail: fallback };
}

export function capabilityFromProbe(input: {
  baseUrl: string;
  model: string;
  ttlMs: number;
  probe: ProviderCapabilityResult;
  now: number;
}): ProviderCapability {
  const ttlMs = clampCapabilityTtl(input.ttlMs);
  const testedAt = Date.parse(input.probe.testedAt) || input.now;
  const stages = {
    toolCallEmission: safeStage(
      input.probe.toolCallEmission,
      "探测结果缺少工具调用发出状态。",
    ),
    toolResultAcceptance: safeStage(
      input.probe.toolResultAcceptance,
      "探测结果缺少工具结果回灌状态。",
    ),
    streamingToolCallDelta: safeStage(
      input.probe.streamingToolCallDelta,
      "探测结果缺少流式工具调用增量状态。",
    ),
  };
  const adapterMatches =
    input.probe.protocolAdapterVersion === PROTOCOL_ADAPTER_VERSION;
  const shape =
    typeof input.probe.gatewayResponseShape === "string"
      ? input.probe.gatewayResponseShape.slice(0, 120)
      : "unknown";
  const unavailableReason =
    (input.probe.mode !== "native-tools" &&
      (input.probe.unavailableReason ??
        "三段原生工具能力探测未确认 Agent 准入。")) ||
    (!adapterMatches && "协议适配层版本不匹配，必须重新探测。") ||
    (shape !== OPENAI_GATEWAY_RESPONSE_SHAPE &&
      "网关返回结构不是已验证的 OpenAI Chat Completions 形状。") ||
    capabilityUnavailableReason(stages);
  return {
    schemaVersion: 1,
    baseUrl: input.baseUrl,
    model: input.model,
    mode: unavailableReason ? "unavailable" : "native-tools",
    protocolAdapterVersion: input.probe.protocolAdapterVersion,
    gatewayResponseShape: shape,
    ...stages,
    testedAt,
    expiresAt: testedAt + ttlMs,
    ttlMs,
    ...(unavailableReason ? { unavailableReason } : {}),
  };
}

export function failedCapability(input: {
  baseUrl: string;
  model: string;
  ttlMs: number;
  now: number;
  detail: string;
}): ProviderCapability {
  const stage = (status: "failed" | "not-run"): CapabilityStageResult => ({
    status,
    detail: input.detail.slice(0, 240),
  });
  return {
    schemaVersion: 1,
    baseUrl: input.baseUrl,
    model: input.model,
    mode: "unavailable",
    protocolAdapterVersion: PROTOCOL_ADAPTER_VERSION,
    gatewayResponseShape: "unknown",
    toolCallEmission: stage("failed"),
    toolResultAcceptance: stage("not-run"),
    streamingToolCallDelta: stage("not-run"),
    testedAt: input.now,
    expiresAt: input.now + clampCapabilityTtl(input.ttlMs),
    ttlMs: clampCapabilityTtl(input.ttlMs),
    unavailableReason: input.detail.slice(0, 240),
  };
}

type CoordinatorSettings = Pick<
  AppSettings,
  "model" | "providerBaseUrl" | "providerCapabilities"
>;

export function createCapabilityProbeCoordinator() {
  const inFlight = new Map<string, Promise<ProviderCapability>>();
  const epochs = new Map<string, number>();

  return async function ensure(input: {
    baseUrl: string;
    model: string;
    ttlMs: number;
    force?: boolean;
    reason?: CapabilityInvalidationReason;
    now(): number;
    read(): CoordinatorSettings;
    write(
      update: (entries: ProviderCapability[]) => ProviderCapability[],
    ): void;
    probe(): Promise<ProviderCapabilityResult>;
    onReprobing?(active: boolean): void;
  }): Promise<ProviderCapability> {
    const key = capabilityCacheKey(input);
    const now = input.now();
    const cached = input
      .read()
      .providerCapabilities?.find(
        (capability) =>
          capability.baseUrl === input.baseUrl &&
          capability.model === input.model,
      );
    if (
      !input.force &&
      cached &&
      !capabilityInvalidationReason({
        capability: cached,
        baseUrl: input.baseUrl,
        model: input.model,
        now,
      })
    )
      return cached;
    const running = inFlight.get(key);
    if (running) return running;

    const epoch = (epochs.get(key) ?? 0) + 1;
    epochs.set(key, epoch);
    input.write((entries) =>
      invalidateCapabilityEntries(entries, {
        baseUrl: input.baseUrl,
        model: input.model,
        reason:
          input.reason ?? (input.force ? "manual-reprobe" : "ttl-expired"),
      }),
    );
    input.onReprobing?.(true);
    const operation = (async () => {
      let capability: ProviderCapability;
      try {
        capability = capabilityFromProbe({
          baseUrl: input.baseUrl,
          model: input.model,
          ttlMs: input.ttlMs,
          probe: await input.probe(),
          now: input.now(),
        });
      } catch {
        capability = failedCapability({
          baseUrl: input.baseUrl,
          model: input.model,
          ttlMs: input.ttlMs,
          now: input.now(),
          detail: "模型能力探测失败；Agent 模式不可用。",
        });
      }
      const latest = input.read();
      if (
        latest.model !== input.model ||
        (latest.providerBaseUrl ?? "https://cozai.net/v1") !== input.baseUrl ||
        epochs.get(key) !== epoch
      )
        return failedCapability({
          baseUrl: input.baseUrl,
          model: input.model,
          ttlMs: input.ttlMs,
          now: input.now(),
          detail: "探测期间模型设置已变化；旧探测结果已丢弃。",
        });
      input.write((entries) =>
        [
          ...entries.filter(
            (entry) =>
              entry.baseUrl !== input.baseUrl || entry.model !== input.model,
          ),
          capability,
        ].slice(-12),
      );
      return capability;
    })().finally(() => {
      if (epochs.get(key) === epoch) input.onReprobing?.(false);
      inFlight.delete(key);
    });
    inFlight.set(key, operation);
    return operation;
  };
}
