import type { Card, CardEdge } from "../types";

/**
 * The UI must never derive a project's graph from global cards or edges.
 * Keeping the selector pure makes that boundary testable before persistence arrives.
 */
export function scopeProject(
  cards: Card[],
  edges: CardEdge[],
  projectId: string,
) {
  const projectCards = cards.filter((card) => card.projectId === projectId);
  const cardIds = new Set(projectCards.map((card) => card.id));
  return {
    cards: projectCards,
    edges: edges.filter(
      (edge) =>
        cardIds.has(edge.sourceCardId) && cardIds.has(edge.targetCardId),
    ),
  };
}

export function preferredProjectCard(
  cards: Card[],
  projectId: string,
  preferredId?: string,
) {
  const candidates = cards.filter(
    (card) => card.projectId === projectId && !card.trashed,
  );
  return candidates.find((card) => card.id === preferredId) ?? candidates[0];
}
