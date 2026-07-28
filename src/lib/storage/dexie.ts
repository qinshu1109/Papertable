import Dexie, { type Table } from "dexie";
import type {
  AppSettings,
  CardEdge,
  ContextSnapshot,
  InteractionEvent,
  Proposal,
  Project,
  ReferenceChip,
  SessionBoundary,
  Turn,
  ViewState,
} from "../../types";
import type { NoteChunk, NoteDocument, NoteLibrary } from "../notes/types";
import {
  type AnchorRecord,
  type AttentionSnapshot,
  type AttentionUpsert,
  type CardRecord,
  type TableUpsert,
  type TurnRecord,
  type WorkspaceSnapshot,
  type WorkspaceUpsert,
  hasId,
  isEmptyAttentionUpsert,
  isEmptyWorkspaceUpsert,
  stripTurns,
} from "../delta";
import type { StorageAdapter } from "./types";
import {
  AGENT_EVENT_SCHEMA_VERSION,
  AGENT_EVENT_TYPES,
  type AgentAudit,
  type AgentEventRecord,
  type AgentRunPhase,
  type AgentRunRecord,
  type AppendAgentStepInput,
} from "../agentEvents";

export type {
  AnchorRecord,
  AttentionSnapshot,
  AttentionUpsert,
  CardRecord,
  TurnRecord,
  WorkspaceSnapshot,
  WorkspaceUpsert,
};

export interface NoteDocumentRecord extends NoteDocument {
  /** Web imports retain a source copy solely to allow explicit rebuilds. */
  content: string;
}

export interface ProjectNoteLibraryRecord {
  projectId: string;
  libraryId: string;
}

class PapertableDb extends Dexie {
  projects!: Table<Project, string>;
  cards!: Table<CardRecord, string>;
  turns!: Table<TurnRecord, string>;
  edges!: Table<CardEdge, string>;
  anchors!: Table<AnchorRecord, string>;
  snapshots!: Table<ContextSnapshot, string>;
  references!: Table<ReferenceChip, string>;
  view!: Table<ViewState, string>;
  settings!: Table<AppSettings, string>;
  interactionEvents!: Table<InteractionEvent, string>;
  sessionBoundaries!: Table<SessionBoundary, string>;
  proposals!: Table<Proposal, string>;
  noteLibraries!: Table<NoteLibrary, string>;
  noteDocuments!: Table<NoteDocumentRecord, string>;
  noteChunks!: Table<NoteChunk, string>;
  projectNoteLibraries!: Table<ProjectNoteLibraryRecord, [string, string]>;
  agentRuns!: Table<AgentRunRecord, string>;
  agentEvents!: Table<AgentEventRecord, string>;

  constructor() {
    super("papertable-web-v1");
    const schema = {
      projects: "id, updatedAt, pinned",
      cards: "id, projectId, createdAt, trashed",
      turns: "id, cardId, createdAt",
      edges: "id, sourceCardId, targetCardId",
      anchors: "id, cardId, turnId",
      snapshots: "id, edgeId",
      references: "id, projectId",
      view: "id, activeProjectId, currentCardId",
      settings: "id",
    };
    this.version(1).stores(schema);
    // Keep a real migration entry from the first public web schema onward.
    // Existing v1 cards already remain valid because the cache field is optional.
    this.version(2)
      .stores(schema)
      .upgrade(() => undefined);
    // v3 introduces the append-only attention experiment tables. Existing
    // workspace tables stay untouched, so v2 users retain every card/turn.
    this.version(3)
      .stores({
        ...schema,
        interactionEvents:
          "id, projectId, sessionId, createdAt, type, targetCardId, sourceCardId",
        sessionBoundaries:
          "id, projectId, localDate, startedAt, lastActiveAt, endedAt, processedAt",
        proposals:
          "id, projectId, sessionId, status, createdAt, expiresAt, purgeAt, candidateKey",
      })
      .upgrade(() => undefined);
    // v4 removes the transient model-draft field introduced by a short-lived
    // build. It was never part of the product contract and must not survive
    // into user data, exports, or future model context.
    this.version(4)
      .stores({
        ...schema,
        interactionEvents:
          "id, projectId, sessionId, createdAt, type, targetCardId, sourceCardId",
        sessionBoundaries:
          "id, projectId, localDate, startedAt, lastActiveAt, endedAt, processedAt",
        proposals:
          "id, projectId, sessionId, status, createdAt, expiresAt, purgeAt, candidateKey",
      })
      .upgrade(async (tx) => {
        await tx
          .table("turns")
          .toCollection()
          .modify((record: { reasoning?: unknown }) => {
            delete record.reasoning;
          });
      });
    // v5 is intentionally a separate corpus namespace.  It is not part of
    // workspace snapshots or StorageAdapter because an imported source library
    // has different lifecycle and access rules from Card data.
    this.version(5)
      .stores({
        ...schema,
        interactionEvents:
          "id, projectId, sessionId, createdAt, type, targetCardId, sourceCardId",
        sessionBoundaries:
          "id, projectId, localDate, startedAt, lastActiveAt, endedAt, processedAt",
        proposals:
          "id, projectId, sessionId, status, createdAt, expiresAt, purgeAt, candidateKey",
        noteLibraries: "id, kind, updatedAt",
        noteDocuments: "id, libraryId, relativePath, versionHash, updatedAt",
        noteChunks: "id, libraryId, documentId, ordinal",
        projectNoteLibraries: "[projectId+libraryId], projectId, libraryId",
      })
      .upgrade(() => undefined);
    // v6 adds the versioned Agent audit log. Existing turns remain untouched;
    // the read API exposes them as legacy summaries and never backfills rows.
    this.version(6)
      .stores({
        ...schema,
        interactionEvents:
          "id, projectId, sessionId, createdAt, type, targetCardId, sourceCardId",
        sessionBoundaries:
          "id, projectId, localDate, startedAt, lastActiveAt, endedAt, processedAt",
        proposals:
          "id, projectId, sessionId, status, createdAt, expiresAt, purgeAt, candidateKey",
        noteLibraries: "id, kind, updatedAt",
        noteDocuments: "id, libraryId, relativePath, versionHash, updatedAt",
        noteChunks: "id, libraryId, documentId, ordinal",
        projectNoteLibraries: "[projectId+libraryId], projectId, libraryId",
        agentRuns: "id, &turnId, updatedAt, phase",
        agentEvents: "id, runId, &[runId+sequence], occurredAt, eventType",
      })
      .upgrade(() => undefined);
    // v7 replaces the legacy boolean/two-stage capability cache with the
    // schema-v1 three-stage admission record. Old rows are not trustworthy
    // enough to upgrade, so they are invalidated and re-probed on demand.
    this.version(7)
      .stores({
        ...schema,
        interactionEvents:
          "id, projectId, sessionId, createdAt, type, targetCardId, sourceCardId",
        sessionBoundaries:
          "id, projectId, localDate, startedAt, lastActiveAt, endedAt, processedAt",
        proposals:
          "id, projectId, sessionId, status, createdAt, expiresAt, purgeAt, candidateKey",
        noteLibraries: "id, kind, updatedAt",
        noteDocuments: "id, libraryId, relativePath, versionHash, updatedAt",
        noteChunks: "id, libraryId, documentId, ordinal",
        projectNoteLibraries: "[projectId+libraryId], projectId, libraryId",
        agentRuns: "id, &turnId, updatedAt, phase",
        agentEvents: "id, runId, &[runId+sequence], occurredAt, eventType",
      })
      .upgrade(async (tx) => {
        const settings = (await tx.table("settings").get("app")) as
          AppSettings | undefined;
        if (!settings) return;
        await tx.table("settings").put({
          ...settings,
          providerCapabilities: [],
          providerCapabilityTtlMs: 24 * 60 * 60 * 1_000,
        });
      });
  }
}

/** @internal 仅供测试直接操作底层表；业务代码请走本模块导出的函数。 */
export const db = new PapertableDb();

/**
 * 所有落库写入排成一条链。IndexedDB 自己会串行化同一批表的事务，这里额外保证的
 * 是调用方观察到的完成顺序，从而让 store 的「写成功后才推进基线」是安全的。
 *
 * 注意这条链是 per-JS-realm 的：它不提供跨标签页的顺序保证。跨标签页的安全性来自
 * 「写入口不再具备删除能力」，而不是来自这里。
 */
let writeQueue: Promise<unknown> = Promise.resolve();

function enqueue<T>(op: () => Promise<T>): Promise<T> {
  const run = writeQueue.then(op, op);
  writeQueue = run.catch(() => undefined);
  return run;
}

const workspaceTables = () => [
  db.projects,
  db.cards,
  db.turns,
  db.edges,
  db.anchors,
  db.snapshots,
  db.references,
  db.view,
  db.settings,
];

const attentionTables = () => [
  db.interactionEvents,
  db.sessionBoundaries,
  db.proposals,
];

/**
 * 兼容来自旧版本、手工导回或被浏览器中断过的数据库。v4 迁移会完成正常清理；
 * 每次读取前再做一次幂等的定点清理，确保旧草稿绝不会重新进入内存状态。
 */
async function scrubLegacyReasoning(): Promise<void> {
  await enqueue(() =>
    db.turns
      .filter((record) => "reasoning" in (record as object))
      .modify((record) => {
        delete (record as TurnRecord & { reasoning?: unknown }).reasoning;
      }),
  );
}

export async function loadWorkspace(): Promise<WorkspaceSnapshot | null> {
  await scrubLegacyReasoning();
  const [
    projects,
    records,
    turnRecords,
    edges,
    anchors,
    snapshots,
    references,
    view,
    settings,
  ] = await Promise.all([
    db.projects.toArray(),
    db.cards.toArray(),
    db.turns.toArray(),
    db.edges.toArray(),
    db.anchors.toArray(),
    db.snapshots.toArray(),
    db.references.toArray(),
    db.view.get("main"),
    db.settings.get("app"),
  ]);
  if (!projects.length || !view || !settings) return null;
  const turnsByCard = new Map<string, Turn[]>();
  for (const { cardId, ...turn } of turnRecords) {
    const list = turnsByCard.get(cardId) ?? [];
    list.push(turn);
    turnsByCard.set(cardId, list);
  }
  const cards = records.map((record) => ({
    ...record,
    turns: (turnsByCard.get(record.id) ?? []).sort(
      (a, b) => a.createdAt - b.createdAt,
    ),
  }));
  return {
    projects,
    cards,
    edges,
    anchors,
    snapshots,
    references,
    view,
    settings,
  };
}

export async function loadAgentAudit(
  turnId: string,
): Promise<AgentAudit | null> {
  const run = await db.agentRuns.where("turnId").equals(turnId).first();
  if (run) {
    const events = await db.agentEvents
      .where("runId")
      .equals(run.id)
      .sortBy("sequence");
    return { kind: "event-sourced", run, events };
  }
  const turn = await db.turns.get(turnId);
  if (!turn) return null;
  return {
    kind: "legacy",
    turnId,
    trace: turn.agentRun ?? null,
  };
}

// ---------------------------------------------------------------------------
// 写入：只增不删
// ---------------------------------------------------------------------------

type AgentAppendFailurePoint =
  "after-run-ensured" | "after-event-inserted" | "after-run-state-changed";

const AGENT_RUN_PHASES: readonly AgentRunPhase[] = [
  "exploring",
  "searching",
  "reading",
  "repairing",
  "retrying",
  "synthesizing",
  "interrupted",
  "terminal",
];

const RESUMABLE_TERMINAL_REASONS = [
  "rounds_exhausted",
  "calls_exhausted",
  "wall_exhausted",
  "tokens_exhausted",
] as const;

function isLegalContinuationClaim(
  existing: AgentRunRecord,
  input: AppendAgentStepInput,
): boolean {
  const terminal = existing.checkpoint.terminal;
  return (
    input.event.message.kind === "budget-added" &&
    Boolean(input.event.message.added) &&
    input.checkpoint.phase === "exploring" &&
    input.expectedLastSequence === existing.lastSequence &&
    terminal?.result === "partial" &&
    RESUMABLE_TERMINAL_REASONS.includes(
      terminal.reason as (typeof RESUMABLE_TERMINAL_REASONS)[number],
    )
  );
}

function validateAgentStep(input: AppendAgentStepInput): void {
  if (
    input.schemaVersion !== AGENT_EVENT_SCHEMA_VERSION ||
    input.event.schemaVersion !== AGENT_EVENT_SCHEMA_VERSION
  )
    throw new Error("Unsupported Agent event schema version");
  if (
    !AGENT_EVENT_TYPES.includes(input.event.message.kind) ||
    !AGENT_RUN_PHASES.includes(input.checkpoint.phase)
  )
    throw new Error("Unknown Agent event type or run phase");
  if (
    input.updatedAt < input.startedAt ||
    input.event.occurredAt < input.startedAt
  )
    throw new Error("Agent step timestamp precedes run start");
  const terminal = input.event.message.kind === "terminal";
  if (
    terminal !== (input.checkpoint.phase === "terminal") ||
    terminal !== (input.finishedAt !== undefined)
  )
    throw new Error(
      "terminal event, terminal phase and finishedAt must occur together",
    );
}

async function appendAgentStepInternal(
  input: AppendAgentStepInput,
  failurePoint?: AgentAppendFailurePoint,
): Promise<AgentEventRecord> {
  validateAgentStep(input);
  return enqueue(() =>
    db.transaction("rw", db.turns, db.agentRuns, db.agentEvents, async () => {
      if (!(await db.turns.get(input.turnId)))
        throw new Error(`Agent run references missing turn: ${input.turnId}`);
      const existing = await db.agentRuns.get(input.runId);
      if (existing) {
        if (
          existing.turnId !== input.turnId ||
          existing.schemaVersion !== input.schemaVersion ||
          existing.startedAt !== input.startedAt
        )
          throw new Error("Agent run identity does not match existing row");
        if (
          input.expectedLastSequence !== undefined &&
          input.expectedLastSequence !== existing.lastSequence
        )
          throw new Error("Agent run cursor changed before continuation claim");
        if (
          existing.phase === "terminal" &&
          !isLegalContinuationClaim(existing, input)
        )
          throw new Error("Terminal Agent run cannot accept another event");
        if (input.updatedAt < existing.updatedAt)
          throw new Error("Agent run updatedAt cannot move backwards");
      } else {
        if (input.expectedLastSequence !== undefined)
          throw new Error("Agent continuation references a missing run");
        await db.agentRuns.add({
          id: input.runId,
          turnId: input.turnId,
          schemaVersion: input.schemaVersion,
          phase: input.checkpoint.phase,
          startedAt: input.startedAt,
          updatedAt: input.updatedAt,
          ...(input.finishedAt === undefined
            ? {}
            : { finishedAt: input.finishedAt }),
          lastSequence: 0,
          checkpoint: input.checkpoint,
        });
      }
      if (failurePoint === "after-run-ensured")
        throw new Error("injected crash after-run-ensured");

      const sequence = (existing?.lastSequence ?? 0) + 1;
      const event: AgentEventRecord = {
        id: input.event.id,
        runId: input.runId,
        sequence,
        schemaVersion: input.event.schemaVersion,
        eventType: input.event.message.kind,
        occurredAt: input.event.occurredAt,
        message: input.event.message,
      };
      await db.agentEvents.add(event);
      if (failurePoint === "after-event-inserted")
        throw new Error("injected crash after-event-inserted");

      await db.agentRuns.put({
        id: input.runId,
        turnId: input.turnId,
        schemaVersion: input.schemaVersion,
        phase: input.checkpoint.phase,
        startedAt: input.startedAt,
        updatedAt: input.updatedAt,
        ...(input.finishedAt === undefined
          ? {}
          : { finishedAt: input.finishedAt }),
        lastSequence: sequence,
        checkpoint: input.checkpoint,
      });
      if (failurePoint === "after-run-state-changed")
        throw new Error("injected crash after-run-state-changed");
      return event;
    }),
  );
}

export async function appendAgentStep(
  input: AppendAgentStepInput,
): Promise<AgentEventRecord> {
  return appendAgentStepInternal(input);
}

/** @internal deterministic transaction-abort seam for persistence tests. */
export async function appendAgentStepWithFailureForTest(
  input: AppendAgentStepInput,
  failurePoint: AgentAppendFailurePoint,
): Promise<AgentEventRecord> {
  return appendAgentStepInternal(input, failurePoint);
}

async function writeTable<T>(
  table: Table<T, string>,
  upsert: TableUpsert<T>,
): Promise<void> {
  if (upsert.upserts.length) await table.bulkPut(upsert.upserts);
}

/**
 * 普通自动保存的写入口。只触碰 upsert 里出现的行，绝不整表重写，也**绝不删除任何
 * 行**——删除必须走下面几个显式意图 API。
 */
export async function applyChanges(upsert: WorkspaceUpsert): Promise<void> {
  if (isEmptyWorkspaceUpsert(upsert)) return;
  await enqueue(() =>
    db.transaction("rw", workspaceTables(), async () => {
      await writeTable(db.projects, upsert.projects);
      await writeTable(db.cards, upsert.cards);
      await writeTable(db.turns, upsert.turns);
      await writeTable(db.edges, upsert.edges);
      await writeTable(db.anchors, upsert.anchors);
      await writeTable(db.snapshots, upsert.snapshots);
      await writeTable(db.references, upsert.references);
      if (upsert.view) await db.view.put(upsert.view);
      if (upsert.settings) await db.settings.put(upsert.settings);
    }),
  );
}

/** 注意力实验状态的增量写入口，语义与 `applyChanges()` 一致。 */
export async function applyAttentionChanges(
  upsert: AttentionUpsert,
): Promise<void> {
  if (isEmptyAttentionUpsert(upsert)) return;
  await enqueue(() =>
    db.transaction("rw", attentionTables(), async () => {
      await writeTable(db.interactionEvents, upsert.events);
      await writeTable(db.sessionBoundaries, upsert.sessions);
      await writeTable(db.proposals, upsert.proposals);
    }),
  );
}

// ---------------------------------------------------------------------------
// 删除：显式意图，或事务内针对数据库求值的谓词
// ---------------------------------------------------------------------------

/**
 * 删除项目是明确意图：在事务内**按 projectId 重新查库**定位所有从属行，不依赖任何
 * 内存基线，因此另一个标签页刚建的卡片也会被正确删除。
 *
 * 返回被删掉的行，供撤销精确还原——撤销要还原的是「删除前库里的内容」，不是本
 * 标签页记得的内容。
 */
export async function deleteProjectCascade(projectId: string): Promise<{
  workspace: WorkspaceUpsert;
  attention: AttentionUpsert;
}> {
  return enqueue(() =>
    db.transaction(
      "rw",
      [...workspaceTables(), ...attentionTables()],
      async () => {
        const projects = await db.projects
          .where("id")
          .equals(projectId)
          .toArray();
        const cards = await db.cards
          .where("projectId")
          .equals(projectId)
          .toArray();
        const cardIds = cards.map((card) => card.id);

        const [turns, anchors, outgoing, incoming, references] =
          await Promise.all([
            db.turns.where("cardId").anyOf(cardIds).toArray(),
            db.anchors.where("cardId").anyOf(cardIds).toArray(),
            db.edges.where("sourceCardId").anyOf(cardIds).toArray(),
            db.edges.where("targetCardId").anyOf(cardIds).toArray(),
            db.references.where("projectId").equals(projectId).toArray(),
          ]);
        const edges = [
          ...new Map([...outgoing, ...incoming].map((e) => [e.id, e])).values(),
        ];
        const snapshots = await db.snapshots
          .where("edgeId")
          .anyOf(edges.map((edge) => edge.id))
          .toArray();

        const [events, sessions, proposals] = await Promise.all([
          db.interactionEvents.where("projectId").equals(projectId).toArray(),
          db.sessionBoundaries.where("projectId").equals(projectId).toArray(),
          db.proposals.where("projectId").equals(projectId).toArray(),
        ]);

        await Promise.all([
          db.turns.bulkDelete(turns.map((row) => row.id)),
          db.anchors.bulkDelete(anchors.map((row) => row.id)),
          db.snapshots.bulkDelete(snapshots.map((row) => row.id)),
          db.edges.bulkDelete(edges.map((row) => row.id)),
          db.references.bulkDelete(references.map((row) => row.id)),
          db.cards.bulkDelete(cardIds),
          db.projects.bulkDelete(projects.map((row) => row.id)),
          db.interactionEvents.bulkDelete(events.map((row) => row.id)),
          db.sessionBoundaries.bulkDelete(sessions.map((row) => row.id)),
          db.proposals.bulkDelete(proposals.map((row) => row.id)),
        ]);

        return {
          workspace: {
            projects: { upserts: projects },
            cards: { upserts: cards },
            turns: { upserts: turns },
            edges: { upserts: edges },
            anchors: { upserts: anchors },
            snapshots: { upserts: snapshots },
            references: { upserts: references },
            view: null,
            settings: null,
          },
          attention: {
            events: { upserts: events },
            sessions: { upserts: sessions },
            proposals: { upserts: proposals },
          },
        };
      },
    ),
  );
}

/**
 * 普通交互里唯一的引用硬删除。调用点永远拿得到具体 id，绝不用谓词——否则会误删
 * 另一个标签页刚加的引用。
 */
export async function deleteReferences(ids: string[]): Promise<void> {
  if (!ids.length) return;
  await enqueue(() => db.references.bulkDelete(ids));
}

/** 提案生命周期淘汰。计算点就知道被替换/过期的 id。 */
export async function deleteProposals(ids: string[]): Promise<void> {
  if (!ids.length) return;
  await enqueue(() => db.proposals.bulkDelete(ids));
}

// ---------------------------------------------------------------------------
// 全量场景
// ---------------------------------------------------------------------------

/**
 * 播种：在事务内重新确认库是空的再写。两个标签页同时冷启时，只有一个会真正播种，
 * 另一个拿到库里已有的内容——否则它们会各自 clear 并写入一份不同的种子。
 */
export async function seedIfEmpty(
  seed: WorkspaceSnapshot,
): Promise<WorkspaceSnapshot> {
  const existing = await loadWorkspace();
  if (existing) return existing;
  await enqueue(() =>
    db.transaction("rw", workspaceTables(), async () => {
      if (await db.projects.count()) return;
      await db.projects.bulkPut(seed.projects);
      await db.cards.bulkPut(seed.cards.map(stripTurns));
      await db.turns.bulkPut(
        seed.cards.flatMap((card) =>
          card.turns.map((turn) => ({ ...turn, cardId: card.id })),
        ),
      );
      await db.edges.bulkPut(seed.edges);
      await db.anchors.bulkPut(seed.anchors.filter(hasId));
      await db.snapshots.bulkPut(seed.snapshots);
      await db.references.bulkPut(seed.references);
      await db.view.put(seed.view);
      await db.settings.put(seed.settings);
    }),
  );
  return (await loadWorkspace()) ?? seed;
}

/**
 * 整体替换工作区。只用于「清除本地数据」后的重置这类明确的全量场景；
 * 日常保存走 `applyChanges()`。
 */
export async function saveWorkspace(snapshot: WorkspaceSnapshot) {
  // Deliberately list the legacy business tables. `interactionEvents` is
  // append-only and must never be cleared by ordinary auto-save snapshots.
  await enqueue(() =>
    db.transaction("rw", workspaceTables(), async () => {
      await Promise.all([
        db.projects.clear(),
        db.cards.clear(),
        db.turns.clear(),
        db.edges.clear(),
        db.anchors.clear(),
        db.snapshots.clear(),
        db.references.clear(),
        db.view.clear(),
      ]);
      await db.projects.bulkPut(snapshot.projects);
      await db.cards.bulkPut(snapshot.cards.map(stripTurns));
      await db.turns.bulkPut(
        snapshot.cards.flatMap((card) =>
          card.turns.map((turn) => ({ ...turn, cardId: card.id })),
        ),
      );
      await db.edges.bulkPut(snapshot.edges);
      await db.anchors.bulkPut(snapshot.anchors.filter(hasId));
      await db.snapshots.bulkPut(snapshot.snapshots);
      await db.references.bulkPut(snapshot.references);
      await db.view.put(snapshot.view);
      await db.settings.put(snapshot.settings);
    }),
  );
}

export async function loadAttentionState(): Promise<AttentionSnapshot> {
  const [events, sessions, proposals] = await Promise.all([
    db.interactionEvents.orderBy("createdAt").toArray(),
    db.sessionBoundaries.orderBy("startedAt").toArray(),
    db.proposals.orderBy("createdAt").toArray(),
  ]);
  return { events, sessions, proposals };
}

/**
 * Upsert-only。会话与提案的移除走 `deleteProposals` / `deleteProjectCascade`。
 *
 * 这里曾经是 `clear()` 掉 sessionBoundaries 和 proposals 再用单个标签页的内存重写，
 * 而它挂在每次 `pagehide` 上——仅仅关闭第二个标签页就会销毁第一个标签页生成的
 * 全部会话与提案，无需任何竞态。
 */
export async function putAttentionState(snapshot: AttentionSnapshot) {
  await enqueue(() =>
    db.transaction("rw", attentionTables(), async () => {
      await db.interactionEvents.bulkPut(snapshot.events);
      await db.sessionBoundaries.bulkPut(snapshot.sessions);
      await db.proposals.bulkPut(snapshot.proposals);
    }),
  );
}

export async function clearWorkspace() {
  await enqueue(() =>
    db.transaction("rw", db.tables, async () => {
      await Promise.all(db.tables.map((table) => table.clear()));
    }),
  );
}

/** 整体替换本后端内容。Web 端主要用于「从桌面版导回」这类反向场景。 */
export async function importLibrary(input: {
  workspace: WorkspaceSnapshot;
  attention: AttentionSnapshot;
}): Promise<void> {
  await clearWorkspace();
  await saveWorkspace(input.workspace);
  await putAttentionState(input.attention);
}

/** 这个实现满足 `StorageAdapter`；类型检查在这里替我们盯着。 */
export const dexieStorage: StorageAdapter = {
  loadWorkspace,
  loadAttentionState,
  loadAgentAudit,
  appendAgentStep,
  seedIfEmpty,
  applyChanges,
  applyAttentionChanges,
  putAttentionState,
  saveWorkspace,
  deleteProjectCascade,
  deleteReferences,
  deleteProposals,
  clearWorkspace,
  importLibrary,
};
