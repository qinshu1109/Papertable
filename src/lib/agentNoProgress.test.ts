import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type {
  BuiltContext,
  ProviderCapability,
  ProviderMessage,
  ProviderStreamEvent,
  ToolCall,
} from "../types";
import { runAgentTurn, type AgentRuntime } from "./agent";
import type { AppendAgentStepInput } from "./agentEvents";
import { successfulToolCallSignature } from "./agentNoProgress";
import type { NoteChunk, NoteHit } from "./notes/types";
import { ProviderError } from "./provider/http";

const nativeCapability: ProviderCapability = {
  baseUrl: "http://127.0.0.1:0/v1",
  model: "fake",
  mode: "native-tools",
  streamingToolCalls: true,
  toolResultAccepted: true,
  testedAt: 1,
};

const built = (answerMode: BuiltContext["answerMode"]): BuiltContext => ({
  answerMode,
  system: ["系统规则"],
  messages: [
    { role: "system", content: "系统规则" },
    { role: "user", content: "笔记中的结论是什么？" },
  ],
  provenance: [],
  excluded: [],
  estimatedTokens: 12,
});

const evidence: NoteChunk = {
  id: "qualified-evidence",
  libraryId: "library-a",
  documentId: "document-a",
  documentVersionHash: "hash-a",
  relativePath: "研究/证据.md",
  titlePath: ["研究", "证据"],
  tags: ["测试"],
  ordinal: 0,
  start: 0,
  end: 12,
  text: "合格证据：只能从实际读取的片段得到。",
};

const evidenceHit: NoteHit = {
  chunk: evidence,
  score: 10,
  snippet: evidence.text,
};

function events(items: ProviderStreamEvent[]) {
  return (async function* () {
    yield* items;
  })();
}

function toolRound(call: ToolCall): ProviderStreamEvent[] {
  return [
    {
      type: "tool-call-delta",
      index: 0,
      id: call.id,
      name: call.name,
      arguments: call.arguments,
    },
    { type: "done", finishReason: "tool_calls" },
  ];
}

function finalRound(text: string): ProviderStreamEvent[] {
  return text
    ? [
        { type: "token", text, channel: "final" },
        { type: "done", finishReason: "stop" },
      ]
    : [{ type: "done", finishReason: "stop" }];
}

function injectedRuntime(input: {
  rounds: Array<ProviderStreamEvent[] | Error>;
  searches?: NoteHit[][];
  reads?: NoteChunk[][];
  requests?: ProviderMessage[][];
  executions?: { searches: number; reads: number };
}): AgentRuntime {
  let request = 0;
  let search = 0;
  let read = 0;
  return {
    complete: async () => ({ content: "", toolCalls: [] }),
    stream: (requestInput) => {
      input.requests?.push(structuredClone(requestInput.messages));
      const round = input.rounds[request] ?? finalRound("意外额外请求");
      request += 1;
      if (round instanceof Error)
        return (async function* () {
          yield* [];
          throw round;
        })();
      return events(round);
    },
    search: async () => {
      if (input.executions) input.executions.searches += 1;
      const result = input.searches?.[search] ?? [];
      search += 1;
      return result;
    },
    read: async () => {
      if (input.executions) input.executions.reads += 1;
      const result = input.reads?.[read] ?? [];
      read += 1;
      return result;
    },
    now: () => 10,
    sleep: async () => undefined,
  };
}

function searchCall(
  id: string,
  args = '{"query":"相同查询","limit":4}',
): ToolCall {
  return { id, name: "search_notes", arguments: args };
}

function readCall(id: string): ToolCall {
  return {
    id,
    name: "read_notes",
    arguments: `{"chunkIds":["${evidence.id}"]}`,
  };
}

test("successful signatures canonicalize object keys without reinterpreting values", () => {
  const left = successfulToolCallSignature({
    name: "search_notes",
    arguments:
      '{"query":" 原样 ","limit":4,"nested":{"b":2,"a":1},"array":["x","y"]}',
  });
  const reordered = successfulToolCallSignature({
    name: "search_notes",
    arguments:
      '{"array":["x","y"],"nested":{"a":1,"b":2},"limit":4,"query":" 原样 "}',
  });
  const changedString = successfulToolCallSignature({
    name: "search_notes",
    arguments:
      '{"array":["x","y"],"nested":{"a":1,"b":2},"limit":4,"query":"原样"}',
  });
  const changedArrayOrder = successfulToolCallSignature({
    name: "search_notes",
    arguments:
      '{"array":["y","x"],"nested":{"a":1,"b":2},"limit":4,"query":" 原样 "}',
  });

  assert.equal(left, reordered);
  assert.notEqual(left, changedString, "string whitespace is not repaired");
  assert.notEqual(left, changedArrayOrder, "array order is not reinterpreted");
  assert.equal(
    successfulToolCallSignature({
      name: "search_notes",
      arguments: '{"query":',
    }),
    null,
  );
});

test("TASK-013 fixtures keep the deterministic signatures synchronized", async () => {
  const firstRepeat = JSON.parse(
    await readFile(
      new URL(
        "../../harness-rebuild/outputs/task-006/first-repeat-reminder.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as {
    signatureInputs: Array<Pick<ToolCall, "name" | "arguments">>;
    events: Array<{ signature: string }>;
  };
  const qualified = JSON.parse(
    await readFile(
      new URL(
        "../../harness-rebuild/outputs/task-006/qualified-no-progress.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as { events: Array<{ kind: string; signature?: string }> };

  const normalized = firstRepeat.signatureInputs.map(
    successfulToolCallSignature,
  );
  assert.equal(normalized[0], normalized[1]);
  assert.equal(firstRepeat.events[0]?.signature, normalized[0]);
  assert.equal(
    qualified.events.find((event) => event.kind === "duplicate-call-detected")
      ?.signature,
    successfulToolCallSignature(readCall("fixture")),
  );
});

test("first successful repeat skips execution, emits one reminder, and lets the same model choose another action", async () => {
  const requests: ProviderMessage[][] = [];
  const executions = { searches: 0, reads: 0 };
  const appended: AppendAgentStepInput[] = [];
  const outcome = await runAgentTurn({
    built: built("general"),
    projectId: "project-a",
    libraryIds: ["library-a"],
    capability: nativeCapability,
    signal: new AbortController().signal,
    onPhase: () => undefined,
    onToken: () => undefined,
    audit: {
      runId: "run-first-repeat",
      turnId: "turn-first-repeat",
      appendStep: async (step) => {
        appended.push(structuredClone(step));
      },
    },
    runtime: injectedRuntime({
      requests,
      executions,
      rounds: [
        toolRound(searchCall("search-1")),
        toolRound(searchCall("search-2", '{"limit":4,"query":"相同查询"}')),
        toolRound(searchCall("search-different", '{"query":"不同查询"}')),
        finalRound("模型已经选择不同操作并完成回答。"),
      ],
      searches: [[], []],
    }),
  });

  assert.equal(executions.searches, 2, "the repeated call must not execute");
  assert.equal(outcome.trace.budget?.used.calls, 2);
  assert.equal(outcome.terminal.result, "completed");
  const duplicateEvents = appended.filter(
    (step) => step.event.message.kind === "duplicate-call-detected",
  );
  assert.equal(duplicateEvents.length, 1);
  assert.equal(
    duplicateEvents[0]?.event.message.kind === "duplicate-call-detected"
      ? duplicateEvents[0].event.message.occurrences
      : undefined,
    2,
  );
  const reminderCount = (requests[2] ?? []).filter(
    (message) =>
      message.role === "system" &&
      message.content.includes("相同查询已经执行过，结果未发生变化"),
  ).length;
  assert.equal(reminderCount, 1, "exactly one system reminder is injected");
});

test("a further successful repeat stops exploration and synthesizes partial/no_progress from qualified reads", async () => {
  const requests: ProviderMessage[][] = [];
  const executions = { searches: 0, reads: 0 };
  const appended: AppendAgentStepInput[] = [];
  const visible: string[] = [];
  const outcome = await runAgentTurn({
    built: built("sources-only"),
    projectId: "project-a",
    libraryIds: ["library-a"],
    capability: nativeCapability,
    signal: new AbortController().signal,
    onPhase: () => undefined,
    onToken: (event) => visible.push(event.text),
    audit: {
      runId: "run-qualified",
      turnId: "turn-qualified",
      appendStep: async (step) => {
        appended.push(structuredClone(step));
      },
    },
    runtime: injectedRuntime({
      requests,
      executions,
      rounds: [
        toolRound(searchCall("search-evidence")),
        toolRound(readCall("read-1")),
        toolRound(readCall("read-2")),
        toolRound(readCall("read-3")),
        finalRound(`基于已读证据只能给出部分结论。[[source:${evidence.id}]]`),
      ],
      searches: [[evidenceHit]],
      reads: [[evidence]],
    }),
  });

  assert.deepEqual(outcome.terminal, {
    result: "partial",
    reason: "no_progress",
  });
  assert.equal(outcome.trace.truncated, true);
  assert.deepEqual(outcome.trace.readChunkIds, [evidence.id]);
  assert.equal(executions.searches, 1);
  assert.equal(executions.reads, 1, "both repeated reads must be suppressed");
  assert.equal(
    outcome.trace.budget?.used.calls,
    2,
    "suppressed repeats must not consume call budget",
  );
  assert.equal(
    requests.length,
    5,
    "the further repeat enters synthesis directly",
  );
  assert.deepEqual(visible, [
    `基于已读证据只能给出部分结论。[[source:${evidence.id}]]`,
  ]);
  const duplicates = appended.filter(
    (step) => step.event.message.kind === "duplicate-call-detected",
  );
  assert.deepEqual(
    duplicates.map((step) =>
      step.event.message.kind === "duplicate-call-detected"
        ? step.event.message.occurrences
        : 0,
    ),
    [2, 3],
  );
  assert.equal(duplicates[1]?.checkpoint.stopReason, "no_progress");
  assert.deepEqual(duplicates[1]?.checkpoint.readChunkIds, [evidence.id]);
  assert.equal(duplicates[1]?.schemaVersion, 1);
});

test("evidence-insufficient no-progress returns an explicit outcome instead of a provider error or answer", async () => {
  const executions = { searches: 0, reads: 0 };
  const visible: string[] = [];
  const outcome = await runAgentTurn({
    built: built("sources-only"),
    projectId: "project-a",
    libraryIds: ["library-a"],
    capability: nativeCapability,
    signal: new AbortController().signal,
    onPhase: () => undefined,
    onToken: (event) => visible.push(event.text),
    runtime: injectedRuntime({
      executions,
      rounds: [
        toolRound(searchCall("search-empty-1")),
        toolRound(searchCall("search-empty-2")),
        toolRound(searchCall("search-empty-3")),
        finalRound("相同查询重复后仍无进展，且没有已读证据可支持回答。"),
      ],
      searches: [[]],
    }),
  });

  assert.deepEqual(outcome.terminal, {
    result: "refused",
    reason: "insufficient_evidence",
  });
  assert.equal(executions.searches, 1);
  assert.equal(outcome.trace.budget?.used.calls, 1);
  assert.deepEqual(visible, [
    "相同查询重复后仍无进展，且没有已读证据可支持回答。",
  ]);
  assert.equal(outcome.readChunks.length, 0);
  assert.equal(outcome.trace.terminal?.result, "refused");
});

test("empty evidence-insufficient synthesis repair falls back to an explicit no-progress message", async () => {
  const outcome = await runAgentTurn({
    built: built("sources-only"),
    projectId: "project-a",
    libraryIds: ["library-a"],
    capability: nativeCapability,
    signal: new AbortController().signal,
    onPhase: () => undefined,
    onToken: () => undefined,
    runtime: injectedRuntime({
      rounds: [
        toolRound(searchCall("search-empty-1")),
        toolRound(searchCall("search-empty-2")),
        toolRound(searchCall("search-empty-3")),
        finalRound(""),
        finalRound(""),
        finalRound(""),
        finalRound(""),
        finalRound(""),
        finalRound(""),
      ],
      searches: [[]],
    }),
  });

  assert.deepEqual(outcome.terminal, {
    result: "refused",
    reason: "insufficient_evidence",
  });
  assert.match(outcome.directAnswer ?? "", /相同查询没有取得新进展/);
  assert.match(outcome.directAnswer ?? "", /没有实际读取/);
  assert.equal(outcome.readChunks.length, 0);
});

test("evidence-insufficient synthesis transport failure never replaces no-progress with a generic provider error", async () => {
  const outcome = await runAgentTurn({
    built: built("sources-only"),
    projectId: "project-a",
    libraryIds: ["library-a"],
    capability: nativeCapability,
    signal: new AbortController().signal,
    onPhase: () => undefined,
    onToken: () => undefined,
    runtime: injectedRuntime({
      rounds: [
        toolRound(searchCall("search-empty-1")),
        toolRound(searchCall("search-empty-2")),
        toolRound(searchCall("search-empty-3")),
        new ProviderError("模型请求未能完成，请重试。", "upstream"),
        new ProviderError("模型请求未能完成，请重试。", "upstream"),
        new ProviderError("模型请求未能完成，请重试。", "upstream"),
      ],
      searches: [[]],
    }),
  });

  assert.deepEqual(outcome.terminal, {
    result: "refused",
    reason: "insufficient_evidence",
  });
  assert.match(outcome.directAnswer ?? "", /相同查询没有取得新进展/);
  assert.doesNotMatch(outcome.directAnswer ?? "", /模型请求未能完成/);
});

test("exception-only fuse remains independent and keeps isError reinjection", async () => {
  const requests: ProviderMessage[][] = [];
  const appended: AppendAgentStepInput[] = [];
  const outcome = await runAgentTurn({
    built: built("general"),
    projectId: "project-a",
    libraryIds: ["library-a"],
    capability: nativeCapability,
    signal: new AbortController().signal,
    onPhase: () => undefined,
    onToken: () => undefined,
    budgetLimits: { rounds: 5 },
    audit: {
      runId: "run-failure-fuse",
      turnId: "turn-failure-fuse",
      appendStep: async (step) => {
        appended.push(structuredClone(step));
      },
    },
    runtime: injectedRuntime({
      requests,
      rounds: [
        toolRound(searchCall("search-first")),
        toolRound({
          id: "invalid-1",
          name: "read_notes",
          arguments: '{"chunkIds":["never-readable"]}',
        }),
        toolRound({
          id: "invalid-2",
          name: "read_notes",
          arguments: '{"chunkIds":["never-readable"]}',
        }),
        toolRound({
          id: "invalid-3",
          name: "read_notes",
          arguments: '{"chunkIds":["never-readable"]}',
        }),
        finalRound("异常熔断结果已收到。"),
      ],
    }),
  });

  assert.equal(outcome.terminal.result, "completed");
  assert.equal(
    outcome.trace.budget?.used.calls,
    3,
    "the search and two failed reads execute; the fuse refusal does not consume budget",
  );
  assert.equal(
    appended.some(
      (step) => step.event.message.kind === "duplicate-call-detected",
    ),
    false,
    "failed calls never enter the successful-signature tracker",
  );
  const errorResults = requests
    .slice(1)
    .flatMap((messages) =>
      messages.filter((message) => message.role === "tool"),
    )
    .filter(
      (message) =>
        message.role === "tool" && JSON.parse(message.content).isError === true,
    );
  assert.equal(errorResults.length >= 3, true);
  for (const result of errorResults)
    if (result.role === "tool")
      assert.equal(JSON.parse(result.content).isError, true);
  const lastErrorResult = errorResults[errorResults.length - 1];
  assert.match(lastErrorResult?.content ?? "", /连续失败两次/);
});
