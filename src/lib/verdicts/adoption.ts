import type { Turn } from "../../types";
import type { Verdict, VerdictHost, VerdictInput } from "./types";

const cleanLine = (value: string, max: number, label: string) => {
  const clean = value.normalize("NFC").replace(/\s+/gu, " ").trim();
  if (!clean) throw new Error(`${label}不能为空。`);
  if ([...clean].length > max) throw new Error(`${label}最多 ${max} 个字符。`);
  return clean;
};

export const isGoldEligible = (turn: Turn) =>
  turn.role === "ai" &&
  turn.status === "complete" &&
  !turn.streaming &&
  Boolean(turn.content.trim());

export const normalizeGoldDraft = (value: string) =>
  cleanLine(value, 500, "结论");

export const normalizeConceptHandle = (value: string) =>
  cleanLine(value, 80, "概念把手");

function requireWrite<T>(
  response:
    | { available: true; data: T }
    | { available: false; error: { message: string } },
): T {
  if (!response.available) throw new Error(response.error.message);
  return response.data;
}

function sameGold(existing: Verdict, input: VerdictInput) {
  return (
    existing.projectId === input.projectId &&
    existing.verdictType === "gold" &&
    existing.sourceKind === "turn" &&
    existing.sourceId === input.sourceId &&
    existing.sourceCardId === input.sourceCardId &&
    existing.sourceTurnId === input.sourceTurnId &&
    existing.content === input.content &&
    existing.concepts.length === input.concepts.length &&
    existing.concepts.every(
      (concept, index) => concept === input.concepts[index],
    )
  );
}

function verifyWritten(
  verdict: Verdict,
  input: VerdictInput,
  supersedesMemoryId: string | null,
) {
  if (
    typeof verdict?.id !== "string" ||
    !verdict.id ||
    verdict.status !== "confirmed" ||
    verdict.supersedesMemoryId !== supersedesMemoryId ||
    !sameGold(verdict, input)
  )
    throw new Error("判决簿写入后返回的记录不匹配，未设置本地采纳标记。");
  return verdict;
}

export async function adoptGoldTurn(input: {
  host: VerdictHost;
  projectId: string;
  cardId: string;
  turn: Turn;
  conclusion: string;
  conceptHandle: string;
}): Promise<Verdict> {
  if (!isGoldEligible(input.turn))
    throw new Error("只有已完成且非空的 AI 回答可以采纳。");
  const verdictInput: VerdictInput = {
    projectId: input.projectId,
    verdictType: "gold",
    sourceKind: "turn",
    sourceId: input.turn.id,
    sourceCardId: input.cardId,
    sourceTurnId: input.turn.id,
    content: normalizeGoldDraft(input.conclusion),
    concepts: [normalizeConceptHandle(input.conceptHandle)],
  };
  const currentId = input.turn.verdictId;
  if (currentId) {
    const listed = requireWrite(await input.host.list(input.projectId));
    const current = listed.history.find(
      (verdict) =>
        verdict.id === currentId && verdict.projectId === input.projectId,
    );
    if (!current) throw new Error("原采纳记录不可用，无法安全修订。");
    if (
      current.verdictType !== "gold" ||
      current.sourceKind !== "turn" ||
      current.sourceId !== input.turn.id ||
      current.sourceCardId !== input.cardId ||
      current.sourceTurnId !== input.turn.id
    )
      throw new Error("原采纳记录的来源不匹配，无法安全修订。");
    if (sameGold(current, verdictInput)) return current;
    return verifyWritten(
      requireWrite(await input.host.supersede(current.id, verdictInput))
        .verdict,
      verdictInput,
      current.id,
    );
  }
  return verifyWritten(
    requireWrite(await input.host.confirm(verdictInput)).verdict,
    verdictInput,
    null,
  );
}
