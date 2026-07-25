import type { Card, CardEdge } from "../types";

export interface GraphNode {
  id: string;
  x: number;
  y: number;
  depth: number;
}

/** 找到指向某卡片的边（每张卡片最多一条来源边） */
export function incomingEdge(edges: CardEdge[], cardId: string) {
  return edges.find((e) => e.targetCardId === cardId);
}

export function outgoingEdges(edges: CardEdge[], cardId: string) {
  return edges.filter((e) => e.sourceCardId === cardId);
}

/** 从根到当前卡片的路径（含自身），首项为根 */
export function pathToRoot(edges: CardEdge[], cardId: string): string[] {
  const path: string[] = [cardId];
  const seen = new Set<string>([cardId]);
  let cursor = cardId;
  for (let i = 0; i < 64; i++) {
    const e = incomingEdge(edges, cursor);
    if (!e || seen.has(e.sourceCardId)) break;
    path.unshift(e.sourceCardId);
    seen.add(e.sourceCardId);
    cursor = e.sourceCardId;
  }
  return path;
}

/** 某卡片及其所有下游卡片 */
export function subtreeIds(edges: CardEdge[], cardId: string): string[] {
  const out: string[] = [];
  const walk = (id: string) => {
    out.push(id);
    outgoingEdges(edges, id).forEach((e) => {
      if (!out.includes(e.targetCardId)) walk(e.targetCardId);
    });
  };
  walk(cardId);
  return out;
}

const H_GAP = 54;
const V_GAP = 66;

/**
 * 简易分层树布局：深度决定 y，同层顺序决定 x。
 * 折叠的子树不参与布局。
 */
export function layoutGraph(
  cards: Card[],
  edges: CardEdge[],
  collapsed: Set<string>,
): {
  nodes: Map<string, GraphNode>;
  width: number;
  height: number;
  hidden: Set<string>;
} {
  const alive = cards.filter((c) => !c.trashed);
  const aliveIds = new Set(alive.map((c) => c.id));
  const roots = alive
    .filter((c) => !incomingEdge(edges, c.id))
    .map((c) => c.id);

  const hidden = new Set<string>();
  const order: { id: string; depth: number }[] = [];

  const visit = (id: string, depth: number) => {
    order.push({ id, depth });
    if (collapsed.has(id)) {
      subtreeIds(edges, id)
        .slice(1)
        .forEach((d) => hidden.add(d));
      return;
    }
    outgoingEdges(edges, id)
      .filter((e) => aliveIds.has(e.targetCardId))
      .forEach((e) => visit(e.targetCardId, depth + 1));
  };
  roots.forEach((r) => visit(r, 0));

  // 每层内按访问顺序水平排布
  const byDepth = new Map<number, string[]>();
  order.forEach(({ id, depth }) => {
    if (hidden.has(id)) return;
    const arr = byDepth.get(depth) ?? [];
    arr.push(id);
    byDepth.set(depth, arr);
  });

  const nodes = new Map<string, GraphNode>();
  let maxWidth = 0;
  byDepth.forEach((ids, depth) => {
    const rowWidth = (ids.length - 1) * H_GAP;
    maxWidth = Math.max(maxWidth, rowWidth);
    ids.forEach((id, i) => {
      nodes.set(id, {
        id,
        depth,
        x: i * H_GAP - rowWidth / 2,
        y: depth * V_GAP,
      });
    });
  });

  const depths = [...byDepth.keys()];
  const height = (Math.max(0, ...depths) + 1) * V_GAP;
  return { nodes, width: maxWidth + H_GAP * 2, height, hidden };
}
