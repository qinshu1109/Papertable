import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_EVENT_SCHEMA_VERSION,
  AGENT_EVENT_TYPES,
  isAgentEventType,
  type AgentMessage,
  type AgentWorkingSet,
  type ConvertToLlm,
} from "./agentEvents";

test("TASK-003 exposes the complete versioned step-event vocabulary", () => {
  assert.equal(AGENT_EVENT_SCHEMA_VERSION, 1);
  assert.deepEqual(AGENT_EVENT_TYPES, [
    "exploration-started",
    "search-requested",
    "search-completed",
    "read-requested",
    "read-completed",
    "duplicate-call-detected",
    "protocol-repaired",
    "retry",
    "budget-added",
    "final-synthesis",
    "terminal",
  ]);
  for (const kind of AGENT_EVENT_TYPES)
    assert.equal(isAgentEventType(kind), true);
  assert.equal(isAgentEventType("token-delta"), false, "逐 token 不是步骤事件");
});

test("full audit messages and the future provider working set are distinct types", () => {
  const audit: AgentMessage = {
    kind: "read-completed",
    requestedChunkIds: ["chunk-1"],
    sources: [
      {
        chunkId: "chunk-1",
        libraryId: "library-1",
        documentId: "document-1",
        title: "来源",
        relativePath: "资料/来源.md",
        documentHash: "hash-1",
        text: "完整审计原文",
      },
    ],
  };
  const workingSet: AgentWorkingSet = {
    objective: "回答用户问题",
    executedSearches: [{ query: "检索词", resultEventId: "event-2" }],
    readSources: audit.sources,
    confirmedCitations: [],
    unresolvedQuestions: [],
    addedBudget: {},
  };
  const convert: ConvertToLlm = (input) => [
    { role: "user", content: input.objective },
  ];

  assert.deepEqual(convert(workingSet), [
    { role: "user", content: "回答用户问题" },
  ]);
  // @ts-expect-error AgentMessage is an audit object, not a model working set.
  void convert(audit);
});
