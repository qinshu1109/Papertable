import type { InteractionEvent, Turn } from "../../types";
import { isTurnEligibleForContext } from "../context";
import { generateModel } from "../provider";

export interface RerouteRound {
  user: Turn;
  assistant: Turn;
}

export interface RerouteVerdictStats {
  eligible: number;
  confirmed: number;
  rewritten: number;
  abandoned: number;
  confirmationRate: number;
  firstTenSettled: number;
  firstTenMajorRewriteOrAbandoned: number;
}

const MAX_VERDICT_LENGTH = 500;
const MAJOR_REWRITE_RATIO = 0.5;

export function cutoffBeforeRerouteRound(
  turns: readonly Turn[],
  assistantTurnId: string,
): string | null | undefined {
  const assistantIndex = turns.findIndex(
    (turn) => turn.id === assistantTurnId && turn.role === "ai",
  );
  if (assistantIndex < 0) return undefined;
  for (let index = assistantIndex - 1; index >= 0; index -= 1) {
    if (turns[index]?.role !== "user") continue;
    return index > 0 ? turns[index - 1]?.id : null;
  }
  return undefined;
}

export function extractCutRerouteRounds(
  turns: readonly Turn[],
  contextCutoffTurnId?: string | null,
  sourceTurnId?: string,
): RerouteRound[] {
  const cutoff =
    contextCutoffTurnId !== undefined ? contextCutoffTurnId : sourceTurnId;
  const cutoffIndex = cutoff
    ? turns.findIndex((turn) => turn.id === cutoff)
    : -1;
  const suffix = turns.slice(cutoffIndex + 1);
  const rounds: RerouteRound[] = [];
  for (let index = 0; index < suffix.length - 1; index += 1) {
    const user = suffix[index];
    const assistant = suffix[index + 1];
    if (
      user.role === "user" &&
      assistant.role === "ai" &&
      isTurnEligibleForContext(assistant)
    ) {
      rounds.push({ user, assistant });
      index += 1;
    }
  }
  return rounds;
}

export function rerouteDraftMaterial(
  sourceTitle: string,
  rounds: readonly RerouteRound[],
): string {
  return [
    `来源卡片：${sourceTitle}`,
    ...rounds.flatMap((round, index) => [
      `第 ${index + 1} 轮用户：${round.user.content}`,
      `第 ${index + 1} 轮助手：${round.assistant.content}`,
    ]),
  ].join("\n");
}

export function verdictLine(value: string): string | null {
  const line = value.normalize("NFC").trim();
  if (
    !line ||
    /[\r\n\p{Cc}\p{Cf}\u2028\u2029]/u.test(line) ||
    [...line].length > MAX_VERDICT_LENGTH
  )
    return null;
  return line;
}

export async function draftRerouteTombstone(
  material: string,
  generate: typeof generateModel = generateModel,
): Promise<string> {
  const output = await generate({
    task: "verdict-draft",
    temperature: 0,
    messages: [
      {
        role: "system",
        content:
          "根据被改道裁掉的完整问答，起草一句墓碑：只说明这条旧方向为何不再作为默认答案。不得扩展新事实，不得给建议，不得使用换行，只输出一句最多 500 字的正文。",
      },
      { role: "user", content: material.slice(0, 120_000) },
    ],
  });
  const line = verdictLine(output);
  if (!line) throw new Error("墓碑草稿不是有效的单行文本。");
  return line;
}

export function rewriteRatio(before: string, after: string): number {
  const left = [...before];
  const right = [...after];
  if (!left.length) return right.length ? 1 : 0;
  const previous = Array.from(
    { length: right.length + 1 },
    (_, index) => index,
  );
  for (let row = 1; row <= left.length; row += 1) {
    let diagonal = previous[0];
    previous[0] = row;
    for (let column = 1; column <= right.length; column += 1) {
      const above = previous[column];
      previous[column] = Math.min(
        previous[column] + 1,
        previous[column - 1] + 1,
        diagonal + (left[row - 1] === right[column - 1] ? 0 : 1),
      );
      diagonal = above;
    }
  }
  return previous[right.length] / Math.max(left.length, right.length, 1);
}

export function aggregateRerouteVerdicts(
  events: readonly InteractionEvent[],
): RerouteVerdictStats {
  const keyOf = (event: InteractionEvent) =>
    event.targetCardId ? `${event.projectId}\u0000${event.targetCardId}` : null;
  const byCard = new Map<string, InteractionEvent[]>();
  for (const event of events) {
    const key = keyOf(event);
    if (!key) continue;
    const group = byCard.get(key) ?? [];
    group.push(event);
    byCard.set(key, group);
  }
  const eligibleByCard = new Map<string, InteractionEvent>();
  for (const event of [...events].sort(
    (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id),
  )) {
    const key = keyOf(event);
    if (event.type === "reroute-eligible" && key && !eligibleByCard.has(key))
      eligibleByCard.set(key, event);
  }
  const groups = [...eligibleByCard].map(([key, eligible]) => {
    const events = (byCard.get(key) ?? [])
      .filter((event) => event.createdAt >= eligible.createdAt)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    const terminal = events.find(
      (event) =>
        event.type === "tombstone-confirmed" ||
        event.type === "tombstone-abandoned",
    );
    const rewriteRatio = Math.max(
      0,
      ...events
        .filter((event) => event.type === "tombstone-rewritten")
        .map((event) => event.editRatio ?? 0),
    );
    return { eligible, terminal, rewriteRatio };
  });
  const settled = groups.filter(
    (
      group,
    ): group is typeof group & {
      terminal: InteractionEvent;
    } => Boolean(group.terminal),
  );
  const confirmed = settled.filter(
    ({ terminal }) => terminal.type === "tombstone-confirmed",
  ).length;
  const abandoned = settled.filter(
    ({ terminal }) => terminal.type === "tombstone-abandoned",
  ).length;
  const rewritten = settled.filter(
    ({ terminal, rewriteRatio }) =>
      terminal.type === "tombstone-confirmed" && rewriteRatio > 0,
  ).length;
  const firstTen = settled.slice(0, 10);
  return {
    eligible: groups.length,
    confirmed,
    rewritten,
    abandoned,
    confirmationRate: groups.length ? confirmed / groups.length : 0,
    firstTenSettled: firstTen.length,
    firstTenMajorRewriteOrAbandoned: firstTen.filter(
      ({ terminal, rewriteRatio }) =>
        terminal.type === "tombstone-abandoned" ||
        rewriteRatio >= MAJOR_REWRITE_RATIO,
    ).length,
  };
}
