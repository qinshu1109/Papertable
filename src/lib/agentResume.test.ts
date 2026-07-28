import assert from "node:assert/strict";
import test from "node:test";
import type {
  BuiltContext,
  ProviderCapability,
  ProviderMessage,
  ProviderStreamEvent,
} from "../types";
import { runAgentTurn, type AgentRuntime } from "./agent";
import {
  consumeAgentBudget,
  createAgentBudgetLedger,
  markAgentBudgetExhausted,
} from "./agentBudget";
import type {
  AgentAudit,
  AgentAuditSource,
  AppendAgentStepInput,
} from "./agentEvents";
import {
  agentTraceFromAudit,
  buildAgentWorkingSet,
  claimAgentContinuation,
  convertAgentWorkingSetToLlm,
  recoverTurnFromAgentAudit,
} from "./agentResume";

const capability: ProviderCapability = {
  baseUrl: "http://127.0.0.1:0/v1",
  model: "fake",
  mode: "native-tools",
  streamingToolCalls: true,
  toolResultAccepted: true,
  testedAt: 1,
};

const source: AgentAuditSource = {
  chunkId: "read-1",
  libraryId: "library-a",
  documentId: "document-a",
  title: "研究 / 证据",
  relativePath: "研究/证据.md",
  documentHash: "hash-a",
  text: "完整已读原文：事实编号 A-42。",
};

function boundedPartialAudit(): Extract<AgentAudit, { kind: "event-sourced" }> {
  const ledger = createAgentBudgetLedger({
    rounds: 1,
    calls: 2,
    wallMs: 1_000,
    tokens: 100,
  });
  consumeAgentBudget(ledger, "rounds", 1, 2);
  markAgentBudgetExhausted(ledger, "rounds_exhausted", 3);
  return {
    kind: "event-sourced",
    run: {
      id: "same-run",
      turnId: "same-turn",
      schemaVersion: 1,
      phase: "terminal",
      startedAt: 1,
      updatedAt: 9,
      finishedAt: 9,
      lastSequence: 8,
      checkpoint: {
        phase: "terminal",
        objective: "找出 A-42，并继续查清 B-99。",
        executedSearches: ["A-42"],
        readChunkIds: ["read-1"],
        confirmedCitationChunkIds: ["read-1"],
        unresolvedQuestions: ["B-99 尚未查清。"],
        addedBudget: {},
        hostScope: {
          projectId: "project-a",
          libraryIds: ["library-a"],
        },
        budget: ledger,
        stopReason: "rounds_exhausted",
        terminal: { result: "partial", reason: "rounds_exhausted" },
      },
    },
    events: [
      {
        id: "e1",
        runId: "same-run",
        sequence: 1,
        schemaVersion: 1,
        eventType: "exploration-started",
        occurredAt: 1,
        message: {
          kind: "exploration-started",
          objective: "找出 A-42，并继续查清 B-99。",
          mode: "native-tools",
        },
      },
      {
        id: "e2",
        runId: "same-run",
        sequence: 2,
        schemaVersion: 1,
        eventType: "search-requested",
        occurredAt: 2,
        message: {
          kind: "search-requested",
          query: "A-42",
          callId: "search-a",
        },
      },
      {
        id: "e3",
        runId: "same-run",
        sequence: 3,
        schemaVersion: 1,
        eventType: "search-completed",
        occurredAt: 3,
        message: {
          kind: "search-completed",
          query: "A-42",
          callId: "search-a",
          hitCount: 1,
          hitChunkIds: ["read-1"],
        },
      },
      {
        id: "e4",
        runId: "same-run",
        sequence: 4,
        schemaVersion: 1,
        eventType: "read-completed",
        occurredAt: 4,
        message: {
          kind: "read-completed",
          requestedChunkIds: ["read-1"],
          sources: [source],
          callId: "read-a",
        },
      },
      {
        id: "e5",
        runId: "same-run",
        sequence: 5,
        schemaVersion: 1,
        eventType: "search-requested",
        occurredAt: 5,
        message: {
          kind: "search-requested",
          query: "dangling-partial-batch",
          callId: "never-completed",
        },
      },
      {
        id: "e6",
        runId: "same-run",
        sequence: 6,
        schemaVersion: 1,
        eventType: "read-requested",
        occurredAt: 6,
        message: {
          kind: "read-requested",
          chunkIds: ["never-read"],
          callId: "never-completed-read",
        },
      },
      {
        id: "e7",
        runId: "same-run",
        sequence: 7,
        schemaVersion: 1,
        eventType: "final-synthesis",
        occurredAt: 7,
        message: {
          kind: "final-synthesis",
          stage: "completed",
          basisEventIds: ["e4"],
          unresolvedQuestions: ["B-99 尚未查清。"],
        },
      },
      {
        id: "e8",
        runId: "same-run",
        sequence: 8,
        schemaVersion: 1,
        eventType: "terminal",
        occurredAt: 9,
        message: {
          kind: "terminal",
          terminal: { result: "partial", reason: "rounds_exhausted" },
          answer: "A-42 已确认，B-99 尚未查清。",
          citations: [
            {
              chunkId: "read-1",
              libraryId: "library-a",
              documentId: "document-a",
              title: "证据",
              relativePath: "研究/证据.md",
              documentHash: "hash-a",
              excerpt: "事实编号 A-42。",
            },
          ],
          unresolvedQuestions: ["B-99 尚未查清。"],
        },
      },
    ],
  };
}

function events(items: ProviderStreamEvent[]) {
  return (async function* () {
    yield* items;
  })();
}

test("ADR-006 working set has exactly seven categories and only completed reads are evidence", () => {
  const workingSet = buildAgentWorkingSet(boundedPartialAudit());
  assert.deepEqual(Object.keys(workingSet), [
    "objective",
    "executedSearches",
    "readSources",
    "confirmedCitations",
    "unresolvedQuestions",
    "previousStopReason",
    "addedBudget",
  ]);
  assert.deepEqual(
    workingSet.executedSearches.map((item) => item.query),
    ["A-42"],
  );
  assert.deepEqual(
    workingSet.readSources.map((item) => item.chunkId),
    ["read-1"],
  );
  assert.equal(
    JSON.stringify(workingSet).includes("dangling-partial-batch"),
    false,
  );
  assert.equal(JSON.stringify(workingSet).includes("never-read"), false);

  const messages = convertAgentWorkingSetToLlm(workingSet);
  assert.equal(messages.length, 7);
  assert.match(messages[0]?.content ?? "", /用户目标/);
  assert.match(messages[1]?.content ?? "", /不具引用资格/);
  assert.match(messages[2]?.content ?? "", /完整已读原文/);
  assert.match(messages[3]?.content ?? "", /已确认引用/);
  assert.match(messages[4]?.content ?? "", /未解决问题/);
  assert.match(messages[5]?.content ?? "", /rounds_exhausted/);
  assert.match(messages[6]?.content ?? "", /本次新增预算/);
  assert.doesNotMatch(JSON.stringify(messages), /protocol-repaired|retry/);
});

test("a committed continuation claim is recovered as interrupted, not as the old partial terminal", () => {
  const audit = boundedPartialAudit();
  audit.run.phase = "exploring";
  audit.run.finishedAt = undefined;
  audit.run.checkpoint.phase = "exploring";
  audit.run.checkpoint.terminal = undefined;
  audit.run.checkpoint.stopReason = undefined;
  audit.events.push({
    id: "e9",
    runId: audit.run.id,
    sequence: 9,
    schemaVersion: 1,
    eventType: "budget-added",
    occurredAt: 10,
    message: {
      kind: "budget-added",
      added: { rounds: 4 },
      reason: "user-requested same-run continuation",
    },
  });
  audit.run.lastSequence = 9;

  const trace = agentTraceFromAudit(audit);
  assert.equal(trace.terminal, undefined);
  const recovered = recoverTurnFromAgentAudit(
    {
      id: audit.run.turnId,
      role: "ai",
      content: "A-42 已确认，B-99 尚未查清。",
      createdAt: 1,
      status: "complete",
      agentRun: {
        ...trace,
        terminal: { result: "partial", reason: "rounds_exhausted" },
      },
    },
    audit,
  );
  assert.equal(recovered.status, "interrupted");
  assert.equal(recovered.agentRun?.terminal, undefined);
  assert.equal(recovered.content, "A-42 已确认，B-99 尚未查清。");
});

test("bounded partial adds budget to the same run and resumes without replaying completed tools", async () => {
  const audit = boundedPartialAudit();
  const appended: AppendAgentStepInput[] = [];
  const persistence = {
    runId: audit.run.id,
    turnId: audit.run.turnId,
    appendStep: async (step: AppendAgentStepInput) => {
      appended.push(structuredClone(step));
    },
  };
  const resume = await claimAgentContinuation({
    audit,
    persistence,
    projectId: "project-a",
    addedBudget: { rounds: 4, calls: 4, wallMs: 1_000, tokens: 100 },
    occurredAt: 10,
  });
  assert.equal(appended[0]?.runId, "same-run");
  assert.equal(appended[0]?.turnId, "same-turn");
  assert.equal(appended[0]?.event.message.kind, "budget-added");
  assert.equal(appended[0]?.expectedLastSequence, 8);
  assert.equal(appended[0]?.checkpoint.phase, "exploring");
  assert.equal(appended[0]?.checkpoint.terminal, undefined);
  assert.equal(resume.ledger.used.rounds, 1);
  assert.equal(resume.ledger.limits.rounds, 5);
  assert.equal(resume.ledger.remaining.rounds, 4);

  let providerRequest = 0;
  let searchExecutions = 0;
  const requests: ProviderMessage[][] = [];
  const runtime: AgentRuntime = {
    complete: async () => ({ content: "", toolCalls: [] }),
    stream: (input) => {
      requests.push(structuredClone(input.messages));
      providerRequest += 1;
      if (providerRequest === 1)
        return events([
          {
            type: "tool-call-delta",
            index: 0,
            id: "duplicate-old-search",
            name: "search_notes",
            arguments: '{"query":"A-42","limit":8}',
          },
          { type: "done", finishReason: "tool_calls" },
        ]);
      if (providerRequest === 2)
        return events([
          {
            type: "tool-call-delta",
            index: 0,
            id: "new-search",
            name: "search_notes",
            arguments: '{"query":"B-99"}',
          },
          { type: "done", finishReason: "tool_calls" },
        ]);
      return events([
        {
          type: "token",
          text: "续跑完成：A-42 与 B-99 均已核对。 [[source:read-1]]",
          channel: "final",
        },
        { type: "done", finishReason: "stop" },
      ]);
    },
    search: async () => {
      searchExecutions += 1;
      return [];
    },
    read: async () => {
      throw new Error("completed read must not be replayed");
    },
    now: () => 11 + providerRequest,
    sleep: async () => undefined,
  };
  const built: BuiltContext = {
    answerMode: "general",
    system: ["unused full conversation"],
    messages: [{ role: "user", content: "must not become a new question" }],
    provenance: [],
    excluded: [],
    estimatedTokens: 1,
  };
  const outcome = await runAgentTurn({
    built,
    projectId: "project-a",
    libraryIds: ["library-a"],
    capability,
    resume,
    signal: new AbortController().signal,
    onPhase: () => undefined,
    onToken: () => undefined,
    audit: {
      ...persistence,
      hostScope: audit.run.checkpoint.hostScope,
      eventIdSuffix: "resume-8",
      objective: audit.run.checkpoint.objective,
    },
    runtime,
  });

  assert.deepEqual(outcome.terminal, { result: "completed", reason: "none" });
  assert.equal(searchExecutions, 1, "only the new search executes");
  assert.deepEqual(outcome.trace.searchQueries, ["A-42", "B-99"]);
  assert.deepEqual(outcome.trace.readChunkIds, ["read-1"]);
  assert.equal(outcome.readChunks[0]?.text, source.text);
  assert.ok(
    appended.some(
      (step) => step.event.message.kind === "duplicate-call-detected",
    ),
  );
  assert.equal(
    appended.filter((step) => step.event.message.kind === "exploration-started")
      .length,
    0,
    "resume must not create a second run start",
  );
  assert.match(
    JSON.stringify(requests[0]),
    /实际读取的证据原文.*完整已读原文/s,
  );
  assert.doesNotMatch(JSON.stringify(requests[0]), /never-read|toolCallId/);
});

for (const terminal of [
  { result: "completed", reason: "none" },
  { result: "refused", reason: "insufficient_evidence" },
  { result: "failed", reason: "protocol_error" },
] as const) {
  test(`non-resumable ${terminal.result}/${terminal.reason} is rejected before provider work`, async () => {
    const audit = boundedPartialAudit();
    audit.run.checkpoint.terminal = terminal;
    const last = audit.events[audit.events.length - 1];
    if (last?.message.kind === "terminal") last.message.terminal = terminal;
    let appendCalls = 0;
    await assert.rejects(
      claimAgentContinuation({
        audit,
        persistence: {
          runId: audit.run.id,
          turnId: audit.run.turnId,
          appendStep: async () => {
            appendCalls += 1;
          },
        },
        projectId: "project-a",
        occurredAt: 10,
      }),
      /不是可追加预算的续跑状态/,
    );
    assert.equal(appendCalls, 0);
  });
}
