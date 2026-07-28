import assert from "node:assert/strict";
import test from "node:test";
import { consumeAgentBudget, createAgentBudgetLedger } from "./agentBudget";
import type { AgentAudit, AgentMessage } from "./agentEvents";
import {
  projectAgentTimeline,
  safeAgentRelativePath,
  trajectoryPromotionDraft,
} from "./agentTimeline";
import { agentTerminalMessage, type AgentTerminalState } from "./agentTerminal";
import { buildContext } from "./context";
import type { Card, CardEdge, ContextSnapshot } from "../types";

const terminalStates: AgentTerminalState[] = [
  { result: "completed", reason: "none" },
  { result: "partial", reason: "rounds_exhausted" },
  { result: "partial", reason: "calls_exhausted" },
  { result: "partial", reason: "wall_exhausted" },
  { result: "partial", reason: "tokens_exhausted" },
  { result: "partial", reason: "no_progress" },
  { result: "refused", reason: "insufficient_evidence" },
  { result: "failed", reason: "protocol_error" },
  { result: "failed", reason: "none" },
  { result: "aborted", reason: "user_abort" },
];

function auditWith(
  messages: AgentMessage[],
  terminal?: AgentTerminalState,
  phase: "exploring" | "interrupted" | "terminal" = terminal
    ? "terminal"
    : "exploring",
): Extract<AgentAudit, { kind: "event-sourced" }> {
  const ledger = createAgentBudgetLedger({
    rounds: 4,
    calls: 8,
    wallMs: 120_000,
    tokens: 32_000,
  });
  consumeAgentBudget(ledger, "rounds", 2, 20);
  consumeAgentBudget(ledger, "calls", 3, 21);
  consumeAgentBudget(ledger, "wallMs", 15_000, 22);
  return {
    kind: "event-sourced",
    run: {
      id: "run-safe-1",
      turnId: "turn-1",
      schemaVersion: 1,
      phase,
      startedAt: 10,
      updatedAt: 30,
      ...(phase === "terminal" ? { finishedAt: 30 } : {}),
      lastSequence: messages.length,
      checkpoint: {
        phase,
        objective: "核对事件时间线",
        executedSearches: ["内部代号"],
        readChunkIds: ["chunk-1"],
        confirmedCitationChunkIds: [],
        unresolvedQuestions: [],
        addedBudget: {},
        budget: ledger,
        ...(terminal ? { terminal, stopReason: terminal.reason } : {}),
      },
    },
    events: messages.map((message, index) => ({
      id: `event-${index + 1}`,
      runId: "run-safe-1",
      sequence: index + 1,
      schemaVersion: 1,
      eventType: message.kind,
      occurredAt: 10 + index,
      message,
    })),
  };
}

const richMessages: AgentMessage[] = [
  {
    kind: "exploration-started",
    objective: "核对内部代号",
    mode: "native-tools",
    budget: { rounds: 4, calls: 8, wallMs: 120_000, tokens: 32_000 },
  },
  {
    kind: "search-requested",
    query: "海蓝计划 内部代号",
    callId: "call-search",
  },
  {
    kind: "search-completed",
    query: "海蓝计划 内部代号",
    callId: "call-search",
    hitCount: 2,
    hitChunkIds: ["chunk-1", "chunk-2"],
  },
  {
    kind: "read-requested",
    chunkIds: ["chunk-1"],
    callId: "call-read",
  },
  {
    kind: "read-completed",
    requestedChunkIds: ["chunk-1"],
    callId: "call-read",
    sources: [
      {
        chunkId: "chunk-1",
        libraryId: "library-secret",
        documentId: "document-secret",
        title: "海蓝计划",
        relativePath: "/Users/example/private-vault/海蓝计划.md",
        documentHash: "hash-secret",
        text: "唯一事实：内部代号是 ORBIT-97。",
      },
    ],
  },
  {
    kind: "protocol-repaired",
    issue: "deterministic-tool-protocol-cleanup",
    action: "对工具名执行 NFKC 规范化。",
    deterministic: true,
  },
  {
    kind: "protocol-repaired",
    issue: "tool_call 缺少完整参数",
    action: "ambiguous-payload-requires-same-model-resend",
    deterministic: false,
  },
  { kind: "retry", attempt: 1, reason: "rate-limited", delayMs: 250 },
  {
    kind: "final-synthesis",
    stage: "started",
    basisEventIds: ["event-5"],
    unresolvedQuestions: [],
  },
  {
    kind: "final-synthesis",
    stage: "completed",
    basisEventIds: ["event-5"],
    unresolvedQuestions: [],
  },
  {
    kind: "terminal",
    terminal: { result: "partial", reason: "rounds_exhausted" },
    answer: "部分答案",
    citations: [],
    unresolvedQuestions: ["仍有问题"],
  },
];

test("schema-v1 projection preserves live event order and exposes only safe read details", () => {
  const audit = auditWith(
    richMessages,
    { result: "partial", reason: "rounds_exhausted" },
    "terminal",
  );
  const projection = projectAgentTimeline(audit);

  assert.deepEqual(
    projection.nodes.map((node) => node.kind),
    richMessages.map((message) => message.kind),
  );
  assert.equal(projection.nodes[1]?.title, "请求搜索");
  assert.equal(projection.nodes[2]?.summary, "2 个命中");
  assert.equal(projection.nodes[4]?.title, "读取完成");
  assert.deepEqual(projection.nodes[4]?.sources, [
    {
      key: "event-5:source:0",
      title: "海蓝计划",
      relativePath: "[路径已隐藏]",
      excerpt: "唯一事实:内部代号是 ORBIT-97。",
    },
  ]);
  const serializedSource = JSON.stringify(projection.nodes[4]?.sources);
  assert.doesNotMatch(
    serializedSource,
    /library-secret|document-secret|hash-secret|chunk-1/,
  );
  for (const node of projection.nodes) {
    assert.doesNotMatch(
      Object.keys(node).join(","),
      /citation|reference|anchor/i,
    );
    for (const source of node.sources)
      assert.doesNotMatch(
        Object.keys(source).join(","),
        /citation|reference|anchor|chunkId/i,
      );
  }
  assert.equal(projection.nodes[5]?.repairMode, "deterministic");
  assert.equal(projection.nodes[6]?.repairMode, "model-resend");
  assert.match(projection.nodes[6]?.summary ?? "", /同一模型重发/);
  assert.equal(projection.nodes[7]?.summary, "第 1 次 · rate-limited");
  assert.equal(projection.presentation?.truncated, true);
  assert.equal(projection.presentation?.protocolRepairCount, 2);
  assert.equal(projection.presentation?.retryCount, 1);
  assert.deepEqual(
    projection.presentation?.budget.map((row) => [
      row.dimension,
      row.limit,
      row.used,
      row.remaining,
    ]),
    [
      ["rounds", "4", "2", "2"],
      ["calls", "8", "3", "5"],
      ["wallMs", "120.0 秒", "15.0 秒", "105.0 秒"],
      ["tokens", "32,000", "未报告", "未报告"],
    ],
  );
});

test("every legal terminal renders the accepted TASK-002 result, reason, and copy", () => {
  for (const terminal of terminalStates) {
    const audit = auditWith(
      [
        {
          kind: "terminal",
          terminal,
          citations: [],
          unresolvedQuestions: [],
        },
      ],
      terminal,
    );
    const presentation = projectAgentTimeline(audit).presentation;
    assert.equal(presentation?.state, "terminal");
    assert.equal(presentation?.message, agentTerminalMessage(terminal));
    assert.equal(presentation?.terminal?.result, terminal.result);
    assert.equal(presentation?.terminal?.reason, terminal.reason);
    assert.ok(presentation?.resultLabel);
    assert.ok(presentation?.reasonLabel);
    assert.equal(
      presentation?.truncated,
      terminal.result === "partial" && terminal.reason !== "no_progress",
    );
  }
});

test("interruption and no-progress remain distinct persisted presentations", () => {
  const interrupted = projectAgentTimeline(
    auditWith(
      [
        {
          kind: "retry",
          attempt: 0,
          reason: "interrupted-recovery",
        },
      ],
      undefined,
      "interrupted",
    ),
  ).presentation;
  assert.equal(interrupted?.state, "interrupted");
  assert.equal(interrupted?.resultLabel, "已中断");
  assert.match(interrupted?.message ?? "", /可继续深挖/);

  const noProgress = { result: "partial", reason: "no_progress" } as const;
  const partial = projectAgentTimeline(
    auditWith(
      [
        {
          kind: "duplicate-call-detected",
          signature: "read_notes:{hidden-payload}",
          occurrences: 3,
        },
        {
          kind: "terminal",
          terminal: noProgress,
          citations: [],
          unresolvedQuestions: [],
        },
      ],
      noProgress,
    ),
  );
  assert.equal(partial.presentation?.reasonLabel, "继续探索无新进展");
  assert.equal(partial.presentation?.truncated, false);
  assert.doesNotMatch(JSON.stringify(partial.nodes), /hidden-payload/);
});

test("trajectory promotion is an administrative backlink with no authority-bearing payload", () => {
  const audit = auditWith(richMessages, {
    result: "partial",
    reason: "rounds_exhausted",
  });
  const readNode = projectAgentTimeline(audit).nodes[4]!;
  const draft = trajectoryPromotionDraft(audit.run.id, readNode);
  const serialized = JSON.stringify(draft);

  assert.equal(draft.sourceText, "探索轨迹 · 步骤 5");
  assert.match(draft.sourceBlockText, /run run-safe-1 · event event-5/);
  assert.doesNotMatch(
    serialized,
    /ORBIT-97|海蓝计划 内部代号|private-vault|library-secret|document-secret|chunk-1/,
  );
  assert.doesNotMatch(serialized, /citation|reference|anchor|source:\[\[/i);
  assert.deepEqual(Object.keys(draft), [
    "title",
    "sourceText",
    "sourceBlockText",
  ]);
});

test("a promoted trajectory card inherits only its administrative backlink", () => {
  const audit = auditWith(richMessages, {
    result: "partial",
    reason: "rounds_exhausted",
  });
  const readNode = projectAgentTimeline(audit).nodes[4]!;
  const draft = trajectoryPromotionDraft(audit.run.id, readNode);
  const source: Card = {
    id: "source-card",
    projectId: "project-1",
    title: "来源探索",
    favorite: false,
    unread: false,
    concepts: [],
    createdAt: 1,
    turns: [
      {
        id: "source-turn",
        role: "ai",
        content:
          "SECRET FACT ORBIT-97，搜索词与协议 payload 都只能留在来源轨迹。",
        createdAt: 2,
        status: "complete",
        citations: [
          {
            chunkId: "chunk-secret",
            libraryId: "library-secret",
            documentId: "document-secret",
            title: "秘密来源",
            relativePath: "Vault/秘密.md",
            documentHash: "hash-secret",
            excerpt: "SECRET FACT ORBIT-97",
          },
        ],
      },
    ],
  };
  const promoted: Card = {
    id: "promoted-card",
    projectId: "project-1",
    title: draft.title,
    favorite: false,
    unread: false,
    concepts: [],
    origin: "trajectory-promotion",
    createdAt: 3,
    turns: [],
  };
  const edge: CardEdge = {
    id: "edge-1",
    type: "child",
    sourceCardId: source.id,
    targetCardId: promoted.id,
    sourceTurnId: source.turns[0]!.id,
    sourceText: draft.sourceText,
    sourceBlockText: draft.sourceBlockText,
    contextSnapshotId: "snapshot-1",
    contextPolicy: "topic-and-selection",
  };
  const snapshot: ContextSnapshot = {
    id: "snapshot-1",
    edgeId: edge.id,
    createdAt: 3,
    sourceTitle: source.title,
    sourceText: draft.sourceText,
    sourceBlockText: draft.sourceBlockText,
  };
  const built = buildContext({
    cards: [source, promoted],
    edges: [edge],
    snapshots: [snapshot],
    references: [],
    currentCardId: promoted.id,
  });
  const serialized = JSON.stringify(built);

  assert.match(serialized, /探索轨迹 · 步骤 5/);
  assert.match(serialized, /event event-5/);
  assert.doesNotMatch(
    serialized,
    /SECRET FACT|ORBIT-97|chunk-secret|library-secret|document-secret|Vault\/秘密|protocol payload/,
  );
  assert.equal(
    built.provenance.some(
      (item) =>
        item.kind === "reference" || item.kind === "historical-retrieval",
    ),
    false,
  );
});

test("unsafe paths never cross the safe trajectory projection", () => {
  assert.equal(safeAgentRelativePath("../Vault/秘密.md"), "[路径已隐藏]");
  assert.equal(safeAgentRelativePath("C:\\Vault\\秘密.md"), "[路径已隐藏]");
  assert.equal(
    safeAgentRelativePath("研究/公开相对路径.md"),
    "研究/公开相对路径.md",
  );
});

test("legacy and unsupported event schemas do not masquerade as a timeline", () => {
  assert.deepEqual(
    projectAgentTimeline({ kind: "legacy", turnId: "t", trace: null }),
    { nodes: [], presentation: null },
  );
  const audit = auditWith(richMessages);
  audit.run.schemaVersion = 2 as 1;
  assert.deepEqual(projectAgentTimeline(audit), {
    nodes: [],
    presentation: null,
  });
});
