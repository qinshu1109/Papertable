import type {
  AgentRunTrace,
  NoteCitation,
  ProviderMessage,
  Turn,
} from "../types";
import {
  addAgentBudget,
  assertAgentBudgetInvariants,
  type AgentBudgetLedger,
} from "./agentBudget";
import {
  type AgentAudit,
  type AgentAuditSource,
  type AgentBudgetDelta,
  type AgentEventRecord,
  type AgentWorkingSet,
} from "./agentEvents";
import {
  appendAgentBudgetContinuation,
  appendAgentInterruptedContinuationClaim,
  appendAgentInterruptedCheckpoint,
  type AgentAuditPersistence,
} from "./agentBudgetAudit";
import type { NoteChunk } from "./notes/types";

export const DEFAULT_CONTINUATION_BUDGET: Readonly<Required<AgentBudgetDelta>> =
  Object.freeze({
    rounds: 4,
    calls: 8,
    wallMs: 120_000,
    tokens: 32_000,
  });

const BOUNDED_RESUME_REASONS = new Set([
  "rounds_exhausted",
  "calls_exhausted",
  "wall_exhausted",
  "tokens_exhausted",
]);

const normalizedSearch = (query: string) =>
  query.trim().replace(/\s+/g, " ").toLocaleLowerCase();

const safeRelativePath = (path: string): string => {
  const normalized = path.replace(/\\/g, "/").replace(/^\.\/+/, "");
  return normalized.startsWith("/") ||
    /^[a-z]:\//i.test(normalized) ||
    normalized.split("/").includes("..")
    ? "[隐藏的非相对路径]"
    : normalized;
};

const eventMessages = (audit: Extract<AgentAudit, { kind: "event-sourced" }>) =>
  audit.events.map((event) => event.message);

function latestTerminalEvent(
  audit: Extract<AgentAudit, { kind: "event-sourced" }>,
): Extract<AgentEventRecord["message"], { kind: "terminal" }> | undefined {
  return [...audit.events]
    .reverse()
    .find((event) => event.message.kind === "terminal")?.message as
    Extract<AgentEventRecord["message"], { kind: "terminal" }> | undefined;
}

function latestAddedBudget(
  audit: Extract<AgentAudit, { kind: "event-sourced" }>,
): AgentBudgetDelta | undefined {
  const message = [...eventMessages(audit)]
    .reverse()
    .find(
      (
        candidate,
      ): candidate is Extract<
        AgentEventRecord["message"],
        { kind: "budget-added" }
      > => candidate.kind === "budget-added" && Boolean(candidate.added),
    );
  return message?.added ? { ...message.added } : undefined;
}

export function buildAgentWorkingSet(
  audit: Extract<AgentAudit, { kind: "event-sourced" }>,
): AgentWorkingSet {
  const messages = eventMessages(audit);
  const objective =
    messages.find((message) => message.kind === "exploration-started")
      ?.objective ?? audit.run.checkpoint.objective;
  const executedSearches: AgentWorkingSet["executedSearches"] = [];
  const seenSearches = new Set<string>();
  for (const event of audit.events) {
    if (event.message.kind !== "search-completed") continue;
    const key = normalizedSearch(event.message.query);
    if (seenSearches.has(key)) continue;
    seenSearches.add(key);
    executedSearches.push({
      query: event.message.query,
      resultEventId: event.id,
    });
  }
  const readSources: AgentAuditSource[] = [];
  const seenSources = new Set<string>();
  for (const message of messages) {
    if (message.kind !== "read-completed") continue;
    for (const source of message.sources) {
      if (seenSources.has(source.chunkId)) continue;
      seenSources.add(source.chunkId);
      readSources.push({
        ...source,
        relativePath: safeRelativePath(source.relativePath),
      });
    }
  }
  const confirmedCitations: NoteCitation[] = [];
  const seenCitations = new Set<string>();
  for (const event of audit.events) {
    if (event.message.kind !== "terminal") continue;
    for (const citation of event.message.citations) {
      if (
        !seenSources.has(citation.chunkId) ||
        seenCitations.has(citation.chunkId)
      )
        continue;
      seenCitations.add(citation.chunkId);
      confirmedCitations.push({
        ...citation,
        relativePath: safeRelativePath(citation.relativePath),
      });
    }
  }
  const previousTerminal = latestTerminalEvent(audit);
  return {
    objective,
    executedSearches,
    readSources,
    confirmedCitations,
    unresolvedQuestions: [
      ...(previousTerminal?.unresolvedQuestions ??
        audit.run.checkpoint.unresolvedQuestions),
    ],
    ...(previousTerminal?.terminal.reason &&
    previousTerminal.terminal.reason !== "none"
      ? { previousStopReason: previousTerminal.terminal.reason }
      : audit.run.checkpoint.stopReason
        ? { previousStopReason: audit.run.checkpoint.stopReason }
        : {}),
    addedBudget: { ...(latestAddedBudget(audit) ?? {}) },
  };
}

/** ADR-006's seven categories, serialized without complete trajectory replay. */
export function convertAgentWorkingSetToLlm(
  workingSet: Readonly<AgentWorkingSet>,
): ProviderMessage[] {
  const searches = workingSet.executedSearches.length
    ? workingSet.executedSearches
        .map((search) => `- ${search.query}`)
        .join("\n")
    : "（无）";
  const reads = workingSet.readSources.length
    ? workingSet.readSources
        .map(
          (source) =>
            `[chunkId=${source.chunkId}]\n标题：${source.title}\n相对路径：${safeRelativePath(source.relativePath)}\n原文：\n${source.text}`,
        )
        .join("\n\n")
    : "（无）";
  const citations = workingSet.confirmedCitations.length
    ? workingSet.confirmedCitations
        .map(
          (citation) =>
            `- [${citation.chunkId}] ${citation.title} · ${safeRelativePath(citation.relativePath)}\n  已确认摘录：${citation.excerpt}`,
        )
        .join("\n")
    : "（无）";
  return [
    { role: "user", content: `用户目标\n${workingSet.objective}` },
    {
      role: "system",
      content: `已完成的去重搜索（仅轨迹，不具引用资格）\n${searches}`,
    },
    {
      role: "system",
      content: `实际读取的证据原文（唯一可引用证据）\n${reads}`,
    },
    { role: "system", content: `已确认引用\n${citations}` },
    {
      role: "system",
      content: `未解决问题\n${
        workingSet.unresolvedQuestions.length
          ? workingSet.unresolvedQuestions.map((item) => `- ${item}`).join("\n")
          : "（无）"
      }`,
    },
    {
      role: "system",
      content: `上次停止原因\n${workingSet.previousStopReason ?? "none"}`,
    },
    {
      role: "system",
      content: `本次新增预算\n${JSON.stringify(workingSet.addedBudget)}`,
    },
  ];
}

export function agentTraceFromAudit(
  audit: Extract<AgentAudit, { kind: "event-sourced" }>,
): AgentRunTrace {
  const start = audit.events.find(
    (event) => event.message.kind === "exploration-started",
  );
  // A continuation keeps the previous bounded terminal event in the append-only
  // history. It is historical once the run has re-entered a non-terminal phase
  // and must not make a crash-recovered turn look completed.
  const terminal =
    audit.run.phase === "terminal"
      ? latestTerminalEvent(audit)?.terminal
      : undefined;
  const budget = audit.run.checkpoint.budget
    ? structuredClone(audit.run.checkpoint.budget)
    : undefined;
  return {
    mode:
      start?.message.kind === "exploration-started"
        ? start.message.mode
        : "native-tools",
    startedAt: audit.run.startedAt,
    finishedAt: audit.run.finishedAt ?? audit.run.updatedAt,
    searchQueries: [...audit.run.checkpoint.executedSearches],
    hitCount: audit.events.reduce(
      (total, event) =>
        total +
        (event.message.kind === "search-completed"
          ? event.message.hitCount
          : 0),
      0,
    ),
    readChunkIds: [...audit.run.checkpoint.readChunkIds],
    ...(terminal ? { terminal } : {}),
    ...(budget ? { budget } : {}),
  };
}

export function auditSourcesToNoteChunks(
  sources: readonly AgentAuditSource[],
): NoteChunk[] {
  return sources.map((source, ordinal) => ({
    id: source.chunkId,
    libraryId: source.libraryId,
    documentId: source.documentId,
    documentVersionHash: source.documentHash,
    relativePath: safeRelativePath(source.relativePath),
    titlePath: source.title.split(" / ").filter(Boolean),
    tags: [],
    ordinal,
    start: 0,
    end: source.text.length,
    text: source.text,
  }));
}

export interface AgentResumeSeed {
  trace: AgentRunTrace;
  ledger: AgentBudgetLedger;
  messages: ProviderMessage[];
  readChunks: NoteChunk[];
  readableIds: string[];
  completedSearches: string[];
  completedReadChunkIds: string[];
  auditSequenceStart: number;
}

export async function claimAgentContinuation(input: {
  audit: AgentAudit;
  persistence: AgentAuditPersistence;
  projectId: string;
  addedBudget?: AgentBudgetDelta;
  occurredAt: number;
}): Promise<AgentResumeSeed> {
  if (input.audit.kind !== "event-sourced")
    throw new Error("旧版 Agent 摘要不能安全续跑。");
  const audit = input.audit;
  const scope = audit.run.checkpoint.hostScope;
  if (!scope || scope.projectId !== input.projectId)
    throw new Error("续跑缺少原 run 的宿主冻结作用域。");
  const terminal = latestTerminalEvent(audit)?.terminal;
  const boundedPartial =
    audit.run.phase === "terminal" &&
    terminal?.result === "partial" &&
    BOUNDED_RESUME_REASONS.has(terminal.reason);
  const interrupted = audit.run.phase === "interrupted";
  if (!boundedPartial && !interrupted)
    throw new Error("这个 Agent run 不是可追加预算的续跑状态。");
  if (!audit.run.checkpoint.budget)
    throw new Error("续跑缺少 TASK-005 预算账本。");

  const alreadyAdded = interrupted ? latestAddedBudget(audit) : undefined;
  const added = alreadyAdded ?? {
    ...(input.addedBudget ?? DEFAULT_CONTINUATION_BUDGET),
  };
  if (
    !alreadyAdded &&
    !Object.values(added).some(
      (value) => typeof value === "number" && value > 0,
    )
  )
    throw new Error("续跑必须新增至少一个预算维度。");
  const ledger = alreadyAdded
    ? structuredClone(audit.run.checkpoint.budget)
    : addAgentBudget(structuredClone(audit.run.checkpoint.budget), added);
  assertAgentBudgetInvariants(ledger);
  const trace = agentTraceFromAudit(audit);
  delete trace.terminal;
  trace.budget = ledger;
  const persistence: AgentAuditPersistence = {
    ...input.persistence,
    hostScope: {
      projectId: scope.projectId,
      libraryIds: [...scope.libraryIds],
    },
    eventIdSuffix: `resume-${audit.run.lastSequence}`,
    objective: audit.run.checkpoint.objective,
  };
  if (alreadyAdded) {
    await appendAgentInterruptedContinuationClaim(
      persistence,
      trace,
      ledger,
      added,
      audit.run.lastSequence,
      input.occurredAt,
    );
  } else {
    await appendAgentBudgetContinuation(
      persistence,
      trace,
      ledger,
      added,
      audit.run.lastSequence,
      input.occurredAt,
    );
  }
  const workingSet = {
    ...buildAgentWorkingSet(audit),
    addedBudget: added,
  };
  const readableIds = new Set<string>();
  for (const event of audit.events)
    if (event.message.kind === "search-completed")
      event.message.hitChunkIds.forEach((id) => readableIds.add(id));
  return {
    trace,
    ledger,
    messages: convertAgentWorkingSetToLlm(workingSet),
    readChunks: auditSourcesToNoteChunks(workingSet.readSources),
    readableIds: [...readableIds],
    completedSearches: workingSet.executedSearches.map((item) =>
      normalizedSearch(item.query),
    ),
    completedReadChunkIds: workingSet.readSources.map(
      (source) => source.chunkId,
    ),
    auditSequenceStart: audit.run.lastSequence + 1,
  };
}

export async function settleInterruptedAgentAudit(input: {
  audit: AgentAudit;
  persistence: AgentAuditPersistence;
  occurredAt: number;
}): Promise<boolean> {
  if (
    input.audit.kind !== "event-sourced" ||
    input.audit.run.phase === "terminal" ||
    input.audit.run.phase === "interrupted" ||
    !input.audit.run.checkpoint.budget
  )
    return false;
  const trace = agentTraceFromAudit(input.audit);
  delete trace.terminal;
  await appendAgentInterruptedCheckpoint(
    {
      ...input.persistence,
      hostScope: input.audit.run.checkpoint.hostScope,
      eventIdSuffix: `recovery-${input.audit.run.lastSequence}`,
    },
    trace,
    structuredClone(input.audit.run.checkpoint.budget),
    input.audit.run.lastSequence,
    Math.max(input.occurredAt, input.audit.run.updatedAt),
    latestAddedBudget(input.audit) ?? input.audit.run.checkpoint.addedBudget,
  );
  return true;
}

/** Reconcile a persisted streaming turn with the authoritative run checkpoint. */
export function recoverTurnFromAgentAudit(
  turn: Turn,
  audit: AgentAudit | null,
): Turn {
  if (audit?.kind !== "event-sourced") return turn;
  const trace = agentTraceFromAudit(audit);
  if (audit.run.phase !== "terminal")
    return {
      ...turn,
      streaming: false,
      status: "interrupted",
      agentPhase: undefined,
      agentRun: trace,
    };
  const terminal = latestTerminalEvent(audit);
  if (!terminal)
    return {
      ...turn,
      streaming: false,
      status: "interrupted",
      agentPhase: undefined,
      agentRun: trace,
    };
  const failed = terminal.terminal.result === "failed";
  return {
    ...turn,
    content: terminal.answer ?? turn.content,
    streaming: false,
    status: failed ? "error" : "complete",
    ...(failed ? { error: "Agent run 在中断前已进入失败终态。" } : {}),
    agentPhase: undefined,
    agentRun: trace,
    citations: terminal.citations,
  };
}

export const normalizeCompletedSearchForResume = normalizedSearch;
