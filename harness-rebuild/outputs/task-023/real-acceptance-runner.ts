import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import type { BuiltContext, ProviderCapability } from "../../../src/types";
import {
  controlledCitations,
  runAgentTurn,
  type AgentRuntime,
} from "../../../src/lib/agent";
import { readAgentPreflight } from "../../../src/lib/agentPreflight";
import { chunkMarkdown } from "../../../src/lib/notes/chunk";
import {
  isConfidentNoteHit,
  rankNoteChunks,
} from "../../../src/lib/notes/search";
import type { NoteChunk } from "../../../src/lib/notes/types";
import { capabilityFromProbe } from "../../../src/lib/provider/capabilityGate";
import {
  getProviderConfig,
  probeProviderCapabilities,
} from "../../../src/lib/provider/http";

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
const materialRoot = path.join(repositoryRoot, "harness-rebuild");
const libraryId = "task-023-real-material";
const origin = process.env.TASK023_PROVIDER_ORIGIN;
if (!origin) throw new Error("TASK023_PROVIDER_ORIGIN is required");

const frozen = JSON.parse(
  await readFile(
    path.join(import.meta.dirname, "real-material-questions.json"),
    "utf8",
  ),
) as {
  cases: Array<{ id: string; question: string }>;
};
const requestedCase = process.env.TASK023_CASE_ID;
const selectedCases = requestedCase
  ? frozen.cases.filter((testCase) => testCase.id === requestedCase)
  : frozen.cases;
if (!selectedCases.length) throw new Error("requested case does not exist");

const originalFetch = globalThis.fetch;
globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) =>
  originalFetch(
    typeof input === "string" && input.startsWith("/")
      ? new URL(input, origin)
      : input,
    init,
  )) as typeof fetch;

async function markdownFiles(folder: string): Promise<string[]> {
  const entries = await readdir(folder, { withFileTypes: true });
  const nested = await Promise.all(
    entries
      .filter((entry) => !entry.name.startsWith("."))
      .map(async (entry) => {
        const target = path.join(folder, entry.name);
        if (entry.isDirectory()) return markdownFiles(target);
        return entry.isFile() && entry.name.endsWith(".md") ? [target] : [];
      }),
  );
  return nested.flat();
}

const chunks: NoteChunk[] = [];
for (const file of await markdownFiles(materialRoot)) {
  const relativePath = path
    .relative(materialRoot, file)
    .split(path.sep)
    .join("/");
  const content = await readFile(file, "utf8");
  chunks.push(...chunkMarkdown({ libraryId, relativePath, content }).chunks);
}
const chunksById = new Map(chunks.map((chunk) => [chunk.id, chunk]));
const currentChunks = chunks.filter(
  (chunk) => !chunk.relativePath.startsWith("sources/"),
);

function context(question: string): BuiltContext {
  const system = [
    "只依据当前绑定的只读资料库回答。",
    "decisions、tasks、logs 与当前任务卡是现行证据；sources/research 是历史研究，冲突时不得用历史报告覆盖现行设计。",
    "先用 search_notes 找到回答所需的最少片段，再用 read_notes 实际读取。",
    "每个来自资料的关键结论后必须附 [[source:实际已读chunkId]]；证据充分后立即停止工具调用。",
  ].join("");
  return {
    answerMode: "sources-only",
    system: [system],
    messages: [
      { role: "system", content: system },
      { role: "user", content: question },
    ],
    provenance: [],
    excluded: [],
    estimatedTokens: 120,
  };
}

const config = await getProviderConfig();
const capabilityStarted = performance.now();
const probe = await probeProviderCapabilities();
const capabilityTotalMs = Math.round(performance.now() - capabilityStarted);
const capability: ProviderCapability = capabilityFromProbe({
  baseUrl: config.baseUrl,
  model: config.model,
  ttlMs: 86_400_000,
  probe,
  now: Date.now(),
});
if (capability.mode !== "native-tools")
  throw new Error("real provider did not pass native-tool admission");

const rows = [];
for (const testCase of selectedCases) {
  const sentAt = performance.now();
  let firstRequestAt: number | undefined;
  let firstVisibleAt: number | undefined;
  let modelRequests = 0;
  let searchCalls = 0;
  let readCalls = 0;
  let actualReadCount = 0;
  let answerWithMarkers = "";
  const searchReturnedIds = new Set<string>();
  const requestedReadIds: string[] = [];
  let lastHeartbeat = performance.now();
  let heartbeatMaxGapMs = 0;
  const heartbeat = setInterval(() => {
    const now = performance.now();
    heartbeatMaxGapMs = Math.max(heartbeatMaxGapMs, now - lastHeartbeat);
    lastHeartbeat = now;
  }, 50);

  const preflight = await readAgentPreflight({
    verdict: async () => ({ verdicts: [] }),
    persistVerdict: async () => undefined,
    resumeAudit: async () => null,
    libraryIds: async () => [libraryId],
    attachments: async () => [],
  });
  const runtime: Partial<AgentRuntime> = {
    target: "desktop",
    search: async ({ query, limit }) => {
      searchCalls += 1;
      const hits =
        query.trim() === "*"
          ? chunks.slice(0, limit).map((chunk) => ({
              chunk,
              score: 1,
              snippet: chunk.text.slice(0, 180).replace(/\s+/g, " ").trim(),
            }))
          : [
              ...rankNoteChunks(currentChunks, query, 8),
              ...rankNoteChunks(chunks, query, 8),
            ]
              .filter(
                (hit, index, all) =>
                  isConfidentNoteHit(hit, query) &&
                  all.findIndex(
                    (candidate) => candidate.chunk.id === hit.chunk.id,
                  ) === index,
              )
              .slice(0, limit);
      hits.forEach((hit) => searchReturnedIds.add(hit.chunk.id));
      return hits;
    },
    read: async ({ chunkIds }) => {
      readCalls += 1;
      requestedReadIds.push(...chunkIds);
      const found = chunkIds.flatMap((id) => {
        const chunk = chunksById.get(id);
        return chunk ? [chunk] : [];
      });
      actualReadCount += found.length;
      return found;
    },
  };

  try {
    const outcome = await runAgentTurn({
      built: context(testCase.question),
      projectId: "task-023-real-acceptance",
      libraryIds: preflight.libraryIds,
      libraryScopes: [{ id: libraryId, name: "Harness rebuild Markdown" }],
      capability,
      signal: new AbortController().signal,
      onPhase: () => undefined,
      onModelRequest: () => {
        firstRequestAt ??= performance.now();
        modelRequests += 1;
      },
      onToken: (event) => {
        if (event.text) firstVisibleAt ??= performance.now();
        answerWithMarkers += event.text;
      },
      runtime,
      protocolRecovery: { invalidateAndReprobe: async () => capability },
    });
    const finishedAt = performance.now();
    if (outcome.directAnswer) {
      firstVisibleAt ??= finishedAt;
      answerWithMarkers = outcome.directAnswer;
    }
    const controlled = controlledCitations(
      answerWithMarkers,
      outcome.readChunks,
    );
    const readableIdsValid =
      requestedReadIds.length > 0 &&
      requestedReadIds.every((id) => searchReturnedIds.has(id));
    rows.push({
      caseId: testCase.id,
      preflightMs:
        firstRequestAt === undefined
          ? null
          : Math.round(firstRequestAt - sentAt),
      firstVisibleMs:
        firstVisibleAt === undefined
          ? null
          : Math.round(firstVisibleAt - sentAt),
      totalMs: Math.round(finishedAt - sentAt),
      heartbeatMaxGapMs: Math.round(heartbeatMaxGapMs),
      modelRequests,
      searchCalls,
      readCalls,
      actualReadCount,
      readableIdsValid,
      controlledCitationCount: controlled.citations.length,
      citationChunkIds: controlled.citations.map(
        (citation) => citation.chunkId,
      ),
      citationPaths: [
        ...new Set(
          controlled.citations.map((citation) => citation.relativePath),
        ),
      ],
      answer: controlled.content,
      terminalResult: outcome.terminal.result,
      terminalReason: outcome.terminal.reason,
      budgetEnforced: false,
      recordedToolCalls: outcome.trace.budget?.used.calls ?? 0,
    });
  } finally {
    clearInterval(heartbeat);
    heartbeatMaxGapMs = Math.max(
      heartbeatMaxGapMs,
      performance.now() - lastHeartbeat,
    );
  }
}

const median = (values: number[]) => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
};
const firstFive = rows.slice(0, 5);
const firstFiveNumber = (
  field: "preflightMs" | "firstVisibleMs" | "totalMs" | "heartbeatMaxGapMs",
) =>
  firstFive
    .map((row) => row[field])
    .filter((value): value is number => Number.isFinite(value));
const allPassed = rows.every(
  (row) =>
    (row.terminalResult === "completed" || row.terminalResult === "partial") &&
    row.searchCalls > 0 &&
    row.readCalls > 0 &&
    row.actualReadCount > 0 &&
    row.readableIdsValid &&
    row.controlledCitationCount > 0,
);

process.stdout.write(
  `${JSON.stringify(
    {
      schemaVersion: 1,
      kind: "task-023-real-material-acceptance",
      generatedAt: new Date().toISOString(),
      model: config.model,
      material: {
        label: "harness-rebuild Markdown",
        files: (await markdownFiles(materialRoot)).length,
        chunks: chunks.length,
      },
      capability: {
        mode: capability.mode,
        totalMs: capabilityTotalMs,
        toolCallEmission: probe.toolCallEmission,
        toolResultAcceptance: probe.toolResultAcceptance,
        streamingToolCallDelta: probe.streamingToolCallDelta,
      },
      constraints: {
        runtimeTarget: "desktop",
        fixedToolCallLimit: false,
        caseFilter: requestedCase ?? "q1-q10",
        performancePayloadExcludes:
          "key, absolute paths, prompts, queries, tool arguments, raw replies, reasoning",
      },
      firstFiveMedian: {
        preflightMs: median(firstFiveNumber("preflightMs")),
        firstVisibleMs: median(firstFiveNumber("firstVisibleMs")),
        totalMs: median(firstFiveNumber("totalMs")),
        heartbeatMaxGapMs: median(firstFiveNumber("heartbeatMaxGapMs")),
      },
      rows,
      allPassed,
    },
    null,
    2,
  )}\n`,
);
if (!allPassed) process.exitCode = 1;
