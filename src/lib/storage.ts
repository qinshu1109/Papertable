import Dexie, { type Table } from "dexie";
import type {
  AppSettings,
  Card,
  CardEdge,
  ContextSnapshot,
  InteractionEvent,
  Proposal,
  Project,
  ReferenceChip,
  SessionBoundary,
  SourceAnchor,
  Turn,
  ViewState,
} from "../types";

type CardRecord = Omit<Card, "turns">;
type TurnRecord = Turn & { cardId: string };
type AnchorRecord = SourceAnchor & { id: string };

export interface WorkspaceSnapshot {
  projects: Project[];
  cards: Card[];
  edges: CardEdge[];
  anchors: SourceAnchor[];
  snapshots: ContextSnapshot[];
  references: ReferenceChip[];
  view: ViewState;
  settings: AppSettings;
}

/** 注意力实验独立存储，避免普通工作区快照擦掉 append-only 行为事件。 */
export interface AttentionSnapshot {
  events: InteractionEvent[];
  sessions: SessionBoundary[];
  proposals: Proposal[];
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
  }
}

export const db = new PapertableDb();

/**
 * 所有落库写入排成一条链。IndexedDB 自己会串行化同一批表的事务，这里额外保证的
 * 是调用方观察到的完成顺序，从而让 store 的「写成功后才推进基线」是安全的。
 */
let writeQueue: Promise<unknown> = Promise.resolve();

function enqueue<T>(op: () => Promise<T>): Promise<T> {
  const run = writeQueue.then(op, op);
  writeQueue = run.catch(() => undefined);
  return run;
}

export async function loadWorkspace(): Promise<WorkspaceSnapshot | null> {
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

// ---------------------------------------------------------------------------
// 增量写入
//
// 普通自动保存不再重写整个工作区。变化通过「与上次落库的快照做引用比较」得出：
// store.tsx 的更新一律走 `current.map(x => x.id === id ? {...x} : x)`，未改动的
// 对象保持引用不变，因此一次流式 token 追加只会换掉一张卡片和一条轮次的引用。
//
// 之所以用引用比较而不是在每个 mutation 点手工打脏标记：漏标一处会静默丢数据，
// 而引用比较最坏只是多写几行，失败方向是安全的。
// ---------------------------------------------------------------------------

/** 单张表的增量：要写入的整行，以及要删除的主键。 */
export interface TableDelta<T> {
  upserts: T[];
  deletes: string[];
}

export interface WorkspaceDelta {
  projects: TableDelta<Project>;
  cards: TableDelta<CardRecord>;
  turns: TableDelta<TurnRecord>;
  edges: TableDelta<CardEdge>;
  anchors: TableDelta<AnchorRecord>;
  snapshots: TableDelta<ContextSnapshot>;
  references: TableDelta<ReferenceChip>;
  /** 单例行。未变化时为 null，避免每次保存都重写。 */
  view: ViewState | null;
  settings: AppSettings | null;
}

export interface AttentionDelta {
  events: TableDelta<InteractionEvent>;
  sessions: TableDelta<SessionBoundary>;
  proposals: TableDelta<Proposal>;
}

function diffRows<S, R>(
  prev: readonly S[] | null,
  next: readonly S[],
  keyOf: (row: S) => string,
  unchanged: (before: S, after: S) => boolean,
  toRecord: (row: S) => R,
): TableDelta<R> {
  const previousById = new Map<string, S>();
  if (prev) for (const row of prev) previousById.set(keyOf(row), row);
  const upserts: R[] = [];
  const liveIds = new Set<string>();
  for (const row of next) {
    const id = keyOf(row);
    liveIds.add(id);
    const before = previousById.get(id);
    if (before === undefined || !unchanged(before, row))
      upserts.push(toRecord(row));
  }
  const deletes: string[] = [];
  for (const id of previousById.keys()) if (!liveIds.has(id)) deletes.push(id);
  return { upserts, deletes };
}

const identity = <T>(row: T): T => row;
const byId = (row: { id: string }): string => row.id;

/**
 * 卡片行不含 turns。只有 turns 变化时（流式生成的常态）不重写卡片行，否则每
 * 500 ms 一次的流式保存仍会连带把卡片写一遍。
 */
function sameCardRecord(before: Card, after: Card): boolean {
  if (Object.is(before, after)) return true;
  const beforeKeys = Object.keys(before).filter((key) => key !== "turns");
  const afterKeys = Object.keys(after).filter((key) => key !== "turns");
  if (beforeKeys.length !== afterKeys.length) return false;
  return beforeKeys.every((key) =>
    Object.is(before[key as keyof Card], after[key as keyof Card]),
  );
}

const stripTurns = ({ turns, ...record }: Card): CardRecord => {
  void turns;
  return record;
};

const hasId = (anchor: SourceAnchor): anchor is AnchorRecord =>
  Boolean(anchor.id);

/** 轮次挂在卡片下面，按 turn.id 展平后比较，顺带跟踪改道造成的换卡。 */
function diffTurns(
  prev: readonly Card[] | null,
  next: readonly Card[],
): TableDelta<TurnRecord> {
  const previousTurns = new Map<string, Turn>();
  const previousCardIds = new Map<string, string>();
  if (prev)
    for (const card of prev)
      for (const turn of card.turns) {
        previousTurns.set(turn.id, turn);
        previousCardIds.set(turn.id, card.id);
      }
  const upserts: TurnRecord[] = [];
  const liveIds = new Set<string>();
  for (const card of next)
    for (const turn of card.turns) {
      liveIds.add(turn.id);
      if (
        !Object.is(previousTurns.get(turn.id), turn) ||
        previousCardIds.get(turn.id) !== card.id
      )
        upserts.push({ ...turn, cardId: card.id });
    }
  const deletes: string[] = [];
  for (const id of previousTurns.keys()) if (!liveIds.has(id)) deletes.push(id);
  return { upserts, deletes };
}

/**
 * 与上次落库的快照比较，得出这次真正需要写的行。`prev` 为 null 时（首次保存）
 * 全部按新增处理，不产生删除。
 */
export function diffWorkspace(
  prev: WorkspaceSnapshot | null,
  next: WorkspaceSnapshot,
): WorkspaceDelta {
  return {
    projects: diffRows(
      prev?.projects ?? null,
      next.projects,
      byId,
      Object.is,
      identity,
    ),
    cards: diffRows(
      prev?.cards ?? null,
      next.cards,
      byId,
      sameCardRecord,
      stripTurns,
    ),
    turns: diffTurns(prev?.cards ?? null, next.cards),
    edges: diffRows(prev?.edges ?? null, next.edges, byId, Object.is, identity),
    anchors: diffRows(
      prev?.anchors.filter(hasId) ?? null,
      next.anchors.filter(hasId),
      byId,
      Object.is,
      identity,
    ),
    snapshots: diffRows(
      prev?.snapshots ?? null,
      next.snapshots,
      byId,
      Object.is,
      identity,
    ),
    references: diffRows(
      prev?.references ?? null,
      next.references,
      byId,
      Object.is,
      identity,
    ),
    view: Object.is(prev?.view, next.view) ? null : next.view,
    settings: Object.is(prev?.settings, next.settings) ? null : next.settings,
  };
}

/**
 * 行为事件是 append-only，这里只算新增不算删除。移除只发生在项目删除
 * (`deleteAttentionForProject`) 和「清除本地数据」。
 */
export function diffAttention(
  prev: AttentionSnapshot | null,
  next: AttentionSnapshot,
): AttentionDelta {
  const events = diffRows(
    prev?.events ?? null,
    next.events,
    byId,
    Object.is,
    identity,
  );
  return {
    events: { upserts: events.upserts, deletes: [] },
    sessions: diffRows(
      prev?.sessions ?? null,
      next.sessions,
      byId,
      Object.is,
      identity,
    ),
    proposals: diffRows(
      prev?.proposals ?? null,
      next.proposals,
      byId,
      Object.is,
      identity,
    ),
  };
}

const emptyTable = (delta: TableDelta<unknown>): boolean =>
  delta.upserts.length === 0 && delta.deletes.length === 0;

export function isEmptyWorkspaceDelta(delta: WorkspaceDelta): boolean {
  return (
    delta.view === null &&
    delta.settings === null &&
    emptyTable(delta.projects) &&
    emptyTable(delta.cards) &&
    emptyTable(delta.turns) &&
    emptyTable(delta.edges) &&
    emptyTable(delta.anchors) &&
    emptyTable(delta.snapshots) &&
    emptyTable(delta.references)
  );
}

export function isEmptyAttentionDelta(delta: AttentionDelta): boolean {
  return (
    emptyTable(delta.events) &&
    emptyTable(delta.sessions) &&
    emptyTable(delta.proposals)
  );
}

async function writeTable<T>(
  table: Table<T, string>,
  delta: TableDelta<T>,
): Promise<void> {
  if (delta.deletes.length) await table.bulkDelete(delta.deletes);
  if (delta.upserts.length) await table.bulkPut(delta.upserts);
}

/**
 * 普通自动保存的写入口。只触碰 delta 里出现的行，绝不整表重写，因此一次流式
 * 保存的代价与项目里已有多少卡片无关。空 delta 不开事务。
 */
export async function applyChanges(delta: WorkspaceDelta): Promise<void> {
  if (isEmptyWorkspaceDelta(delta)) return;
  await enqueue(() =>
    db.transaction(
      "rw",
      [
        db.projects,
        db.cards,
        db.turns,
        db.edges,
        db.anchors,
        db.snapshots,
        db.references,
        db.view,
        db.settings,
      ],
      async () => {
        // 先删后写：卡片被删除时它的轮次已经出现在 turns.deletes 里。
        await writeTable(db.turns, delta.turns);
        await writeTable(db.cards, delta.cards);
        await writeTable(db.projects, delta.projects);
        await writeTable(db.edges, delta.edges);
        await writeTable(db.anchors, delta.anchors);
        await writeTable(db.snapshots, delta.snapshots);
        await writeTable(db.references, delta.references);
        if (delta.view) await db.view.put(delta.view);
        if (delta.settings) await db.settings.put(delta.settings);
      },
    ),
  );
}

/** 注意力实验状态的增量写入口，语义与 `applyChanges()` 一致。 */
export async function applyAttentionChanges(
  delta: AttentionDelta,
): Promise<void> {
  if (isEmptyAttentionDelta(delta)) return;
  await enqueue(() =>
    db.transaction(
      "rw",
      [db.interactionEvents, db.sessionBoundaries, db.proposals],
      async () => {
        await writeTable(db.interactionEvents, delta.events);
        await writeTable(db.sessionBoundaries, delta.sessions);
        await writeTable(db.proposals, delta.proposals);
      },
    ),
  );
}

/**
 * 整体替换工作区。只用于播种、导入后重置和「清除本地数据」这类明确的全量场景；
 * 日常保存走 `applyChanges()`。
 */
export async function saveWorkspace(snapshot: WorkspaceSnapshot) {
  // Deliberately list the legacy business tables. `interactionEvents` is
  // append-only and must never be cleared by ordinary auto-save snapshots.
  await enqueue(() =>
    db.transaction(
      "rw",
      [
        db.projects,
        db.cards,
        db.turns,
        db.edges,
        db.anchors,
        db.snapshots,
        db.references,
        db.view,
        db.settings,
      ],
      async () => {
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
      },
    ),
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
 * Events are never cleared by normal saves. Session and proposal tables are
 * compact state machines, so their current state can be atomically replaced.
 * 只用于全量场景；日常保存走 `applyAttentionChanges()`。
 */
export async function saveAttentionState(snapshot: AttentionSnapshot) {
  await enqueue(() =>
    db.transaction(
      "rw",
      [db.interactionEvents, db.sessionBoundaries, db.proposals],
      async () => {
        await db.interactionEvents.bulkPut(snapshot.events);
        await db.sessionBoundaries.clear();
        await db.proposals.clear();
        await db.sessionBoundaries.bulkPut(snapshot.sessions);
        await db.proposals.bulkPut(snapshot.proposals);
      },
    ),
  );
}

/** 项目被删除时，实验原始事件也必须随项目一起移除。 */
export async function deleteAttentionForProject(projectId: string) {
  await enqueue(() =>
    db.transaction(
      "rw",
      [db.interactionEvents, db.sessionBoundaries, db.proposals],
      async () => {
        const [eventIds, sessionIds, proposalIds] = await Promise.all([
          db.interactionEvents
            .where("projectId")
            .equals(projectId)
            .primaryKeys(),
          db.sessionBoundaries
            .where("projectId")
            .equals(projectId)
            .primaryKeys(),
          db.proposals.where("projectId").equals(projectId).primaryKeys(),
        ]);
        await Promise.all([
          db.interactionEvents.bulkDelete(eventIds as string[]),
          db.sessionBoundaries.bulkDelete(sessionIds as string[]),
          db.proposals.bulkDelete(proposalIds as string[]),
        ]);
      },
    ),
  );
}

export async function clearWorkspace() {
  await enqueue(() =>
    db.transaction("rw", db.tables, async () => {
      await Promise.all(db.tables.map((table) => table.clear()));
    }),
  );
}
