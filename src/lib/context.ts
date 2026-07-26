import { incomingEdge } from "./graph";
import type {
  AnswerMode,
  BuiltContext,
  Card,
  CardEdge,
  ContextSnapshot,
  LlmMessage,
  ReferenceChip,
} from "../types";

export interface BuildContextInput {
  cards: Card[];
  edges: CardEdge[];
  snapshots: ContextSnapshot[];
  references: ReferenceChip[];
  currentCardId: string;
  pendingUserText?: string;
}

const instructionFor = (answerMode: AnswerMode) =>
  answerMode === "sources-only"
    ? "你是 Papertable 的知识探索助手。只能使用下方明确提供的上下文；若证据不足，请直接说明，不得用通用知识补齐结论。不得伪造引用、来源或已提供的证据。使用清晰的 Markdown 回答，不输出隐藏推理过程。"
    : "你是 Papertable 的知识探索助手。优先使用下方明确提供的当前卡片、来源主题、精确选区、冻结分支历史和显式引用；若材料不足，可以使用通用知识继续回答。回答时必须清楚区分哪些判断来自用户材料，哪些是通用知识补充或推断。不得伪造引用、来源或已提供的证据。使用清晰的 Markdown 回答，不输出隐藏推理过程。";

const toMessages = (card: Card, pendingUserText?: string): LlmMessage[] => {
  const messages: LlmMessage[] = card.turns
    .filter((turn) => turn.status !== "error" && turn.status !== "stopped")
    // Card 的内部角色叫 `ai`，但 OpenAI-compatible API 只接受 `assistant`。
    // 首轮没有 AI 历史时这个问题不会出现，因此必须在这里做唯一的边界转换。
    .map((turn) => ({
      role: turn.role === "ai" ? "assistant" : "user",
      content: turn.content,
    }));
  if (pendingUserText)
    messages.push({ role: "user", content: pendingUserText });
  return messages;
};

export function buildContext(input: BuildContextInput): BuiltContext {
  const card = input.cards.find(
    (candidate) => candidate.id === input.currentCardId,
  );
  if (!card) throw new Error("Current card not found");
  const answerMode = card.answerMode ?? "general";
  const edge = incomingEdge(input.edges, card.id);
  const snapshot = edge?.contextSnapshotId
    ? input.snapshots.find(
        (candidate) => candidate.id === edge.contextSnapshotId,
      )
    : undefined;
  const source = edge
    ? input.cards.find((candidate) => candidate.id === edge.sourceCardId)
    : undefined;
  const system = [instructionFor(answerMode)];
  const provenance: BuiltContext["provenance"] = [];
  const excluded: BuiltContext["excluded"] = [];

  if (edge?.type === "child") {
    const title = snapshot?.sourceTitle ?? source?.title ?? "来源卡片";
    const selected = snapshot?.sourceText ?? edge.sourceText;
    const block = snapshot?.sourceBlockText ?? edge.sourceBlockText;
    system.push(`来源主题：${title}`);
    provenance.push({
      kind: "source-topic",
      label: "来源主题",
      detail: title,
      cardId: edge.sourceCardId,
    });
    if (selected) {
      system.push(
        `精确选区：${selected}${block ? `\n所在段落：${block}` : ""}`,
      );
      provenance.push({
        kind: "source-selection",
        label: "精确选区",
        detail: selected,
        cardId: edge.sourceCardId,
        turnId: edge.sourceTurnId,
      });
    }
    excluded.push({
      kind: "source-topic",
      label: "未带入",
      detail: `《${title}》的完整对话历史`,
      cardId: edge.sourceCardId,
    });
  }

  if (edge?.type === "divergent") {
    const title = snapshot?.sourceTitle ?? source?.title ?? "来源卡片";
    system.push(`相关主题：${title}`);
    provenance.push({
      kind: "source-topic",
      label: "相关主题",
      detail: title,
      cardId: edge.sourceCardId,
    });
    excluded.push({
      kind: "source-topic",
      label: "未带入",
      detail: `《${title}》的对话内容`,
      cardId: edge.sourceCardId,
    });
  }

  if (edge?.type === "branch") {
    const title = snapshot?.sourceTitle ?? source?.title ?? "来源卡片";
    const turns = snapshot?.sourceTurns ?? [];
    if (turns.length) {
      const history = turns
        .map(
          (turn) =>
            `${turn.role === "user" ? "用户" : "助手"}：${turn.content}`,
        )
        .join("\n\n");
      system.push(`改道来源《${title}》的冻结历史（仅到分支点）：\n${history}`);
      provenance.push({
        kind: "branch-history",
        label: "分支历史",
        detail: `《${title}》第 1–${turns.filter((turn) => turn.role === "ai").length} 轮`,
        cardId: edge.sourceCardId,
        turnId: edge.sourceTurnId,
      });
    }
    excluded.push({
      kind: "branch-history",
      label: "未带入",
      detail: `《${title}》分支点之后的内容`,
      cardId: edge.sourceCardId,
    });
  }

  const seen = new Set<string>();
  for (const reference of input.references) {
    const key = `${reference.anchor.cardId}:${reference.anchor.turnId ?? ""}:${reference.excerpt}`;
    if (seen.has(key)) continue;
    seen.add(key);
    system.push(
      `用户显式引用《${reference.sourceTitle}》：\n${reference.excerpt}`,
    );
    provenance.push({
      kind: "reference",
      label: "显式引用",
      detail: reference.sourceTitle,
      cardId: reference.anchor.cardId,
      turnId: reference.anchor.turnId,
    });
  }

  const messages = toMessages(card, input.pendingUserText);
  provenance.unshift({
    kind: "current-card",
    label: "当前卡片",
    detail: `《${card.title}》的 ${messages.length} 条轮次`,
    cardId: card.id,
  });
  excluded.push({
    kind: "current-card",
    label: "未带入",
    detail: "项目中其他分支和其他项目",
    cardId: card.id,
  });
  const estimatedTokens = Math.ceil(
    [...system, ...messages.map((message) => message.content)].join("\n")
      .length / 1.7,
  );
  return {
    answerMode,
    system,
    messages: [{ role: "system", content: system.join("\n\n") }, ...messages],
    provenance,
    excluded,
    estimatedTokens,
  };
}
