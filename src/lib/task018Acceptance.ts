import type { InteractionEvent } from "../types";
import { aggregateRerouteVerdicts } from "./verdicts/reroute";

export interface Task018AbCase {
  id: string;
  question: string;
  verdict: string;
  recurrenceRule: string;
}

export interface Task018AbResult extends Task018AbCase {
  off: { response: string; recurrence: boolean | null };
  on: { response: string; recurrence: boolean | null };
}

export interface Task018AbRun {
  promptVersion: string;
  generatedAt: string;
  provider: { model: string; host: string };
  cases: Task018AbResult[];
}

const requiredLine = (value: unknown, field: string) => {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    /[\r\n]/.test(value) ||
    [...value].length > 500
  )
    throw new Error(`${field} 必须是 1 到 500 字的单行文本`);
  return value.trim();
};

export function validateTask018Cases(value: unknown): Task018AbCase[] {
  const cases = (value as { cases?: unknown })?.cases;
  if (!Array.isArray(cases) || cases.length !== 10)
    throw new Error("A/B 必须恰好包含 10 个用户冻结的老问题");
  const seen = new Set<string>();
  return cases.map((item, index) => {
    const row = item as Partial<Task018AbCase>;
    const id = requiredLine(row.id, `cases[${index}].id`);
    if (seen.has(id)) throw new Error(`重复的 A/B case id: ${id}`);
    seen.add(id);
    const frozen = {
      id,
      question: requiredLine(row.question, `cases[${index}].question`),
      verdict: requiredLine(row.verdict, `cases[${index}].verdict`),
      recurrenceRule: requiredLine(
        row.recurrenceRule,
        `cases[${index}].recurrenceRule`,
      ),
    };
    if (
      frozen.id.startsWith("replace-") ||
      Object.values(frozen).some((field) => field.includes("替换为"))
    )
      throw new Error(`cases[${index}] 仍是占位内容，禁止运行真实 A/B`);
    return frozen;
  });
}

export function summarizeTask018Ab(run: Task018AbRun) {
  const judged = run.cases.filter(
    (item) =>
      typeof item.off.recurrence === "boolean" &&
      typeof item.on.recurrence === "boolean",
  );
  const offRecurrences = judged.filter((item) => item.off.recurrence).length;
  const onRecurrences = judged.filter((item) => item.on.recurrence).length;
  return {
    sampleSize: run.cases.length,
    judged: judged.length,
    offRecurrences,
    onRecurrences,
    recurrenceHalved:
      judged.length === 10 &&
      offRecurrences > 0 &&
      onRecurrences * 2 <= offRecurrences,
    status:
      judged.length < 10
        ? ("in_progress" as const)
        : offRecurrences > 0 && onRecurrences * 2 <= offRecurrences
          ? ("passed" as const)
          : ("failed" as const),
  };
}

export function summarizeTask018Events(events: readonly InteractionEvent[]) {
  const stats = aggregateRerouteVerdicts(events);
  return {
    ...stats,
    confirmationGate:
      stats.eligible >= 20 && stats.confirmationRate >= 0.3
        ? ("passed" as const)
        : stats.eligible >= 20
          ? ("failed" as const)
          : ("in_progress" as const),
    draftQualityGate:
      stats.firstTenSettled >= 10 && stats.firstTenMajorRewriteOrAbandoned <= 5
        ? ("passed" as const)
        : stats.firstTenSettled >= 10
          ? ("failed" as const)
          : ("in_progress" as const),
  };
}
