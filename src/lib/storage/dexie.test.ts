import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import test from "node:test";
import Dexie from "dexie";
import {
  appendAgentStep,
  appendAgentStepWithFailureForTest,
  applyAttentionChanges,
  applyChanges,
  clearWorkspace,
  db,
  deleteProjectCascade,
  deleteProposals,
  deleteReferences,
  loadAttentionState,
  loadAgentAudit,
  loadWorkspace,
  putAttentionState,
  saveWorkspace,
  seedIfEmpty,
} from "./dexie";
import { diffAttention, diffWorkspace } from "../delta";
import { recoverInterruptedTurns } from "../context";
import type { AttentionSnapshot, WorkspaceSnapshot } from "../delta";
import {
  AGENT_EVENT_SCHEMA_VERSION,
  type AppendAgentStepInput,
} from "../agentEvents";
import {
  consumeAgentBudget,
  createAgentBudgetLedger,
  markAgentBudgetExhausted,
} from "../agentBudget";
import {
  appendAgentBudgetRecord,
  appendAgentBudgetStart,
  appendAgentBudgetTerminal,
  appendAgentDuplicateCall,
  appendAgentProtocolAction,
  appendAgentRetry,
} from "../agentBudgetAudit";
import { createAgentTerminalState } from "../agentTerminal";
import type { AgentRunTrace } from "../../types";
import {
  claimAgentContinuation,
  settleInterruptedAgentAudit,
} from "../agentResume";

const snapshot = (): WorkspaceSnapshot => ({
  projects: [{ id: "p", name: "测试项目", pinned: false, updatedAt: 1 }],
  cards: [
    {
      id: "c",
      projectId: "p",
      title: "根卡",
      favorite: false,
      unread: false,
      answerMode: "sources-only",
      concepts: [],
      createdAt: 1,
      turns: [
        {
          id: "t",
          role: "user",
          content: "你好",
          createdAt: 1,
          status: "complete",
        },
      ],
    },
  ],
  edges: [],
  anchors: [],
  snapshots: [],
  references: [],
  view: {
    id: "main",
    activeProjectId: "p",
    currentCardId: "c",
    drafts: { p: "草稿" },
    lastCardByProject: { p: "c" },
    collapsed: [],
    scrollPositions: { c: 120 },
  },
  settings: { id: "app", model: "claude-opus-5" },
});

/** 两张卡片、共三条轮次，用来观察一次流式追加到底写了多少行。 */
const busySnapshot = (): WorkspaceSnapshot => {
  const base = snapshot();
  return {
    ...base,
    cards: [
      {
        ...base.cards[0],
        turns: [
          base.cards[0].turns[0],
          {
            id: "t-stream",
            role: "ai",
            content: "已生成",
            createdAt: 2,
            streaming: true,
            status: "streaming",
          },
        ],
      },
      {
        id: "c2",
        projectId: "p",
        title: "旁支卡片",
        favorite: false,
        unread: false,
        concepts: [],
        createdAt: 2,
        turns: [{ id: "t2", role: "user", content: "另一条", createdAt: 2 }],
      },
    ],
  };
};

/** 复刻 store.tsx 的更新惯用法：只有目标卡片和目标轮次换掉引用。 */
const appendStreamToken = (
  previous: WorkspaceSnapshot,
  text: string,
): WorkspaceSnapshot => ({
  ...previous,
  cards: previous.cards.map((card) =>
    card.id === "c"
      ? {
          ...card,
          turns: card.turns.map((turn) =>
            turn.id === "t-stream" ? { ...turn, content: text } : turn,
          ),
        }
      : card,
  ),
});

const freshDb = async () => {
  await db.delete();
  await db.open();
};

const agentStep = (
  kind: "exploration-started" | "search-requested",
  index: number,
): AppendAgentStepInput => ({
  runId: "run-1",
  turnId: "t",
  schemaVersion: AGENT_EVENT_SCHEMA_VERSION,
  startedAt: 10,
  updatedAt: 10 + index,
  checkpoint: {
    phase: kind === "exploration-started" ? "exploring" : "searching",
    objective: "测试事件持久化",
    executedSearches: kind === "search-requested" ? ["知识图谱"] : [],
    readChunkIds: [],
    confirmedCitationChunkIds: [],
    unresolvedQuestions: [],
    addedBudget: {},
  },
  event: {
    id: `agent-event-${index}`,
    schemaVersion: AGENT_EVENT_SCHEMA_VERSION,
    occurredAt: 10 + index,
    message:
      kind === "exploration-started"
        ? {
            kind,
            objective: "测试事件持久化",
            mode: "unavailable",
          }
        : { kind, query: "知识图谱" },
  },
});

const v4Schema = {
  projects: "id, updatedAt, pinned",
  cards: "id, projectId, createdAt, trashed",
  turns: "id, cardId, createdAt",
  edges: "id, sourceCardId, targetCardId",
  anchors: "id, cardId, turnId",
  snapshots: "id, edgeId",
  references: "id, projectId",
  view: "id, activeProjectId, currentCardId",
  settings: "id",
  interactionEvents:
    "id, projectId, sessionId, createdAt, type, targetCardId, sourceCardId",
  sessionBoundaries:
    "id, projectId, localDate, startedAt, lastActiveAt, endedAt, processedAt",
  proposals:
    "id, projectId, sessionId, status, createdAt, expiresAt, purgeAt, candidateKey",
};

test("legacy model drafts are scrubbed before a workspace is returned", async () => {
  await freshDb();
  await saveWorkspace(snapshot());
  const legacy = (await db.turns.get("t")) as
    ({ reasoning?: string } & Record<string, unknown>) | undefined;
  assert.ok(legacy, "测试前提：旧轮次必须存在");
  legacy.reasoning = "this internal draft must never survive";
  await db.turns.put(legacy as never);

  const restored = await loadWorkspace();
  assert.ok(restored);
  assert.ok(
    !("reasoning" in restored.cards[0].turns[0]),
    "旧草稿不得回到运行时 Card",
  );
  assert.ok(
    !("reasoning" in ((await db.turns.get("t")) ?? {})),
    "读取前的兼容清理必须把 IndexedDB 旧字段删除",
  );
});

test("a streaming save writes exactly one turn row and never rewrites whole tables", () => {
  const before = busySnapshot();
  const after = appendStreamToken(before, "已生成更多文本");
  const upsert = diffWorkspace(before, after);

  // 唯一该落库的就是那条还在生成的轮次。
  assert.equal(upsert.turns.upserts.length, 1);
  assert.equal(upsert.turns.upserts[0].id, "t-stream");
  assert.equal(upsert.turns.upserts[0].content, "已生成更多文本");
  assert.equal(upsert.turns.upserts[0].cardId, "c");

  // 卡片行不含 turns，只有 turns 变化时不该重写；其余表和单例行完全不动。
  assert.deepEqual(upsert.cards, { upserts: [] });
  assert.deepEqual(upsert.projects, { upserts: [] });
  assert.deepEqual(upsert.edges, { upserts: [] });
  assert.deepEqual(upsert.anchors, { upserts: [] });
  assert.deepEqual(upsert.snapshots, { upserts: [] });
  assert.deepEqual(upsert.references, { upserts: [] });
  assert.equal(upsert.view, null);
  assert.equal(upsert.settings, null);
});

test("cold-start streaming recovery persists an interrupted turn before it is reloaded", async () => {
  await freshDb();
  const before = busySnapshot();
  await saveWorkspace(before);
  const recovered = recoverInterruptedTurns(before.cards);
  const after = { ...before, cards: recovered.cards };
  await applyChanges(diffWorkspace(before, after));

  const restored = await loadWorkspace();
  const turn = restored?.cards[0]?.turns.find(
    (candidate) => candidate.id === "t-stream",
  );
  assert.deepEqual(recovered.recoveredTurnIds, ["t-stream"]);
  assert.equal(turn?.status, "interrupted");
  assert.equal(turn?.streaming, false);
  assert.equal(turn?.content, "已生成");
});

test("legacy turns stay readable without backfill, then switch to event-sourced audit", async () => {
  await freshDb();
  await saveWorkspace(snapshot());
  await db.turns.update("t", {
    agentRun: {
      mode: "unavailable",
      startedAt: 1,
      finishedAt: 2,
      searchQueries: ["旧检索"],
      hitCount: 1,
      readChunkIds: [],
    },
  });

  assert.deepEqual(await loadAgentAudit("t"), {
    kind: "legacy",
    turnId: "t",
    trace: {
      mode: "unavailable",
      startedAt: 1,
      finishedAt: 2,
      searchQueries: ["旧检索"],
      hitCount: 1,
      readChunkIds: [],
    },
  });
  assert.equal(await db.agentRuns.count(), 0, "legacy read must not backfill");
  assert.equal(
    await db.agentEvents.count(),
    0,
    "legacy read must not backfill",
  );

  const persisted = await appendAgentStep(agentStep("exploration-started", 1));
  assert.equal(persisted.sequence, 1);
  const audit = await loadAgentAudit("t");
  assert.equal(audit?.kind, "event-sourced");
  if (audit?.kind === "event-sourced") {
    assert.equal(audit.run.lastSequence, 1);
    assert.equal(audit.events[0].eventType, "exploration-started");
  }

  await saveWorkspace(snapshot());
  const afterSnapshot = await loadAgentAudit("t");
  assert.equal(
    afterSnapshot?.kind,
    "event-sourced",
    "ordinary workspace snapshots must preserve complete audit history",
  );
});

test("agent event and run cursor abort together at every IndexedDB transaction boundary", async () => {
  for (const failurePoint of [
    "after-run-ensured",
    "after-event-inserted",
    "after-run-state-changed",
  ] as const) {
    await freshDb();
    await saveWorkspace(snapshot());
    await assert.rejects(
      appendAgentStepWithFailureForTest(
        agentStep("exploration-started", 1),
        failurePoint,
      ),
      /injected crash/,
    );
    db.close();
    await db.open();
    assert.equal(await db.agentRuns.count(), 0);
    assert.equal(await db.agentEvents.count(), 0);
    assert.equal((await loadAgentAudit("t"))?.kind, "legacy");
  }
});

test("budget ledger and append audit survive close and reopen", async () => {
  await freshDb();
  await saveWorkspace(snapshot());
  await appendAgentStep(agentStep("exploration-started", 1));
  const ledger = createAgentBudgetLedger({ calls: 1 });
  consumeAgentBudget(ledger, "calls", 1, 12);
  const record = markAgentBudgetExhausted(ledger, "calls_exhausted", 13);
  await appendAgentStep({
    runId: "run-1",
    turnId: "t",
    schemaVersion: AGENT_EVENT_SCHEMA_VERSION,
    startedAt: 10,
    updatedAt: 13,
    checkpoint: {
      phase: "exploring",
      objective: "测试事件持久化",
      executedSearches: [],
      readChunkIds: [],
      confirmedCitationChunkIds: [],
      unresolvedQuestions: ["预算耗尽：calls_exhausted"],
      addedBudget: {},
      stopReason: "calls_exhausted",
      budget: ledger,
    },
    event: {
      id: "agent-event-budget",
      schemaVersion: AGENT_EVENT_SCHEMA_VERSION,
      occurredAt: 13,
      message: {
        kind: "budget-added",
        record,
        ledger,
        reason: "TASK-005 usage append",
      },
    },
  });

  db.close();
  await db.open();
  const audit = await loadAgentAudit("t");
  assert.equal(audit?.kind, "event-sourced");
  if (audit?.kind !== "event-sourced") return;
  assert.equal(audit.run.checkpoint.budget?.used.calls, 1);
  assert.equal(audit.run.checkpoint.budget?.remaining.calls, 0);
  assert.equal(
    audit.run.checkpoint.budget?.exhaustionReason,
    "calls_exhausted",
  );
  assert.deepEqual(
    audit.events.map((event) => event.eventType),
    ["exploration-started", "budget-added"],
  );
  assert.equal(
    audit.events[1]?.message.kind === "budget-added"
      ? audit.events[1].message.record?.sequence
      : undefined,
    2,
  );
});

test("duplicate-call detection and no-progress checkpoint survive close and reopen", async () => {
  await freshDb();
  await saveWorkspace(snapshot());
  const ledger = createAgentBudgetLedger();
  const trace: AgentRunTrace = {
    mode: "native-tools",
    startedAt: 10,
    finishedAt: 10,
    searchQueries: ["重复查询"],
    hitCount: 1,
    readChunkIds: ["qualified-evidence"],
    budget: ledger,
  };
  const persistence = {
    runId: "run-duplicate-reopen",
    turnId: "t",
    appendStep: appendAgentStep,
  };

  await appendAgentBudgetStart(persistence, trace, ledger);
  await appendAgentDuplicateCall(
    persistence,
    trace,
    ledger,
    "read_notes:stable",
    2,
    11,
  );
  await appendAgentDuplicateCall(
    persistence,
    trace,
    ledger,
    "read_notes:stable",
    3,
    12,
  );

  db.close();
  await db.open();
  const audit = await loadAgentAudit("t");
  assert.equal(audit?.kind, "event-sourced");
  if (audit?.kind !== "event-sourced") return;
  assert.equal(audit.run.schemaVersion, 1);
  assert.equal(audit.run.lastSequence, 3);
  assert.equal(audit.run.checkpoint.stopReason, "no_progress");
  assert.deepEqual(audit.run.checkpoint.readChunkIds, ["qualified-evidence"]);
  assert.deepEqual(
    audit.events.map((event) => event.eventType),
    [
      "exploration-started",
      "duplicate-call-detected",
      "duplicate-call-detected",
    ],
  );
  assert.deepEqual(
    audit.events
      .slice(1)
      .map((event) =>
        event.message.kind === "duplicate-call-detected"
          ? event.message.occurrences
          : 0,
      ),
    [2, 3],
  );
});

test("TASK-007 retry, repair, capability invalidation and rejection survive close and reopen", async () => {
  await freshDb();
  await saveWorkspace(snapshot());
  const ledger = createAgentBudgetLedger();
  const trace: AgentRunTrace = {
    mode: "native-tools",
    startedAt: 10,
    finishedAt: 10,
    searchQueries: [],
    hitCount: 0,
    readChunkIds: [],
    budget: ledger,
  };
  const persistence = {
    runId: "run-protocol-reopen",
    turnId: "t",
    appendStep: appendAgentStep,
  };
  await appendAgentBudgetStart(persistence, trace, ledger);
  await appendAgentRetry(
    persistence,
    trace,
    ledger,
    1,
    "rate-limited",
    250,
    1,
    11,
  );
  await appendAgentProtocolAction(
    persistence,
    trace,
    ledger,
    "tool_call 缺少工具名。",
    "same-model-native-tools-resend-requested",
    2,
    12,
  );
  await appendAgentProtocolAction(
    persistence,
    trace,
    ledger,
    "tool-call-rejected",
    "只能读取当前 run 的 Rust search allowlist 已返回的片段。",
    3,
    13,
  );
  await appendAgentProtocolAction(
    persistence,
    trace,
    ledger,
    "工具协议仍不完整。",
    "matching-capability-cache-invalidated-and-reprobe-started",
    4,
    14,
  );
  await appendAgentBudgetTerminal(
    persistence,
    trace,
    createAgentTerminalState("failed", "protocol_error"),
    15,
  );

  db.close();
  await db.open();
  const audit = await loadAgentAudit("t");
  assert.equal(audit?.kind, "event-sourced");
  if (audit?.kind !== "event-sourced") return;
  assert.equal(audit.run.schemaVersion, 1);
  assert.equal(audit.run.lastSequence, 6);
  assert.equal(audit.run.phase, "terminal");
  assert.deepEqual(audit.run.checkpoint.terminal, {
    result: "failed",
    reason: "protocol_error",
  });
  assert.deepEqual(
    audit.events.map((event) => event.eventType),
    [
      "exploration-started",
      "retry",
      "protocol-repaired",
      "protocol-repaired",
      "protocol-repaired",
      "terminal",
    ],
  );
  assert.equal(
    audit.events[1]?.message.kind === "retry"
      ? audit.events[1].message.delayMs
      : undefined,
    250,
  );
  assert.ok(
    audit.events.some(
      (event) =>
        event.message.kind === "protocol-repaired" &&
        event.message.action ===
          "matching-capability-cache-invalidated-and-reprobe-started",
    ),
  );
});

async function seedResumableTerminalRun() {
  await freshDb();
  await saveWorkspace(snapshot());
  const ledger = createAgentBudgetLedger({ rounds: 1, calls: 2 });
  const trace: AgentRunTrace = {
    mode: "native-tools",
    startedAt: 10,
    finishedAt: 10,
    searchQueries: ["已完成搜索"],
    hitCount: 1,
    readChunkIds: [],
    budget: ledger,
  };
  const persistence = {
    runId: "run-resume",
    turnId: "t",
    appendStep: appendAgentStep,
    hostScope: {
      projectId: "p",
      libraryIds: ["library-original"],
    },
    objective: "继续完成同一目标",
  };
  await appendAgentBudgetStart(persistence, trace, ledger);
  consumeAgentBudget(ledger, "rounds", 1, 11);
  const record = markAgentBudgetExhausted(ledger, "rounds_exhausted", 12);
  await appendAgentBudgetRecord(persistence, trace, ledger, record);
  await appendAgentBudgetTerminal(
    persistence,
    trace,
    createAgentTerminalState("partial", "rounds_exhausted"),
    13,
    { answer: "有界部分结果" },
  );
  const audit = await loadAgentAudit("t");
  assert.equal(audit?.kind, "event-sourced");
  if (audit?.kind !== "event-sourced")
    throw new Error("resumable audit was not created");
  return audit;
}

test("terminal budget extension and checkpoint reopen commit atomically on the same run", async () => {
  const audit = await seedResumableTerminalRun();
  const beforeSequence = audit.run.lastSequence;
  const resume = await claimAgentContinuation({
    audit,
    persistence: {
      runId: audit.run.id,
      turnId: audit.run.turnId,
      appendStep: appendAgentStep,
    },
    projectId: "p",
    addedBudget: { rounds: 2, calls: 3, wallMs: 10, tokens: 20 },
    occurredAt: 14,
  });
  assert.equal(resume.trace.startedAt, 10);

  db.close();
  await db.open();
  const reopened = await loadAgentAudit("t");
  assert.equal(reopened?.kind, "event-sourced");
  if (reopened?.kind !== "event-sourced") return;
  assert.equal(reopened.run.id, "run-resume");
  assert.equal(reopened.run.turnId, "t");
  assert.equal(reopened.run.phase, "exploring");
  assert.equal(reopened.run.finishedAt, undefined);
  assert.equal(reopened.run.lastSequence, beforeSequence + 1);
  assert.equal(
    reopened.events[reopened.events.length - 1]?.eventType,
    "budget-added",
  );
  assert.equal(reopened.run.checkpoint.budget?.used.rounds, 1);
  assert.equal(reopened.run.checkpoint.budget?.limits.rounds, 3);
  assert.equal(reopened.run.checkpoint.budget?.remaining.rounds, 2);
  assert.deepEqual(reopened.run.checkpoint.hostScope, {
    projectId: "p",
    libraryIds: ["library-original"],
  });
});

test("concurrent double resume has one atomic winner and no duplicate budget event", async () => {
  const audit = await seedResumableTerminalRun();
  const attempt = () =>
    claimAgentContinuation({
      audit,
      persistence: {
        runId: audit.run.id,
        turnId: audit.run.turnId,
        appendStep: appendAgentStep,
      },
      projectId: "p",
      occurredAt: 14,
    });
  const results = await Promise.allSettled([attempt(), attempt()]);
  assert.deepEqual(results.map((result) => result.status).sort(), [
    "fulfilled",
    "rejected",
  ]);
  const reopened = await loadAgentAudit("t");
  assert.equal(reopened?.kind, "event-sourced");
  if (reopened?.kind !== "event-sourced") return;
  assert.equal(
    reopened.events.filter(
      (event) =>
        event.message.kind === "budget-added" && Boolean(event.message.added),
    ).length,
    1,
  );
});

test("crash during continuation claim preserves the terminal event and checkpoint", async () => {
  for (const failurePoint of [
    "after-run-ensured",
    "after-event-inserted",
    "after-run-state-changed",
  ] as const) {
    const audit = await seedResumableTerminalRun();
    await assert.rejects(
      claimAgentContinuation({
        audit,
        persistence: {
          runId: audit.run.id,
          turnId: audit.run.turnId,
          appendStep: (step) =>
            appendAgentStepWithFailureForTest(step, failurePoint),
        },
        projectId: "p",
        occurredAt: 14,
      }),
      /injected crash/,
    );
    db.close();
    await db.open();
    const reopened = await loadAgentAudit("t");
    assert.equal(reopened?.kind, "event-sourced");
    if (reopened?.kind !== "event-sourced") continue;
    assert.equal(reopened.run.phase, "terminal");
    assert.deepEqual(reopened.run.checkpoint.terminal, {
      result: "partial",
      reason: "rounds_exhausted",
    });
    assert.equal(
      reopened.events.filter(
        (event) =>
          event.message.kind === "budget-added" && Boolean(event.message.added),
      ).length,
      0,
    );
  }
});

test("interrupted run settles at the committed checkpoint and resumes after reopen", async () => {
  await freshDb();
  await saveWorkspace(snapshot());
  const ledger = createAgentBudgetLedger({ rounds: 2 });
  const trace: AgentRunTrace = {
    mode: "native-tools",
    startedAt: 10,
    finishedAt: 10,
    searchQueries: [],
    hitCount: 0,
    readChunkIds: [],
    budget: ledger,
  };
  const persistence = {
    runId: "run-interrupted",
    turnId: "t",
    appendStep: appendAgentStep,
    hostScope: { projectId: "p", libraryIds: ["library-original"] },
    objective: "中断后继续",
  };
  await appendAgentBudgetStart(persistence, trace, ledger);
  const before = await loadAgentAudit("t");
  assert.ok(before);
  assert.equal(
    await settleInterruptedAgentAudit({
      audit: before!,
      persistence,
      occurredAt: 12,
    }),
    true,
  );
  db.close();
  await db.open();
  const interrupted = await loadAgentAudit("t");
  assert.equal(interrupted?.kind, "event-sourced");
  if (interrupted?.kind !== "event-sourced") return;
  assert.equal(interrupted.run.phase, "interrupted");
  assert.equal(interrupted.run.checkpoint.phase, "interrupted");
  assert.equal(
    interrupted.events[interrupted.events.length - 1]?.message.kind,
    "retry",
  );

  await claimAgentContinuation({
    audit: interrupted,
    persistence: {
      runId: interrupted.run.id,
      turnId: interrupted.run.turnId,
      appendStep: appendAgentStep,
    },
    projectId: "p",
    addedBudget: { rounds: 1 },
    occurredAt: 13,
  });
  const resumed = await loadAgentAudit("t");
  assert.equal(
    resumed?.kind === "event-sourced" ? resumed.run.phase : "",
    "exploring",
  );
});

test("crash after a committed budget extension resumes without charging it twice", async () => {
  const terminal = await seedResumableTerminalRun();
  const persistence = {
    runId: terminal.run.id,
    turnId: terminal.run.turnId,
    appendStep: appendAgentStep,
  };
  await claimAgentContinuation({
    audit: terminal,
    persistence,
    projectId: "p",
    addedBudget: { rounds: 2, calls: 3 },
    occurredAt: 14,
  });
  const claimed = await loadAgentAudit("t");
  assert.equal(claimed?.kind, "event-sourced");
  if (claimed?.kind !== "event-sourced") return;
  const limitsAfterClaim = structuredClone(
    claimed.run.checkpoint.budget?.limits,
  );
  await settleInterruptedAgentAudit({
    audit: claimed,
    persistence,
    occurredAt: 15,
  });

  db.close();
  await db.open();
  const interrupted = await loadAgentAudit("t");
  assert.equal(interrupted?.kind, "event-sourced");
  if (interrupted?.kind !== "event-sourced") return;
  assert.equal(interrupted.run.phase, "interrupted");
  assert.deepEqual(interrupted.run.checkpoint.addedBudget, {
    rounds: 2,
    calls: 3,
  });
  await claimAgentContinuation({
    audit: interrupted,
    persistence,
    projectId: "p",
    // A new UI default must be ignored: this is recovery of the already
    // purchased continuation, not a second user continuation.
    addedBudget: { rounds: 99 },
    occurredAt: 16,
  });
  const recovered = await loadAgentAudit("t");
  assert.equal(recovered?.kind, "event-sourced");
  if (recovered?.kind !== "event-sourced") return;
  assert.deepEqual(recovered.run.checkpoint.budget?.limits, limitsAfterClaim);
  assert.equal(
    recovered.events.filter(
      (event) =>
        event.message.kind === "budget-added" && Boolean(event.message.added),
    ).length,
    1,
  );
  const lastEvent = recovered.events[recovered.events.length - 1];
  assert.equal(lastEvent?.message.kind, "retry");
  if (lastEvent?.message.kind === "retry")
    assert.equal(lastEvent.message.reason, "interrupted-continuation-resumed");
});

test("incremental saves leave untouched rows in place", async () => {
  await freshDb();
  const before = busySnapshot();
  await saveWorkspace(before);

  // 一行 store 状态里没有、只存在于库中的卡片。整表重写会把它抹掉。
  await db.cards.put({
    id: "ghost",
    projectId: "p",
    title: "旁路写入",
    favorite: false,
    unread: false,
    concepts: [],
    createdAt: 9,
  });

  await applyChanges(diffWorkspace(before, appendStreamToken(before, "增量")));

  assert.ok(await db.cards.get("ghost"), "增量保存不得清空整表");
  assert.equal((await db.turns.get("t-stream"))?.content, "增量");
  assert.equal((await db.turns.get("t2"))?.content, "另一条");
});

test("incremental saves round-trip edits without ever deleting a row", async () => {
  await freshDb();
  let persisted = busySnapshot();
  await saveWorkspace(persisted);

  // 1. 改标题：卡片行要重写，轮次不动。
  const renamed: WorkspaceSnapshot = {
    ...persisted,
    cards: persisted.cards.map((card) =>
      card.id === "c2" ? { ...card, title: "改名后的旁支" } : card,
    ),
  };
  const renameUpsert = diffWorkspace(persisted, renamed);
  assert.deepEqual(
    renameUpsert.cards.upserts.map((card: { id: string }) => card.id),
    ["c2"],
  );
  assert.deepEqual(renameUpsert.turns.upserts, []);
  await applyChanges(renameUpsert);
  persisted = renamed;

  // 2. 一张卡片从内存状态里消失，**绝不能**因此被删除。这里原来断言的是
  //    「轮次要跟着删」——那条断言把缺陷写成了需求：删除是从每个标签页私有、
  //    永不与库对账的基线推导出来的，于是一个陈旧的标签页会真删掉另一个标签页
  //    刚建的行。删除现在只能来自 deleteProjectCascade 这类显式意图。
  const shrunk: WorkspaceSnapshot = {
    ...persisted,
    cards: persisted.cards.filter((card) => card.id !== "c2"),
  };
  await applyChanges(diffWorkspace(persisted, shrunk));

  assert.ok(await db.cards.get("c2"), "增量保存绝不删行");
  assert.ok(await db.turns.get("t2"), "增量保存绝不删轮次");
  const restored = await loadWorkspace();
  assert.deepEqual(restored?.cards.map((card) => card.id).sort(), ["c", "c2"]);
  assert.equal(restored?.view.drafts.p, "草稿");
});

test("the upsert contract has no deletes field at all", () => {
  const upsert = diffWorkspace(busySnapshot(), snapshot());
  // 将来有人把推导式删除加回来时，这里会立刻失败。
  for (const [name, table] of Object.entries(upsert)) {
    if (table === null || name === "view" || name === "settings") continue;
    assert.ok(!("deletes" in table), `${name} 不应该有 deletes 字段`);
  }
  const attention = diffAttention(
    { events: [], sessions: [], proposals: [] },
    { events: [], sessions: [], proposals: [] },
  );
  for (const [name, table] of Object.entries(attention))
    assert.ok(!("deletes" in table), `attention.${name} 不应该有 deletes 字段`);
});

test("deleteProjectCascade removes rows no in-memory snapshot ever saw", async () => {
  await freshDb();
  await saveWorkspace(busySnapshot());
  // 另一个标签页刚建的卡片和轮次：本标签页的任何快照里都没有它们。
  await db.cards.put({
    id: "ghost",
    projectId: "p",
    title: "另一个标签页建的",
    favorite: false,
    unread: false,
    concepts: [],
    createdAt: 9,
  });
  await db.turns.put({
    id: "t-ghost",
    cardId: "ghost",
    role: "user",
    content: "另一个标签页写的",
    createdAt: 9,
  });
  // 另一个项目的行必须完好无损。
  await db.projects.put({
    id: "p2",
    name: "别的项目",
    pinned: false,
    updatedAt: 1,
  });
  await db.cards.put({
    id: "c-other",
    projectId: "p2",
    title: "别的项目的卡",
    favorite: false,
    unread: false,
    concepts: [],
    createdAt: 3,
  });

  const removed = await deleteProjectCascade("p");

  assert.equal(await db.cards.get("ghost"), undefined, "级联应按库内容定位");
  assert.equal(await db.turns.get("t-ghost"), undefined);
  assert.equal(await db.cards.get("c"), undefined);
  assert.equal(await db.projects.get("p"), undefined);
  assert.ok(await db.cards.get("c-other"), "不得波及其他项目");
  assert.ok(await db.projects.get("p2"));
  assert.ok(
    removed.workspace.cards.upserts.some((card) => card.id === "ghost"),
    "返回值要包含库里真正删掉的行",
  );
});

test("undo restores what the database held, including other tabs' rows", async () => {
  await freshDb();
  await saveWorkspace(busySnapshot());
  await db.cards.put({
    id: "ghost",
    projectId: "p",
    title: "另一个标签页建的",
    favorite: false,
    unread: false,
    concepts: [],
    createdAt: 9,
  });

  const removed = await deleteProjectCascade("p");
  await applyChanges(removed.workspace);
  await applyAttentionChanges(removed.attention);

  const restored = await loadWorkspace();
  assert.deepEqual(
    restored?.cards.map((card) => card.id).sort(),
    ["c", "c2", "ghost"],
    "撤销要还原库里删除前的内容，而不是本标签页记得的内容",
  );
  assert.equal(
    restored?.cards.find((card) => card.id === "c")?.turns.length,
    2,
  );
});

test("closing one tab must not destroy another tab's sessions and proposals", async () => {
  await freshDb();
  const proposal = (id: string) => ({
    id,
    projectId: "p",
    sessionId: "s1",
    title: "方向",
    explorationQuestion: "接下来先验证什么？",
    reason: "测试",
    sourceAnchorIds: [],
    suggestedParentCardId: "c",
    suggestedRelation: "child" as const,
    evidence: "human-signals" as const,
    status: "queued" as const,
    candidateKey: `card:${id}`,
    signalScore: 6,
    signalEventIds: [],
    createdAt: 10,
    lastSignalAt: 10,
    expiresAt: 20,
    purgeAt: 30,
  });
  const session = (id: string) => ({
    id,
    projectId: "p",
    localDate: "2026-07-27",
    startedAt: 1,
    lastActiveAt: 10,
  });
  await putAttentionState({
    events: [],
    sessions: [session("s1"), session("s2")],
    proposals: [proposal("pr1"), proposal("pr2")],
  });

  // 第二个标签页只知道自己那一份状态，pagehide 时把它写回去。
  await putAttentionState({
    events: [],
    sessions: [session("s1")],
    proposals: [proposal("pr1")],
  });

  const after = await loadAttentionState();
  assert.deepEqual(
    after.proposals.map((row) => row.id).sort(),
    ["pr1", "pr2"],
    "关闭一个标签页不得销毁另一个标签页生成的提案",
  );
  assert.deepEqual(after.sessions.map((row) => row.id).sort(), ["s1", "s2"]);
});

test("proposals and references are removed only by explicit id", async () => {
  await freshDb();
  await saveWorkspace({
    ...snapshot(),
    references: [
      {
        id: "r1",
        projectId: "p",
        sourceTitle: "来源",
        excerpt: "片段",
        anchor: { cardId: "c", text: "片段" },
      },
      {
        id: "r2",
        projectId: "p",
        sourceTitle: "来源二",
        excerpt: "片段二",
        anchor: { cardId: "c", text: "片段二" },
      },
    ],
  });
  await deleteReferences(["r1"]);
  assert.equal(await db.references.get("r1"), undefined);
  assert.ok(await db.references.get("r2"));

  await deleteProposals([]);
  await deleteReferences([]);
});

test("attention events stay append-only across incremental saves", () => {
  const event = {
    id: "event-1",
    projectId: "p",
    sessionId: "session-1",
    type: "title-edited" as const,
    createdAt: 10,
    targetCardId: "c",
  };
  const before: AttentionSnapshot = {
    events: [event],
    sessions: [],
    proposals: [],
  };
  // 即使状态里不再出现这条事件，增量保存也绝不能删它。
  const upsert = diffAttention(before, {
    events: [],
    sessions: [],
    proposals: [],
  });
  assert.deepEqual(upsert.events, { upserts: [] });

  const appended = diffAttention(before, {
    ...before,
    events: [event, { ...event, id: "event-2", createdAt: 11 }],
  });
  assert.deepEqual(
    appended.events.upserts.map((entry: { id: string }) => entry.id),
    ["event-2"],
  );
});

test("seeding twice keeps the first seed instead of rewriting it", async () => {
  await freshDb();
  const first = await seedIfEmpty(snapshot());
  assert.equal(first.cards.length, 1);
  await db.cards.put({
    id: "later",
    projectId: "p",
    title: "播种后新增",
    favorite: false,
    unread: false,
    concepts: [],
    createdAt: 5,
  });
  const second = await seedIfEmpty(snapshot());
  assert.deepEqual(
    second.cards.map((card) => card.id).sort(),
    ["c", "later"],
    "第二次播种必须返回库里已有的内容，而不是覆盖它",
  );
});

test("IndexedDB restores cards, drafts and scroll positions", async () => {
  await freshDb();
  await saveWorkspace(snapshot());
  const restored = await loadWorkspace();
  assert.equal(restored?.cards[0].turns[0].content, "你好");
  assert.equal(restored?.view.drafts.p, "草稿");
  assert.equal(restored?.view.scrollPositions.c, 120);
  assert.equal(restored?.cards[0].answerMode, "sources-only");
  await clearWorkspace();
  assert.equal(await loadWorkspace(), null);
});

test("v4 workspace migrates through v7 without touching existing cards or backfilling events", async () => {
  // Construct a genuine v4 database before opening the current Dexie class.
  // This guards the real in-browser upgrade path rather than merely checking
  // that a freshly-created v5 database has the new tables.
  db.close();
  await db.delete();
  const legacy = new Dexie("papertable-web-v1");
  legacy.version(4).stores(v4Schema);
  await legacy.open();
  await legacy.table("projects").put({
    id: "legacy-project",
    name: "旧项目",
    pinned: false,
    updatedAt: 1,
  });
  await legacy.table("cards").put({
    id: "legacy-card",
    projectId: "legacy-project",
    title: "旧卡片",
    favorite: false,
    unread: false,
    concepts: [],
    createdAt: 1,
  });
  await legacy.table("turns").put({
    id: "legacy-turn",
    cardId: "legacy-card",
    role: "user",
    content: "旧问题",
    createdAt: 1,
  });
  await legacy.table("view").put({
    id: "main",
    activeProjectId: "legacy-project",
    currentCardId: "legacy-card",
    drafts: {},
    lastCardByProject: { "legacy-project": "legacy-card" },
    collapsed: [],
    scrollPositions: {},
  });
  await legacy.table("settings").put({
    id: "app",
    model: "claude-opus-5",
    providerCapabilities: [
      {
        baseUrl: "https://legacy.example/v1",
        model: "legacy",
        mode: "two-stage",
        streamingToolCalls: false,
        toolResultAccepted: false,
        testedAt: 1,
      },
    ],
  });
  legacy.close();

  await db.open();
  const restored = await loadWorkspace();
  assert.equal(db.verno, 7);
  assert.equal(restored?.cards[0]?.id, "legacy-card");
  assert.equal(restored?.cards[0]?.turns[0]?.content, "旧问题");
  assert.equal(await db.noteLibraries.count(), 0);
  assert.equal(await db.noteDocuments.count(), 0);
  assert.equal(await db.noteChunks.count(), 0);
  assert.equal(await db.projectNoteLibraries.count(), 0);
  assert.equal(await db.agentRuns.count(), 0);
  assert.equal(await db.agentEvents.count(), 0);
  assert.equal((await loadAgentAudit("legacy-turn"))?.kind, "legacy");
  assert.deepEqual(restored?.settings.providerCapabilities, []);
  assert.equal(
    restored?.settings.providerCapabilityTtlMs,
    24 * 60 * 60 * 1_000,
  );
});

test("workspace snapshots preserve the independent note corpus and clear-all removes it", async () => {
  await freshDb();
  await saveWorkspace(snapshot());
  await db.noteLibraries.put({
    id: "library-a",
    name: "只读资料",
    kind: "web-import",
    createdAt: 1,
    updatedAt: 1,
  });
  await db.noteDocuments.put({
    id: "document-a",
    libraryId: "library-a",
    relativePath: "资料/唯一事实.md",
    title: "唯一事实",
    tags: [],
    versionHash: "hash-a",
    charCount: 12,
    updatedAt: 1,
    content: "唯一事实",
  });
  await db.noteChunks.put({
    id: "chunk-a",
    libraryId: "library-a",
    documentId: "document-a",
    documentVersionHash: "hash-a",
    relativePath: "资料/唯一事实.md",
    titlePath: ["唯一事实"],
    tags: [],
    ordinal: 0,
    start: 0,
    end: 4,
    text: "唯一事实",
  });
  await db.projectNoteLibraries.put({
    projectId: "p",
    libraryId: "library-a",
  });

  // `saveWorkspace` intentionally lists only ordinary business tables.  A
  // full snapshot must never erase append-only events *or* read-only corpus.
  await saveWorkspace({
    ...snapshot(),
    projects: [{ ...snapshot().projects[0], name: "改名" }],
  });
  assert.equal(await db.noteLibraries.count(), 1);
  assert.equal(await db.noteDocuments.count(), 1);
  assert.equal(await db.noteChunks.count(), 1);
  assert.equal(await db.projectNoteLibraries.count(), 1);

  await clearWorkspace();
  assert.equal(await db.noteLibraries.count(), 0);
  assert.equal(await db.noteDocuments.count(), 0);
  assert.equal(await db.noteChunks.count(), 0);
  assert.equal(await db.projectNoteLibraries.count(), 0);
});

test("v6 attention tables survive ordinary workspace snapshots and clear with local data", async () => {
  await freshDb();
  await saveWorkspace(snapshot());
  await putAttentionState({
    events: [
      {
        id: "event-1",
        projectId: "p",
        sessionId: "session-1",
        type: "title-edited",
        createdAt: 10,
        targetCardId: "c",
      },
    ],
    sessions: [
      {
        id: "session-1",
        projectId: "p",
        localDate: "2026-07-26",
        startedAt: 1,
        lastActiveAt: 10,
      },
    ],
    proposals: [
      {
        id: "proposal-1",
        projectId: "p",
        sessionId: "session-1",
        title: "方向",
        explorationQuestion: "接下来先验证什么？",
        reason: "测试",
        sourceAnchorIds: [],
        suggestedParentCardId: "c",
        suggestedRelation: "child",
        evidence: "human-signals",
        status: "queued",
        candidateKey: "card:c",
        signalScore: 6,
        signalEventIds: ["event-1"],
        createdAt: 10,
        lastSignalAt: 10,
        expiresAt: 20,
        purgeAt: 30,
      },
    ],
  });
  // This exercises the whole-workspace reset path after the latest migration.
  await saveWorkspace(snapshot());
  const attention = await loadAttentionState();
  assert.equal(attention.events.length, 1);
  assert.equal(attention.sessions.length, 1);
  assert.equal(attention.proposals.length, 1);
  assert.equal(db.verno, 7);
  await clearWorkspace();
  const cleared = await loadAttentionState();
  assert.deepEqual(cleared, { events: [], sessions: [], proposals: [] });
});
