import type { Card } from "../../types";
import type { Verdict, VerdictList } from "./types";

export interface VerdictLedgerEntry {
  verdict: Verdict;
  reuseCount: number;
  superseded: Array<{ verdict: Verdict; reuseCount: number }>;
}

export interface VerdictLedger {
  gold: VerdictLedgerEntry[];
  tombstones: VerdictLedgerEntry[];
}

export function verdictReuseCounts(
  cards: readonly Card[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const card of cards)
    for (const turn of card.turns) {
      const trace = turn.verdictTrace;
      if (!trace?.injectionEnabled || trace.availability !== "available")
        continue;
      for (const id of new Set(trace.verdicts.map((verdict) => verdict.id)))
        counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  return counts;
}

export function buildVerdictLedger(
  projectId: string,
  list: VerdictList,
  cards: readonly Card[],
): VerdictLedger {
  const history = list.history.filter(
    (verdict) =>
      verdict.projectId === projectId && verdict.status === "confirmed",
  );
  const byId = new Map(history.map((verdict) => [verdict.id, verdict]));
  const counts = verdictReuseCounts(
    cards.filter((card) => card.projectId === projectId),
  );
  const entries = list.verdicts
    .filter(
      (verdict) =>
        verdict.projectId === projectId &&
        verdict.status === "confirmed" &&
        byId.has(verdict.id),
    )
    .map((verdict) => {
      const superseded: VerdictLedgerEntry["superseded"] = [];
      const seen = new Set([verdict.id]);
      let previousId = verdict.supersedesMemoryId;
      while (previousId && !seen.has(previousId)) {
        seen.add(previousId);
        const previous = byId.get(previousId);
        if (!previous) break;
        superseded.push({
          verdict: previous,
          reuseCount: counts.get(previous.id) ?? 0,
        });
        previousId = previous.supersedesMemoryId;
      }
      return {
        verdict,
        reuseCount: counts.get(verdict.id) ?? 0,
        superseded,
      };
    })
    .sort((a, b) => a.verdict.id.localeCompare(b.verdict.id));
  return {
    gold: entries.filter((entry) => entry.verdict.verdictType === "gold"),
    tombstones: entries.filter(
      (entry) => entry.verdict.verdictType === "tombstone",
    ),
  };
}
