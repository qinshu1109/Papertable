import type { Card, CardEdge, ContextSnapshot, SourceAnchor } from "../types";
import { hasId, stripTurns, type WorkspaceUpsert } from "./delta";

export function createdCardPersistenceUpsert(input: {
  card: Card;
  edge: CardEdge;
  snapshot: ContextSnapshot;
  anchor?: SourceAnchor;
}): WorkspaceUpsert {
  return {
    projects: { upserts: [] },
    cards: { upserts: [stripTurns(input.card)] },
    turns: {
      upserts: input.card.turns.map((turn) => ({
        ...turn,
        cardId: input.card.id,
      })),
    },
    edges: { upserts: [input.edge] },
    anchors: {
      upserts: input.anchor && hasId(input.anchor) ? [input.anchor] : [],
    },
    snapshots: { upserts: [input.snapshot] },
    references: { upserts: [] },
    view: null,
    settings: null,
  };
}

export async function persistCreatedCardBeforeGeneration(input: {
  upsert: WorkspaceUpsert;
  persist: (upsert: WorkspaceUpsert) => Promise<void>;
  startGeneration: () => void | Promise<void>;
}): Promise<void> {
  await input.persist(input.upsert);
  await input.startGeneration();
}
