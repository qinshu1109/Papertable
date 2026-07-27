/**
 * 把一个项目的当前状态转成「要写哪些文件」。纯函数，不碰磁盘、不调 Tauri。
 *
 * 分成独立一层是因为「写什么」和「怎么写」的失败方式完全不同：前者是内容对不对，
 * 后者是容纳与冲突。前者能在 Node 里测，后者必须在 Rust 里测真实文件系统。
 */
import type { Card, CardEdge, Project } from "../types";
import type { NoteWrite } from "./vault";
import {
  cardNote,
  makeNoteNamer,
  projectCanvas,
  projectIndex,
  safeName,
} from "./vaultNote";

/**
 * 默认子树。**必须与 Rust 侧的 `DEFAULT_SUBTREE` 一致**。
 *
 * 两处各写一遍是隐患：改一处不改另一处，canvas 里的 `file` 路径就会指向 Rust 实际
 * 没写的位置。所以这个值只在**生成 canvas 的相对路径**时使用，而真正决定写到哪里的
 * 始终是 Rust 侧那一个断言——前端算错了，那边会直接拒绝。
 */
export const DEFAULT_VAULT_SUBTREE = "80_AI暂存/Papertable";

export function projectDir(project: Project): string {
  return safeName(project.name);
}

export function vaultRelativeDir(project: Project, subtree: string): string {
  return `${subtree}/${projectDir(project)}`;
}

/**
 * 一条 AI 轮次算「可导出」的判据是**它没有出问题**，而不是「它被标成了 complete」。
 *
 * `Turn.status` 是可选的：只有走当前流式路径产生的轮次才会被标 `complete`，
 * 而导入的、demo 播种的、以及早期版本留下的轮次根本没有这个字段。要求
 * `status === "complete"` 会把它们全部悄悄排除——真机上表现为开了同步却一个文件
 * 都不写，且不报错。
 */
const deliverable = (turn: Card["turns"][number]) =>
  turn.role === "ai" &&
  !turn.streaming &&
  turn.status !== "streaming" &&
  turn.status !== "stopped" &&
  turn.status !== "error" &&
  Boolean(turn.content.trim());

/**
 * 还在生成、已停止、出错的卡片不进知识库——半句话的笔记比没有笔记更糟。
 * 回收站里的卡片同样排除，它们的文件由删除路径单独清理。
 */
export function syncableCards(cards: Card[], projectId: string): Card[] {
  return cards.filter(
    (card) =>
      card.projectId === projectId &&
      !card.trashed &&
      card.turns.some(deliverable),
  );
}

export function planProjectSync(input: {
  project: Project;
  cards: Card[];
  edges: CardEdge[];
  syncedAt: number;
  /** 容纳子树，只用于 canvas 里的 vault 相对路径。 */
  subtree?: string;
}): NoteWrite[] {
  const { project, edges, syncedAt } = input;
  const subtree = input.subtree ?? DEFAULT_VAULT_SUBTREE;
  const cards = syncableCards(input.cards, project.id);
  if (!cards.length) return [];

  const cardIds = new Set(cards.map((card) => card.id));
  const scoped = edges.filter(
    (edge) => cardIds.has(edge.sourceCardId) && cardIds.has(edge.targetCardId),
  );
  const noteName = makeNoteNamer(cards);
  const dir = projectDir(project);

  const notes: NoteWrite[] = cards.map((card) => {
    const incoming = scoped.find((edge) => edge.targetCardId === card.id);
    const parent = incoming
      ? cards.find((candidate) => candidate.id === incoming.sourceCardId)
      : undefined;
    return {
      cardId: card.id,
      relative: [dir, `${noteName(card)}.md`],
      content: cardNote({
        project,
        card,
        incoming,
        parent,
        syncedAt,
        noteName,
      }),
    };
  });

  // 项目级产物没有 cardId：它们完全由 Papertable 生成，不参与逐卡片的冲突挂起。
  notes.push({
    cardId: null,
    relative: [dir, "_索引.md"],
    content: projectIndex({ project, cards, edges: scoped, noteName }),
  });
  notes.push({
    cardId: null,
    relative: [dir, "_关系.canvas"],
    content: projectCanvas({
      cards,
      edges: scoped,
      vaultRelativeDir: vaultRelativeDir(project, subtree),
      noteName,
    }),
  });
  return notes;
}

/** 卡片当前应该在的文件名，用于标题变更时的 rename 与删除。 */
export function notePathFor(input: {
  project: Project;
  cards: Card[];
  card: Card;
}): string[] {
  const cards = syncableCards(input.cards, input.project.id);
  const noteName = makeNoteNamer(cards.length ? cards : [input.card]);
  return [projectDir(input.project), `${noteName(input.card)}.md`];
}
