import { readFile } from "node:fs/promises";
import process from "node:process";
import type { BuiltContext, ProviderCapability } from "../../../src/types";
import { runAgentTurn, type AgentRuntime } from "../../../src/lib/agent";
import { capabilityFromProbe } from "../../../src/lib/provider/capabilityGate";
import {
  completeModel,
  getProviderConfig,
  probeProviderCapabilities,
  streamModel,
} from "../../../src/lib/provider/http";
import { TASK013_SYNTHETIC_EVIDENCE } from "../../../src/lib/task013Runtime";

const cases = JSON.parse(
  await readFile(new URL("./frozen-questions.json", import.meta.url), "utf8"),
) as { cases: Array<{ id: string; question: string }> };

const origin = process.env.TASK019_PROVIDER_ORIGIN;
if (!origin) throw new Error("TASK019_PROVIDER_ORIGIN is required");

const originalFetch = globalThis.fetch;
globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) =>
  originalFetch(
    typeof input === "string" && input.startsWith("/")
      ? new URL(input, origin)
      : input,
    init,
  )) as typeof fetch;

function context(question: string): BuiltContext {
  const system =
    "只依据只读资料库回答。先调用 search_notes，再调用 read_notes，最后给出简洁中文答案。";
  return {
    answerMode: "sources-only",
    system: [system],
    messages: [
      { role: "system", content: system },
      { role: "user", content: question },
    ],
    provenance: [],
    excluded: [],
    estimatedTokens: 80,
  };
}

const config = await getProviderConfig();
const probe = await probeProviderCapabilities();
const capability: ProviderCapability = capabilityFromProbe({
  baseUrl: config.baseUrl,
  model: config.model,
  ttlMs: 86_400_000,
  probe,
  now: Date.now(),
});

const rows = [];
for (const testCase of cases.cases) {
  const sentAt = Date.now();
  let firstRequestAt: number | undefined;
  let firstVisibleAt: number | undefined;
  let modelRequests = 0;
  let toolCalls = 0;
  const markRequest = () => {
    firstRequestAt ??= Date.now();
    modelRequests += 1;
  };
  const runtime: Partial<AgentRuntime> = {
    complete: async (input) => {
      markRequest();
      return completeModel(input);
    },
    stream: (input) => {
      markRequest();
      return streamModel(input);
    },
    search: async () => {
      toolCalls += 1;
      return [
        {
          chunk: TASK013_SYNTHETIC_EVIDENCE,
          score: 10,
          snippet: "Synthetic TASK-019 baseline evidence.",
        },
      ];
    },
    read: async () => {
      toolCalls += 1;
      return [TASK013_SYNTHETIC_EVIDENCE];
    },
  };
  const outcome = await runAgentTurn({
    built: context(testCase.question),
    projectId: "task-019-baseline",
    libraryIds: ["task-019-synthetic-library"],
    capability,
    signal: new AbortController().signal,
    onPhase: () => undefined,
    onToken: () => {
      firstVisibleAt ??= Date.now();
    },
    runtime,
    protocolRecovery: { invalidateAndReprobe: async () => capability },
  });
  const finishedAt = Date.now();
  firstVisibleAt ??= outcome.directAnswer ? finishedAt : undefined;
  if (firstRequestAt === undefined || firstVisibleAt === undefined)
    throw new Error(`${testCase.id} did not reach all timing boundaries`);
  rows.push({
    caseId: testCase.id,
    preflightMs: firstRequestAt - sentAt,
    firstVisibleMs: firstVisibleAt - sentAt,
    totalMs: finishedAt - sentAt,
    modelRequests,
    toolCalls,
    terminalResult: outcome.terminal.result,
    terminalReason: outcome.terminal.reason,
  });
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

process.stdout.write(
  `${JSON.stringify(
    {
      schemaVersion: 1,
      kind: "pre-implementation-baseline",
      model: config.model,
      capabilityCache: "warm",
      cases: rows,
      median: {
        preflightMs: median(rows.map((row) => row.preflightMs)),
        firstVisibleMs: median(rows.map((row) => row.firstVisibleMs)),
        totalMs: median(rows.map((row) => row.totalMs)),
      },
    },
    null,
    2,
  )}\n`,
);
