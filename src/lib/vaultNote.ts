/**
 * vault 笔记序列化。规格与取舍理由见 `docs/VAULT_SYNC.md`。
 *
 * 这里**只产出内容**，不碰磁盘、不算哈希。归一化哈希只有一份实现，在 Rust 侧——
 * 那边才需要读回磁盘上的文件做比较，两处各算一遍必然漂移。
 *
 * 与 `formats.ts` 的 `cardMarkdown()` 的区别：那个在每篇笔记里嵌 base64 的完整
 * 卡片 JSON，适合无损 ZIP，但放进活的 vault 就是在文件里塞了**第二个权威**——
 * 用户在 Obsidian 改了正文，任何一次往返都会被那个 blob 静默吃掉。
 */
import type { Card, CardEdge, EdgeType, Project } from "../types";

export const RELATION_LABEL: Record<EdgeType, string> = {
  child: "深挖",
  divergent: "发散",
  branch: "改道",
};

export const safeName = (value: string) =>
  value
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, "-")
    .slice(0, 72) || "papertable";

/**
 * 文件名只用标题，同项目内重名时才补 id 后缀。
 *
 * 后缀会出现在快速切换器和每一条 `[[双链]]` 上，`量子退相干-oherence` 这种噪音
 * 让笔记读起来像导出物。重命名追踪不需要它：id 在 frontmatter 里，而 macOS
 * FSEvents 是目录粒度的，本来就必须按 `papertable_id` 匹配而不是按路径。
 */
export function makeNoteNamer(cards: Card[]): (card: Card) => string {
  const counts = new Map<string, number>();
  for (const card of cards) {
    const base = safeName(card.title);
    counts.set(base, (counts.get(base) ?? 0) + 1);
  }
  return (card) => {
    const base = safeName(card.title);
    return (counts.get(base) ?? 0) > 1 ? `${base}-${card.id.slice(-8)}` : base;
  };
}

export interface NoteInput {
  project: Project;
  card: Card;
  incoming?: CardEdge;
  parent?: Card;
  syncedAt: number;
  noteName: (card: Card) => string;
}

export function cardNote(input: NoteInput): string {
  const { project, card, incoming, parent, syncedAt, noteName } = input;

  // 键名统一 papertable_ 前缀：Linter 的 yaml-key-sort 会按字母序重排，前缀让它们
  // 保持连续、结果稳定可预测。刻意不写 hash——它只存在 sync_state 里，否则就成了
  // 「内容包含自身内容的哈希」。
  const front: [string, string][] = [
    ["papertable_id", card.id],
    ["papertable_project", project.id],
    ["papertable_relation", incoming?.type ?? "root"],
    ["papertable_created", new Date(card.createdAt).toISOString()],
    ["papertable_synced_at", new Date(syncedAt).toISOString()],
  ];
  if (parent) front.push(["papertable_source", `"[[${noteName(parent)}]]"`]);

  // 只有真的带了选中片段才值得占一个引用块。发散边没有 sourceText，否则会渲染出
  // 一个内容只是父卡标题的 callout——纯噪音，关系已经在 frontmatter 和 canvas 里。
  const selection = (incoming?.sourceText ?? incoming?.sourceBlockText ?? "")
    .replace(/\s+/g, " ")
    .trim();
  const provenance =
    selection && parent
      ? `> [!quote] 来自 [[${noteName(parent)}]] 的选区\n> ${selection.slice(0, 160)}\n\n`
      : "";

  const written = card.turns.filter((turn) => turn.content.trim());
  const question = written.find((turn) => turn.role === "user");
  const answers = written.filter((turn) => turn.role === "ai");

  // 单问单答（绝大多数卡片）不套 `## 用户`/`## 助手` 骨架：模型正文本身就是从 `##`
  // 开始的，加一层同级标题会让 Obsidian 大纲错乱，header-increment 还可能去重排。
  // 去掉骨架之后这类笔记读起来就是知识，而不是聊天记录。
  const body =
    written.length === 2 && question && answers.length === 1
      ? `> [!question] ${question.content.trim().replace(/\s+/g, " ")}\n\n${answers[0].content.trim()}`
      : written
          .map(
            (turn) =>
              `## ${turn.role === "user" ? "用户" : "助手"}\n\n${turn.content.trim()}`,
          )
          .join("\n\n");

  const frontmatter = front
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");
  return `---\n${frontmatter}\n---\n\n# ${card.title}\n\n${provenance}${body}\n`;
}

/** JSON Canvas。`file` 是 **vault 相对**路径，不是项目相对。 */
export function projectCanvas(input: {
  cards: Card[];
  edges: CardEdge[];
  vaultRelativeDir: string;
  noteName: (card: Card) => string;
}): string {
  const { cards, edges, vaultRelativeDir, noteName } = input;
  return JSON.stringify(
    {
      nodes: cards.map((card, index) => ({
        id: card.id,
        type: "file",
        file: `${vaultRelativeDir}/${noteName(card)}.md`,
        x: (index % 4) * 340,
        y: Math.floor(index / 4) * 260,
        width: 300,
        height: 210,
      })),
      edges: edges.map((edge) => ({
        id: edge.id,
        fromNode: edge.sourceCardId,
        toNode: edge.targetCardId,
        fromSide: "bottom",
        toSide: "top",
        label: RELATION_LABEL[edge.type],
      })),
    },
    null,
    2,
  );
}

/** 项目索引。让项目在 Obsidian 的快速切换器里可发现——用户实际就是这么找它的。 */
export function projectIndex(input: {
  project: Project;
  cards: Card[];
  edges: CardEdge[];
  noteName: (card: Card) => string;
}): string {
  const { project, cards, edges, noteName } = input;
  const lines = cards.map((card) => {
    const incoming = edges.find((edge) => edge.targetCardId === card.id);
    const label = incoming ? RELATION_LABEL[incoming.type] : "根";
    return `- [[${noteName(card)}]] · ${label}`;
  });
  return (
    `# ${project.name}\n\n` +
    `> [!info] 由 Papertable 同步 · ${cards.length} 张卡片 · ${edges.length} 条关系\n` +
    `> 这里是探索过程的产物。正式知识请经 knowledge-coach 发布。\n\n` +
    `${lines.join("\n")}\n\n关系图：[[_关系.canvas]]\n`
  );
}
