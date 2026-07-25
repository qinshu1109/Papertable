import Dexie, { type Table } from "dexie";
import type {
  AppSettings,
  Card,
  CardEdge,
  ContextSnapshot,
  Project,
  ReferenceChip,
  SourceAnchor,
  Turn,
  ViewState,
} from "../types";

type CardRecord = Omit<Card, "turns">;

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

class PapertableDb extends Dexie {
  projects!: Table<Project, string>;
  cards!: Table<CardRecord, string>;
  turns!: Table<Turn & { cardId: string }, string>;
  edges!: Table<CardEdge, string>;
  anchors!: Table<SourceAnchor & { id: string }, string>;
  snapshots!: Table<ContextSnapshot, string>;
  references!: Table<ReferenceChip, string>;
  view!: Table<ViewState, string>;
  settings!: Table<AppSettings, string>;

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
  }
}

export const db = new PapertableDb();

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

export async function saveWorkspace(snapshot: WorkspaceSnapshot) {
  await db.transaction("rw", db.tables, async () => {
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
    await db.cards.bulkPut(
      snapshot.cards.map(({ turns, ...card }) => {
        void turns;
        return card;
      }),
    );
    await db.turns.bulkPut(
      snapshot.cards.flatMap((card) =>
        card.turns.map((turn) => ({ ...turn, cardId: card.id })),
      ),
    );
    await db.edges.bulkPut(snapshot.edges);
    await db.anchors.bulkPut(
      snapshot.anchors.filter(
        (anchor): anchor is SourceAnchor & { id: string } => Boolean(anchor.id),
      ),
    );
    await db.snapshots.bulkPut(snapshot.snapshots);
    await db.references.bulkPut(snapshot.references);
    await db.view.put(snapshot.view);
    await db.settings.put(snapshot.settings);
  });
}

export async function clearWorkspace() {
  await db.transaction("rw", db.tables, async () => {
    await Promise.all(db.tables.map((table) => table.clear()));
  });
}
