/**
 * 增量计算：与存储后端无关的纯逻辑。
 *
 * 普通自动保存不重写整个工作区。变化通过「与上次落库的快照做引用比较」得出：
 * store.tsx 的更新一律走 `current.map(x => x.id === id ? {...x} : x)`，未改动的
 * 对象保持引用不变，因此一次流式 token 追加只会换掉一张卡片和一条轮次的引用。
 *
 * 之所以用引用比较而不是在每个 mutation 点手工打脏标记：漏标一处会静默丢数据，
 * 而引用比较最坏只是多写几行，失败方向是安全的。
 *
 * ---------------------------------------------------------------------------
 * 删除规则（本模块存在的理由）
 *
 * **一行只能通过 (1) 指名具体 id 的显式意图，或 (2) 在写事务内针对数据库求值的
 * 谓词来删除；永不通过与内存基线做集合差。**
 *
 * 之前 `diffRows` 把「上次基线里有、这次内存里没有」当作删除。而基线是每个标签页
 * 私有的、挂载后再不与库对账的快照，于是一个陈旧的标签页会把另一个标签页刚建的
 * 行真正 `bulkDelete` 掉——不是覆盖，是删除。所以这里根本不产生 `deletes`：
 * 删除走 storage 的 `deleteProjectCascade` / `deleteReferences` / `deleteProposals`。
 *
 * 代价是残留一个「复活已删行」的窗口（另一个标签页删了，本标签页的基线还留着它，
 * 于是又写回去）。那是可见的、非破坏性的，比永久删除好得多。
 */
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

export type CardRecord = Omit<Card, "turns">;
export type TurnRecord = Turn & { cardId: string };
export type AnchorRecord = SourceAnchor & { id: string };

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

/**
 * 单张表要写入的整行。**刻意没有 `deletes` 字段**——留着这个名字就是在邀请后人
 * 把推导式删除填回去。
 */
export interface TableUpsert<T> {
  upserts: T[];
}

export interface WorkspaceUpsert {
  projects: TableUpsert<Project>;
  cards: TableUpsert<CardRecord>;
  turns: TableUpsert<TurnRecord>;
  edges: TableUpsert<CardEdge>;
  anchors: TableUpsert<AnchorRecord>;
  snapshots: TableUpsert<ContextSnapshot>;
  references: TableUpsert<ReferenceChip>;
  /** 单例行。未变化时为 null，避免每次保存都重写。 */
  view: ViewState | null;
  settings: AppSettings | null;
}

export interface AttentionUpsert {
  events: TableUpsert<InteractionEvent>;
  sessions: TableUpsert<SessionBoundary>;
  proposals: TableUpsert<Proposal>;
}

function diffRows<S, R>(
  prev: readonly S[] | null,
  next: readonly S[],
  keyOf: (row: S) => string,
  unchanged: (before: S, after: S) => boolean,
  toRecord: (row: S) => R,
): TableUpsert<R> {
  const previousById = new Map<string, S>();
  if (prev) for (const row of prev) previousById.set(keyOf(row), row);
  const upserts: R[] = [];
  for (const row of next) {
    const before = previousById.get(keyOf(row));
    if (before === undefined || !unchanged(before, row))
      upserts.push(toRecord(row));
  }
  return { upserts };
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

export const stripTurns = ({ turns, ...record }: Card): CardRecord => {
  void turns;
  return record;
};

export const hasId = (anchor: SourceAnchor): anchor is AnchorRecord =>
  Boolean(anchor.id);

/** 轮次挂在卡片下面，按 turn.id 展平后比较，顺带跟踪改道造成的换卡。 */
function diffTurns(
  prev: readonly Card[] | null,
  next: readonly Card[],
): TableUpsert<TurnRecord> {
  const previousTurns = new Map<string, Turn>();
  const previousCardIds = new Map<string, string>();
  if (prev)
    for (const card of prev)
      for (const turn of card.turns) {
        previousTurns.set(turn.id, turn);
        previousCardIds.set(turn.id, card.id);
      }
  const upserts: TurnRecord[] = [];
  for (const card of next)
    for (const turn of card.turns)
      if (
        !Object.is(previousTurns.get(turn.id), turn) ||
        previousCardIds.get(turn.id) !== card.id
      )
        upserts.push({ ...turn, cardId: card.id });
  return { upserts };
}

/**
 * 与上次落库的快照比较，得出这次真正需要写的行。`prev` 为 null 时（首次保存）
 * 全部按新增处理。任何情况下都不产生删除。
 */
export function diffWorkspace(
  prev: WorkspaceSnapshot | null,
  next: WorkspaceSnapshot,
): WorkspaceUpsert {
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

export function diffAttention(
  prev: AttentionSnapshot | null,
  next: AttentionSnapshot,
): AttentionUpsert {
  return {
    events: diffRows(
      prev?.events ?? null,
      next.events,
      byId,
      Object.is,
      identity,
    ),
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

const emptyTable = (table: TableUpsert<unknown>): boolean =>
  table.upserts.length === 0;

export function isEmptyWorkspaceUpsert(upsert: WorkspaceUpsert): boolean {
  return (
    upsert.view === null &&
    upsert.settings === null &&
    emptyTable(upsert.projects) &&
    emptyTable(upsert.cards) &&
    emptyTable(upsert.turns) &&
    emptyTable(upsert.edges) &&
    emptyTable(upsert.anchors) &&
    emptyTable(upsert.snapshots) &&
    emptyTable(upsert.references)
  );
}

export function isEmptyAttentionUpsert(upsert: AttentionUpsert): boolean {
  return (
    emptyTable(upsert.events) &&
    emptyTable(upsert.sessions) &&
    emptyTable(upsert.proposals)
  );
}

/** 把一个工作区快照整体当作 upsert，用于撤销这类「按 id 精确还原」的场景。 */
export function snapshotAsUpsert(snapshot: WorkspaceSnapshot): WorkspaceUpsert {
  return diffWorkspace(null, snapshot);
}

export function attentionAsUpsert(
  snapshot: AttentionSnapshot,
): AttentionUpsert {
  return diffAttention(null, snapshot);
}
