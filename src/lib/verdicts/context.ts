import type {
  VerdictContextItem,
  VerdictTrace,
  VerdictTraceItem,
} from "../../types";
import type {
  Verdict,
  VerdictHost,
  VerdictList,
  VerdictResponse,
} from "./types";

export const VERDICT_PROMPT_VERSION = "verdict-v1" as const;
export const VERDICT_INJECTION_ENABLED =
  (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env
    ?.VITE_VERDICT_INJECTION !== "off";

const MAX_QUERY_LENGTH = 500;
const MAX_VERDICT_LENGTH = 500;
const UNSAFE = /[\p{Cc}\p{Cf}\u2028\u2029]/u;

const truncate = (value: string, limit: number) =>
  [...value].slice(0, limit).join("");

const oneLine = (value: string, limit: number): string | null => {
  const normalized = value.normalize("NFC").trim();
  if (
    !normalized ||
    UNSAFE.test(normalized) ||
    /[\r\n]/.test(normalized) ||
    [...normalized].length > limit
  )
    return null;
  return normalized;
};

export function buildVerdictQuery(
  question: string,
  title: string,
  concepts: readonly string[],
): string {
  const parts = [question, title, ...concepts]
    .map((value) =>
      value
        .normalize("NFC")
        .replace(/[\p{Cc}\p{Cf}\u2028\u2029]+/gu, " ")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter(Boolean);
  const unique = [...new Set(parts)];
  const joined = unique.join(" ");
  if ([...joined].length <= MAX_QUERY_LENGTH) return joined;
  const perPart = Math.max(
    1,
    Math.floor(
      (MAX_QUERY_LENGTH - Math.max(0, unique.length - 1)) / unique.length,
    ),
  );
  return truncate(
    unique.map((part) => truncate(part, perPart)).join(" "),
    MAX_QUERY_LENGTH,
  );
}

function validVerdict(
  value: Verdict,
  projectId: string,
): VerdictContextItem | null {
  const id = oneLine(value.id, 200);
  const content = oneLine(value.content, MAX_VERDICT_LENGTH);
  if (
    !id ||
    !content ||
    value.projectId !== projectId ||
    value.status !== "confirmed" ||
    (value.verdictType !== "tombstone" && value.verdictType !== "gold")
  )
    return null;
  return Object.freeze({
    id,
    verdictType: value.verdictType,
    content,
  });
}

/** Re-check TASK-014's DTO at the final host boundary and keep chain tails. */
export function freezeVerdicts(
  projectId: string,
  response: VerdictResponse<VerdictList>,
): readonly VerdictContextItem[] {
  if (!response.available) return Object.freeze([]);
  const valid = (values: Verdict[]) =>
    values
      .map((value) => ({
        source: value,
        frozen: validVerdict(value, projectId),
      }))
      .filter(
        (
          value,
        ): value is {
          source: Verdict;
          frozen: VerdictContextItem;
        } => Boolean(value.frozen),
      );
  const history = valid(response.data.history);
  const advertisedTails = new Set(
    valid(response.data.verdicts).map(({ frozen }) => frozen.id),
  );
  const superseded = new Set(
    history
      .map(({ source }) => source.supersedesMemoryId)
      .filter((id): id is string => Boolean(id)),
  );
  const seen = new Set<string>();
  return Object.freeze(
    history
      .filter(
        ({ frozen }) =>
          advertisedTails.has(frozen.id) && !superseded.has(frozen.id),
      )
      .map(({ frozen }) => frozen)
      .filter((item) => !seen.has(item.id) && Boolean(seen.add(item.id)))
      .sort((a, b) => a.id.localeCompare(b.id)),
  );
}

const traceItem = (item: VerdictContextItem): VerdictTraceItem => ({
  id: item.id,
  verdictType: item.verdictType,
  snapshot: item.content,
});

export async function loadVerdictContext(input: {
  host: VerdictHost;
  projectId: string;
  question: string;
  title: string;
  concepts: readonly string[];
  injectionEnabled?: boolean;
}): Promise<{
  items: readonly VerdictContextItem[];
  trace: VerdictTrace;
}> {
  const query = buildVerdictQuery(input.question, input.title, input.concepts);
  const injectionEnabled = input.injectionEnabled ?? VERDICT_INJECTION_ENABLED;
  try {
    const response = await input.host.list(input.projectId, query);
    if (!response.available)
      return {
        items: Object.freeze([]),
        trace: {
          promptVersion: VERDICT_PROMPT_VERSION,
          injectionEnabled,
          query,
          availability: "unavailable",
          verdicts: [],
          unavailableCode: response.error.code,
        },
      };
    const matches = freezeVerdicts(input.projectId, response);
    return {
      items: injectionEnabled ? matches : Object.freeze([]),
      trace: {
        promptVersion: VERDICT_PROMPT_VERSION,
        injectionEnabled,
        query,
        availability: "available",
        verdicts: matches.map(traceItem),
      },
    };
  } catch {
    return {
      items: Object.freeze([]),
      trace: {
        promptVersion: VERDICT_PROMPT_VERSION,
        injectionEnabled,
        query,
        availability: "unavailable",
        verdicts: [],
        unavailableCode: "unavailable",
      },
    };
  }
}

/** A same-run continuation uses its original frozen snapshot, never live MemOS. */
export function verdictContextFromTrace(
  trace: VerdictTrace,
): readonly VerdictContextItem[] {
  if (
    !trace.injectionEnabled ||
    trace.availability !== "available" ||
    trace.promptVersion !== VERDICT_PROMPT_VERSION
  )
    return Object.freeze([]);
  return Object.freeze(
    trace.verdicts
      .map((item) =>
        validVerdict(
          {
            id: item.id,
            projectId: "__frozen__",
            verdictType: item.verdictType,
            sourceKind: "turn",
            sourceId: "__frozen__",
            content: item.snapshot,
            concepts: [],
            status: "confirmed",
            idempotencyKey: "__frozen__",
            supersedesMemoryId: null,
          },
          "__frozen__",
        ),
      )
      .filter((item): item is VerdictContextItem => Boolean(item)),
  );
}
