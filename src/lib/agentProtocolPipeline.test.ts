import assert from "node:assert/strict";
import test from "node:test";
import type {
  BuiltContext,
  ProviderCapability,
  ProviderErrorCode,
  ProviderStreamEvent,
} from "../types";
import { AgentRunFailure, runAgentTurn, type AgentRuntime } from "./agent";
import type { AppendAgentStepInput } from "./agentEvents";
import type { NoteChunk, NoteHit } from "./notes/types";
import { ProviderError, providerErrorMessage } from "./provider/http";

const nativeCapability: ProviderCapability = {
  baseUrl: "http://127.0.0.1:0/v1",
  model: "fake",
  mode: "native-tools",
  streamingToolCalls: true,
  toolResultAccepted: true,
  testedAt: 1,
};

const built: BuiltContext = {
  answerMode: "general",
  system: ["系统规则"],
  messages: [
    { role: "system", content: "系统规则" },
    { role: "user", content: "读取证据。" },
  ],
  provenance: [],
  excluded: [],
  estimatedTokens: 10,
};

const evidence: NoteChunk = {
  id: "evidence-1",
  libraryId: "library-a",
  documentId: "document-a",
  documentVersionHash: "hash-a",
  relativePath: "证据.md",
  titlePath: ["证据"],
  tags: [],
  ordinal: 0,
  start: 0,
  end: 8,
  text: "唯一证据。",
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

function failingStream(code: ProviderErrorCode) {
  return (async function* () {
    yield* [];
    throw new ProviderError(providerErrorMessage(code), code);
  })();
}

function runtime(overrides: Partial<AgentRuntime> = {}): AgentRuntime {
  return {
    complete: async () => ({ content: "", toolCalls: [] }),
    stream: async function* () {
      yield { type: "token", text: "完成。", channel: "final" };
      yield { type: "done", finishReason: "stop" };
    },
    search: async () => [],
    read: async () => [],
    now: () => 100,
    sleep: async () => undefined,
    ...overrides,
  };
}

async function injectedFailure(code: ProviderErrorCode) {
  let requests = 0;
  const delays: number[] = [];
  const appended: AppendAgentStepInput[] = [];
  let failure: AgentRunFailure | undefined;
  try {
    await runAgentTurn({
      built,
      projectId: "project-a",
      libraryIds: ["library-a"],
      capability: nativeCapability,
      signal: new AbortController().signal,
      onPhase: () => undefined,
      onToken: () => undefined,
      budgetLimits: { rounds: 10 },
      audit: {
        runId: `run-${code}`,
        turnId: `turn-${code}`,
        appendStep: async (step) => {
          appended.push(structuredClone(step));
        },
      },
      protocolRecovery: {
        invalidateAndReprobe: async () => nativeCapability,
      },
      runtime: runtime({
        stream: () => {
          requests += 1;
          return failingStream(code);
        },
        sleep: async (delayMs) => {
          delays.push(delayMs);
        },
      }),
    });
  } catch (cause) {
    assert.ok(cause instanceof AgentRunFailure);
    failure = cause;
  }
  return { requests, delays, appended, failure };
}

test("401/configuration failures never retry", async () => {
  const result = await injectedFailure("unauthorized");
  assert.equal(result.requests, 1);
  assert.equal(
    result.appended.filter((step) => step.event.message.kind === "retry")
      .length,
    0,
  );
  assert.deepEqual(result.failure?.terminal, {
    result: "failed",
    reason: "none",
  });
});

test("429 uses exactly two bounded backoff retries", async () => {
  const result = await injectedFailure("rate-limited");
  assert.equal(result.requests, 3);
  assert.deepEqual(result.delays, [250, 750]);
  const retries = result.appended.filter(
    (step) => step.event.message.kind === "retry",
  );
  assert.equal(retries.length, 2);
  assert.deepEqual(
    retries.map((step) =>
      step.event.message.kind === "retry"
        ? [step.event.message.attempt, step.event.message.delayMs]
        : [],
    ),
    [
      [1, 250],
      [2, 750],
    ],
  );
});

for (const code of [
  "service-unavailable",
  "upstream",
  "disconnected",
  "timeout",
] as const) {
  test(`${code} retries at most twice without backoff`, async () => {
    const result = await injectedFailure(code);
    assert.equal(result.requests, 3);
    assert.deepEqual(result.delays, []);
    const retries = result.appended.filter(
      (step) => step.event.message.kind === "retry",
    );
    assert.equal(retries.length, 2);
    assert.ok(
      retries.every(
        (step) =>
          step.event.message.kind === "retry" &&
          step.event.message.delayMs === 0,
      ),
    );
  });
}

test("empty response retries twice per request then enters bounded protocol repair", async () => {
  const result = await injectedFailure("empty-response");
  assert.ok(result.requests <= 9, "all attempts stay inside the run ledger");
  assert.ok(result.requests >= 4, "repair starts only after the first retries");
  assert.deepEqual(result.failure?.terminal, {
    result: "failed",
    reason: "protocol_error",
  });
  assert.ok(
    result.appended.some(
      (step) =>
        step.event.message.kind === "protocol-repaired" &&
        /same-model-same-protocol-repair-entered/.test(
          step.event.message.action,
        ),
    ),
  );
});

test("invalid provider response enters protocol repair without raw transport retry", async () => {
  const result = await injectedFailure("invalid-response");
  assert.equal(
    result.appended.filter((step) => step.event.message.kind === "retry")
      .length,
    0,
  );
  assert.deepEqual(result.failure?.terminal, {
    result: "failed",
    reason: "protocol_error",
  });
});

test("ambiguous streamed payload asks the same model to resend a complete legal call", async () => {
  let request = 0;
  const searches: string[] = [];
  const appended: AppendAgentStepInput[] = [];
  const outcome = await runAgentTurn({
    built,
    projectId: "project-a",
    libraryIds: ["library-a"],
    capability: nativeCapability,
    signal: new AbortController().signal,
    onPhase: () => undefined,
    onToken: () => undefined,
    audit: {
      runId: "run-resend",
      turnId: "turn-resend",
      appendStep: async (step) => appended.push(structuredClone(step)),
    },
    runtime: runtime({
      stream: (input) => {
        request += 1;
        if (request === 1)
          return events([
            {
              type: "tool-call-delta",
              index: 0,
              id: "bad-call",
              name: "",
              arguments: '{"query":"证据"}',
            },
            { type: "done", finishReason: "tool_calls" },
          ]);
        if (request === 2) {
          assert.equal(input.toolChoice, "required");
          assert.match(
            input.messages[input.messages.length - 1]?.content ?? "",
            /不会猜工具名、补 token、补括号/,
          );
          return events([
            {
              type: "tool-call-delta",
              index: 0,
              id: "resent-search",
              name: "search_notes",
              arguments: '{"query":"证据"}',
            },
            { type: "done", finishReason: "tool_calls" },
          ]);
        }
        return events([
          { type: "token", text: "已完成。", channel: "final" },
          { type: "done", finishReason: "stop" },
        ]);
      },
      search: async (input) => {
        searches.push(input.query);
        return [];
      },
    }),
  });
  assert.deepEqual(searches, ["证据"]);
  assert.equal(outcome.terminal.result, "completed");
  assert.ok(
    appended.some((step) => step.event.message.kind === "search-requested"),
  );
  assert.ok(
    appended.some((step) => step.event.message.kind === "search-completed"),
  );
  assert.ok(
    appended.some(
      (step) =>
        step.event.message.kind === "protocol-repaired" &&
        step.event.message.action ===
          "same-model-resend-produced-complete-legal-call" &&
        step.event.message.deterministic === false,
    ),
  );
});

test("deterministic Unicode sanitation and lossless reassembly are persisted before execution", async () => {
  let request = 0;
  let searches = 0;
  const appended: AppendAgentStepInput[] = [];
  const outcome = await runAgentTurn({
    built,
    projectId: "project-a",
    libraryIds: ["library-a"],
    capability: nativeCapability,
    signal: new AbortController().signal,
    onPhase: () => undefined,
    onToken: () => undefined,
    audit: {
      runId: "run-unicode-repair",
      turnId: "turn-unicode-repair",
      appendStep: async (step) => appended.push(structuredClone(step)),
    },
    runtime: runtime({
      stream: () => {
        request += 1;
        if (request === 1)
          return events([
            {
              type: "tool-call-delta",
              index: 0,
              id: "unicode-search",
              name: "ｓｅａｒｃｈ＿ｎｏｔｅｓ\u200b",
              arguments: '｛\u200b"query"：',
            },
            {
              type: "tool-call-delta",
              index: 0,
              arguments: '"证据"｝',
            },
            { type: "done", finishReason: "tool_calls" },
          ]);
        return events([
          { type: "token", text: "已执行清洗后的合法调用。", channel: "final" },
          { type: "done", finishReason: "stop" },
        ]);
      },
      search: async (input) => {
        searches += 1;
        assert.equal(input.query, "证据");
        return [];
      },
    }),
  });
  assert.equal(searches, 1);
  assert.equal(outcome.terminal.result, "completed");
  const repairs = appended.flatMap((step) =>
    step.event.message.kind === "protocol-repaired" ? [step.event.message] : [],
  );
  const actions = repairs.map((repair) => repair.action);
  assert.ok(actions.some((action) => /NFKC/.test(action)));
  assert.ok(actions.some((action) => /零宽/.test(action)));
  assert.ok(actions.some((action) => /无损重组/.test(action)));
  assert.ok(repairs.every((repair) => repair.deterministic === true));
});

test("capability invalidation and re-probe precede retry from the stable checkpoint", async () => {
  let streamRequest = 0;
  let reprobes = 0;
  let searches = 0;
  const appended: AppendAgentStepInput[] = [];
  const visible: string[] = [];
  const bad = () =>
    events([
      {
        type: "tool-call-delta",
        index: 0,
        id: "bad",
        name: "search_notes",
        arguments: '{"query":"未闭合"',
      },
      { type: "done", finishReason: "tool_calls" },
    ]);
  const outcome = await runAgentTurn({
    built,
    projectId: "project-a",
    libraryIds: ["library-a"],
    capability: nativeCapability,
    signal: new AbortController().signal,
    onPhase: () => undefined,
    onToken: (event) => visible.push(event.text),
    audit: {
      runId: "run-reprobe",
      turnId: "turn-reprobe",
      appendStep: async (step) => appended.push(structuredClone(step)),
    },
    protocolRecovery: {
      invalidateAndReprobe: async () => {
        reprobes += 1;
        return nativeCapability;
      },
    },
    runtime: runtime({
      stream: () => {
        streamRequest += 1;
        if (streamRequest <= 2) return bad();
        if (streamRequest === 3)
          return events([
            {
              type: "tool-call-delta",
              index: 0,
              id: "reprobed-search",
              name: "search_notes",
              arguments: '{"query":"证据"}',
            },
            { type: "done", finishReason: "tool_calls" },
          ]);
        return events([
          { type: "token", text: "基于稳定检查点完成。", channel: "final" },
          { type: "done", finishReason: "stop" },
        ]);
      },
      complete: async () => ({ content: "", toolCalls: [] }),
      search: async () => {
        searches += 1;
        return [evidenceHit];
      },
    }),
  });
  assert.equal(reprobes, 1);
  assert.equal(searches, 1);
  assert.deepEqual(visible, ["基于稳定检查点完成。"]);
  assert.deepEqual(outcome.terminal, {
    result: "partial",
    reason: "rounds_exhausted",
  });
  const actions = appended.flatMap((step) =>
    step.event.message.kind === "protocol-repaired"
      ? [step.event.message.action]
      : [],
  );
  assert.ok(
    actions.indexOf(
      "matching-capability-cache-invalidated-and-reprobe-started",
    ) < actions.indexOf("capability-reprobe-confirmed-native-tools"),
  );
  assert.ok(
    actions.includes(
      "last-stable-checkpoint-retry-produced-complete-legal-call",
    ),
  );
  assert.ok(
    appended
      .filter((step) => step.event.message.kind === "protocol-repaired")
      .every(
        (step) =>
          step.event.message.kind === "protocol-repaired" &&
          step.event.message.deterministic === false,
      ),
  );
});

test("no heuristic completion executes and protocol_error appears only after repair exhaustion", async () => {
  let searches = 0;
  let streams = 0;
  let failure: AgentRunFailure | undefined;
  const appended: AppendAgentStepInput[] = [];
  try {
    await runAgentTurn({
      built,
      projectId: "project-a",
      libraryIds: ["library-a"],
      capability: nativeCapability,
      signal: new AbortController().signal,
      onPhase: () => undefined,
      onToken: () => undefined,
      audit: {
        runId: "run-repair-exhausted",
        turnId: "turn-repair-exhausted",
        appendStep: async (step) => appended.push(structuredClone(step)),
      },
      protocolRecovery: {
        invalidateAndReprobe: async () => nativeCapability,
      },
      runtime: runtime({
        stream: () => {
          streams += 1;
          return events([
            {
              type: "tool-call-delta",
              index: 0,
              id: `truncated-${streams}`,
              name: "search_notes",
              arguments: '{"query":"绝不补括号"',
            },
            { type: "done", finishReason: "tool_calls" },
          ]);
        },
        complete: async () => ({ content: "", toolCalls: [] }),
        search: async () => {
          searches += 1;
          return [];
        },
      }),
    });
  } catch (cause) {
    assert.ok(cause instanceof AgentRunFailure);
    failure = cause;
  }
  assert.equal(searches, 0);
  assert.ok(streams >= 3);
  assert.deepEqual(failure?.terminal, {
    result: "failed",
    reason: "protocol_error",
  });
  assert.match(failure?.message ?? "", /协议修复已耗尽/);
  const actions = appended.flatMap((step) =>
    step.event.message.kind === "protocol-repaired"
      ? [step.event.message.action]
      : [],
  );
  assert.ok(actions.includes("same-model-native-tools-resend-requested"));
  assert.ok(actions.includes("same-protocol-non-stream-request-rebuilt"));
  assert.ok(
    actions.includes(
      "matching-capability-cache-invalidated-and-reprobe-started",
    ),
  );
  assert.ok(actions.includes("capability-reprobe-confirmed-native-tools"));
});
