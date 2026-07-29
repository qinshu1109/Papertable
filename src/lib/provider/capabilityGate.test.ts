import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { AppSettings, ProviderCapability } from "../../types";
import {
  DEFAULT_CAPABILITY_TTL_MS,
  OPENAI_GATEWAY_RESPONSE_SHAPE,
  PROTOCOL_ADAPTER_VERSION,
  capabilityFromProbe,
  capabilityInvalidationReason,
  createCapabilityProbeCoordinator,
  invalidateCapabilityEntries,
  isCapabilityAdmitted,
  migrateCapabilityCache,
} from "./capabilityGate";
import type { ProviderCapabilityResult } from "./http";

const passedProbe = (
  overrides: Partial<ProviderCapabilityResult> = {},
): ProviderCapabilityResult => ({
  mode: "native-tools",
  protocolAdapterVersion: PROTOCOL_ADAPTER_VERSION,
  gatewayResponseShape: OPENAI_GATEWAY_RESPONSE_SHAPE,
  toolCallEmission: { status: "passed", durationMs: 91 },
  toolResultAcceptance: { status: "passed", durationMs: 102 },
  streamingToolCallDelta: { status: "passed", durationMs: 45 },
  testedAt: "2026-07-28T00:00:00.000Z",
  ...overrides,
});

const admitted = (overrides: Partial<ProviderCapability> = {}) => ({
  ...capabilityFromProbe({
    baseUrl: "https://gateway.example/v1",
    model: "flagship",
    ttlMs: DEFAULT_CAPABILITY_TTL_MS,
    probe: passedProbe(),
    now: Date.parse("2026-07-28T00:00:00.000Z"),
  }),
  ...overrides,
});

test("default TTL is 24 hours and expiry requires a fresh probe", async () => {
  const now = Date.parse("2026-07-28T00:00:00.000Z");
  const expired = admitted();
  assert.equal(
    isCapabilityAdmitted({ ...expired, expiresAt: now }, now),
    false,
  );
  let settings: AppSettings = {
    id: "app",
    model: "flagship",
    providerBaseUrl: "https://gateway.example/v1",
    providerCapabilities: [{ ...expired, expiresAt: now }],
  };
  let probes = 0;
  const ensure = createCapabilityProbeCoordinator();
  const result = await ensure({
    baseUrl: settings.providerBaseUrl!,
    model: settings.model,
    ttlMs: DEFAULT_CAPABILITY_TTL_MS,
    now: () => now + 1,
    read: () => settings,
    write: (update) => {
      settings = {
        ...settings,
        providerCapabilities: update(settings.providerCapabilities ?? []),
      };
    },
    probe: async () => {
      probes += 1;
      return passedProbe({ testedAt: new Date(now + 1).toISOString() });
    },
  });
  assert.equal(probes, 1);
  assert.equal(result.ttlMs, 24 * 60 * 60 * 1_000);
  assert.equal(result.expiresAt - result.testedAt, DEFAULT_CAPABILITY_TTL_MS);
  assert.equal(result.toolCallEmission.durationMs, 91);
  assert.equal(result.toolResultAcceptance.durationMs, 102);
  assert.equal(result.streamingToolCallDelta.durationMs, 45);
  assert.ok(isCapabilityAdmitted(result, now + 1));
});

test("settings, adapter, and gateway-shape invalidators are explicit and deterministic", () => {
  const capability = admitted();
  const common = {
    capability,
    baseUrl: capability.baseUrl,
    model: capability.model,
    now: capability.testedAt + 1,
  };
  assert.equal(
    capabilityInvalidationReason({ ...common, model: "other-model" }),
    "settings-changed",
  );
  assert.equal(
    capabilityInvalidationReason({
      ...common,
      baseUrl: "https://other-gateway.example/v1",
    }),
    "settings-changed",
  );
  assert.deepEqual(
    invalidateCapabilityEntries([capability], {
      baseUrl: capability.baseUrl,
      model: capability.model,
      nextBaseUrl: "https://other-gateway.example/v1",
      nextModel: capability.model,
      reason: "settings-changed",
    }),
    [],
  );
  assert.equal(
    capabilityInvalidationReason({
      ...common,
      capability: {
        ...capability,
        protocolAdapterVersion: "openai-native-tools-v0",
      },
    }),
    "adapter-version-changed",
  );
  assert.equal(
    capabilityInvalidationReason({
      ...common,
      observedGatewayResponseShape: "changed-gateway-shape",
    }),
    "gateway-response-shape-changed",
  );
});

test("runtime protocol_error immediately invalidates and re-probes the exact entry", async () => {
  const previous = admitted();
  let settings: AppSettings = {
    id: "app",
    model: previous.model,
    providerBaseUrl: previous.baseUrl,
    providerCapabilities: [previous],
  };
  let probes = 0;
  let sawEmptyCache = false;
  const ensure = createCapabilityProbeCoordinator();
  const next = await ensure({
    baseUrl: previous.baseUrl,
    model: previous.model,
    ttlMs: DEFAULT_CAPABILITY_TTL_MS,
    force: true,
    reason: "runtime-protocol-error",
    now: () => previous.testedAt + 10,
    read: () => settings,
    write: (update) => {
      settings = {
        ...settings,
        providerCapabilities: update(settings.providerCapabilities ?? []),
      };
      if ((settings.providerCapabilities ?? []).length === 0)
        sawEmptyCache = true;
    },
    probe: async () => {
      probes += 1;
      return passedProbe({
        testedAt: new Date(previous.testedAt + 10).toISOString(),
      });
    },
  });
  assert.equal(sawEmptyCache, true);
  assert.equal(probes, 1);
  assert.ok(next.testedAt > previous.testedAt);
  assert.deepEqual(settings.providerCapabilities, [next]);
});

test("each three-stage partial failure is unavailable and keeps safe detail", () => {
  for (const [field, status] of [
    ["toolCallEmission", "failed"],
    ["toolResultAcceptance", "not-run"],
    ["streamingToolCallDelta", "failed"],
  ] as const) {
    const capability = capabilityFromProbe({
      baseUrl: "https://gateway.example/v1",
      model: "flagship",
      ttlMs: DEFAULT_CAPABILITY_TTL_MS,
      now: 1,
      probe: passedProbe({
        [field]: { status, detail: "安全失败说明" },
      }),
    });
    assert.equal(capability.mode, "unavailable");
    assert.equal(isCapabilityAdmitted(capability), false);
    assert.match(capability.unavailableReason ?? "", /安全失败说明|未完成/);
  }
});

test("an upstream unavailable decision cannot be upgraded by locally passed stages", () => {
  const capability = capabilityFromProbe({
    baseUrl: "https://gateway.example/v1",
    model: "flagship",
    ttlMs: DEFAULT_CAPABILITY_TTL_MS,
    now: 1,
    probe: passedProbe({
      mode: "unavailable",
      unavailableReason: "上游探测没有确认准入。",
    }),
  });
  assert.equal(capability.mode, "unavailable");
  assert.equal(capability.unavailableReason, "上游探测没有确认准入。");
});

test("concurrent admission shares one probe and late old-settings results are discarded", async () => {
  let settings: AppSettings = {
    id: "app",
    model: "flagship",
    providerBaseUrl: "https://gateway.example/v1",
    providerCapabilities: [],
  };
  let probes = 0;
  let resolveProbe!: (result: ProviderCapabilityResult) => void;
  const deferred = new Promise<ProviderCapabilityResult>((resolve) => {
    resolveProbe = resolve;
  });
  const ensure = createCapabilityProbeCoordinator();
  const input = {
    baseUrl: settings.providerBaseUrl!,
    model: settings.model,
    ttlMs: DEFAULT_CAPABILITY_TTL_MS,
    now: () => 100,
    read: () => settings,
    write: (
      update: (entries: ProviderCapability[]) => ProviderCapability[],
    ) => {
      settings = {
        ...settings,
        providerCapabilities: update(settings.providerCapabilities ?? []),
      };
    },
    probe: async () => {
      probes += 1;
      return deferred;
    },
  };
  const first = ensure(input);
  const second = ensure(input);
  settings = { ...settings, model: "new-flagship" };
  resolveProbe(passedProbe());
  const [oldA, oldB] = await Promise.all([first, second]);
  assert.equal(probes, 1);
  assert.equal(oldA.mode, "unavailable");
  assert.equal(oldB.mode, "unavailable");
  assert.match(oldA.unavailableReason ?? "", /设置已变化/);
  assert.deepEqual(settings.providerCapabilities, []);
});

test("schema-v1 migration drops pre-admission capability rows", () => {
  assert.deepEqual(
    migrateCapabilityCache([
      {
        baseUrl: "https://legacy.example/v1",
        model: "legacy",
        mode: "two-stage",
        streamingToolCalls: false,
        toolResultAccepted: false,
        testedAt: 1,
      },
    ]),
    [],
  );
  assert.deepEqual(migrateCapabilityCache([admitted()]).length, 1);
});

test("TASK-013 schema-v1 capability fixtures stay synchronized and safe", async () => {
  const directory = new URL(
    "../../../harness-rebuild/outputs/task-010/",
    import.meta.url,
  );
  const [admission, partial, invalidation, concurrency] = await Promise.all(
    [
      "three-stage-admitted.json",
      "three-stage-partial-failures.json",
      "invalidation-matrix.json",
      "stale-probe-concurrency.json",
    ].map(async (name) =>
      JSON.parse(await readFile(new URL(name, directory), "utf8")),
    ),
  );
  assert.ok(
    [admission, partial, invalidation, concurrency].every(
      (fixture) => fixture.schemaVersion === 1,
    ),
  );
  assert.deepEqual(
    Object.values(admission.capability)
      .filter((value): value is { status: string } =>
        Boolean(value && typeof value === "object" && "status" in value),
      )
      .map((stage) => stage.status),
    ["passed", "passed", "passed"],
  );
  assert.deepEqual(
    partial.cases.map((item: { mode: string }) => item.mode),
    ["unavailable", "unavailable", "unavailable"],
  );
  assert.deepEqual(
    invalidation.rows.map((row: { reason: string }) => row.reason),
    [
      "settings-changed",
      "adapter-version-changed",
      "runtime-protocol-error",
      "gateway-response-shape-changed",
      "ttl-expired",
    ],
  );
  assert.equal(concurrency.assert.providerProbeCount, 1);
  const serialized = JSON.stringify([
    admission,
    partial,
    invalidation,
    concurrency,
  ]);
  for (const forbidden of [
    "apiKey",
    "authorization",
    "rawBody",
    "reasoning",
    "protocolPayload",
    "/Users/",
  ])
    assert.equal(serialized.includes(forbidden), false, forbidden);
});
