import type { Turn } from "../types";

export const PROJECT_NAME_LIMIT = 60;

export function normalizeProjectName(value: string): string {
  return value.normalize("NFC").replace(/\s+/gu, " ").trim();
}

/**
 * Desktop retries keep the failed attempt in storage for audit, but replace it
 * in the conversation surface. Consecutive assistant rows belong to the same
 * user question, so only the newest attempt is user-visible.
 */
export function desktopTurnsForDisplay(turns: readonly Turn[]): Turn[] {
  const ordered = turns
    .map((turn, index) => ({ turn, index }))
    .sort(
      (left, right) =>
        left.turn.createdAt - right.turn.createdAt ||
        (left.turn.role === right.turn.role
          ? left.index - right.index
          : left.turn.role === "user"
            ? -1
            : 1),
    )
    .map(({ turn }) => turn);
  const visible: Turn[] = [];
  for (const turn of ordered) {
    const previous = visible[visible.length - 1];
    if (turn.role === "ai" && previous?.role === "ai") {
      visible[visible.length - 1] = turn;
      continue;
    }
    visible.push(turn);
  }
  return visible;
}
