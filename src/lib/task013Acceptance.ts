import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export const TASK_013_CRITERIA = [
  "correct-tool-calls",
  "correct-terminal-state",
  "persisted-evidence",
  "no-unauthorized-reads",
  "no-unhandled-duplicate-calls",
  "no-two-stage-on-protocol-failure",
] as const;

export type Task013Criterion = (typeof TASK_013_CRITERIA)[number];
export type Task013CriterionStatus = "pass" | "fail" | "not-applicable";

export interface Task013CriterionResult {
  status: Task013CriterionStatus;
  detail?: string;
}

export interface Task013AcceptanceRow {
  id: string;
  source: "golden-fixture" | "deterministic-runtime" | "real-provider";
  model?: string;
  execution?: "external" | "injected" | "local";
  criteria: Record<Task013Criterion, Task013CriterionResult>;
}

export interface Task013GoldenManifestEntry {
  path: string;
  semanticSha256: string;
  criteria: Task013Criterion[];
}

export interface Task013GoldenManifest {
  schemaVersion: 1;
  fixtureSchemaVersion: 1;
  tasks: string[];
  entries: Task013GoldenManifestEntry[];
}

const TASK_DIRECTORIES = [
  "task-004",
  "task-005",
  "task-006",
  "task-007",
  "task-008",
  "task-009",
  "task-010",
  "task-011",
  "task-012",
] as const;

const LEGAL_TERMINALS = new Set([
  "completed/none",
  "partial/rounds_exhausted",
  "partial/calls_exhausted",
  "partial/wall_exhausted",
  "partial/tokens_exhausted",
  "partial/no_progress",
  "refused/insufficient_evidence",
  "failed/protocol_error",
  "failed/none",
  "aborted/user_abort",
]);

const TEXT_PRESENCE_KEYS = new Set([
  "answer",
  "content",
  "detail",
  "expectedLabel",
  "injectedSystemMessages",
  "malformedArguments",
  "message",
  "objective",
  "sourceBlockText",
  "sourceText",
  "text",
  "unavailableReason",
  "unresolvedQuestions",
]);

function normalizeSemanticValue(value: unknown, key = ""): unknown {
  if (Array.isArray(value)) {
    if (TEXT_PRESENCE_KEYS.has(key))
      return { present: value.length > 0, count: value.length };
    return value.map((item) => normalizeSemanticValue(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([childKey, childValue]) => [
          childKey,
          normalizeSemanticValue(childValue, childKey),
        ]),
    );
  }
  if (typeof value === "string" && TEXT_PRESENCE_KEYS.has(key))
    return { present: value.trim().length > 0 };
  return value;
}

export function task013SemanticDigest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(normalizeSemanticValue(value)))
    .digest("hex");
}

function result(
  status: Task013CriterionStatus,
  detail?: string,
): Task013CriterionResult {
  return { status, ...(detail ? { detail } : {}) };
}

function blankCriteria(): Record<Task013Criterion, Task013CriterionResult> {
  return Object.fromEntries(
    TASK_013_CRITERIA.map((criterion) => [criterion, result("not-applicable")]),
  ) as Record<Task013Criterion, Task013CriterionResult>;
}

function collectObjects(value: unknown): Array<Record<string, unknown>> {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(collectObjects);
  const object = value as Record<string, unknown>;
  return [object, ...Object.values(object).flatMap(collectObjects)];
}

function fixtureTerminals(value: unknown): Array<{
  result: string;
  reason: string;
}> {
  return collectObjects(value)
    .map((object) =>
      typeof object.result === "string" && typeof object.reason === "string"
        ? object
        : object.terminal,
    )
    .filter((terminal): terminal is { result: string; reason: string } =>
      Boolean(
        terminal &&
        typeof terminal === "object" &&
        typeof (terminal as { result?: unknown }).result === "string" &&
        typeof (terminal as { reason?: unknown }).reason === "string",
      ),
    );
}

function validateCriterionShape(
  criterion: Task013Criterion,
  fixture: unknown,
): string | undefined {
  const objects = collectObjects(fixture);
  if (criterion === "correct-terminal-state") {
    const terminals = fixtureTerminals(fixture);
    if (!terminals.length) return "fixture has no terminal state";
    const illegal = terminals.find(
      (terminal) =>
        !LEGAL_TERMINALS.has(`${terminal.result}/${terminal.reason}`),
    );
    if (illegal) return `illegal terminal ${illegal.result}/${illegal.reason}`;
  }
  if (criterion === "correct-tool-calls") {
    const toolNames = objects
      .flatMap((object) => {
        const names: string[] = [];
        if (
          typeof object.name === "string" &&
          ["search_notes", "read_notes", "papertable_probe"].includes(
            object.name,
          )
        )
          names.push(object.name);
        for (const key of ["modelToolParameters"]) {
          const nested = object[key];
          if (nested && typeof nested === "object" && !Array.isArray(nested))
            names.push(...Object.keys(nested));
        }
        return names;
      })
      .filter(Boolean);
    const invalid = toolNames.find(
      (name) =>
        name !== "search_notes" &&
        name !== "read_notes" &&
        name !== "papertable_probe",
    );
    if (invalid) return `unexpected tool ${invalid}`;
  }
  if (criterion === "persisted-evidence") {
    const root = fixture as { schemaVersion?: unknown };
    if (root.schemaVersion !== 1) return "fixture is not schema v1";
  }
  if (criterion === "no-unauthorized-reads") {
    const requests = objects.filter((object) => "chunkIds" in object);
    if (
      requests.some(
        (request) =>
          Array.isArray(request.chunkIds) &&
          request.chunkIds.some((id) => typeof id !== "string"),
      )
    )
      return "non-string chunk authority found";
  }
  if (criterion === "no-unhandled-duplicate-calls") {
    const duplicateEvents = objects.filter(
      (object) => object.kind === "duplicate-call-detected",
    );
    if (
      duplicateEvents.some(
        (event) =>
          typeof event.occurrences !== "number" || event.occurrences < 2,
      )
    )
      return "invalid duplicate-call transition";
  }
  if (criterion === "no-two-stage-on-protocol-failure") {
    const downgrade = objects.find(
      (object) =>
        object.downgradedWorkflowCalls !== undefined &&
        object.downgradedWorkflowCalls !== 0,
    );
    if (downgrade) return "downgraded workflow call recorded";
    const fallback = objects.find((object) => object.fallbackSelected === true);
    if (fallback) return "fallback was selected";
  }
  return undefined;
}

export async function discoverTask013GoldenFixtures(
  outputsRoot: string,
): Promise<string[]> {
  const fixtures: string[] = [];
  for (const directory of TASK_DIRECTORIES) {
    const entries = await readdir(path.join(outputsRoot, directory), {
      withFileTypes: true,
    });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".json"))
        fixtures.push(`${directory}/${entry.name}`);
    }
  }
  return fixtures.sort();
}

export async function replayTask013GoldenFixtures(input: {
  outputsRoot: string;
  manifestPath: string;
}): Promise<Task013AcceptanceRow[]> {
  const manifest = JSON.parse(
    await readFile(input.manifestPath, "utf8"),
  ) as Task013GoldenManifest;
  const discovered = await discoverTask013GoldenFixtures(input.outputsRoot);
  const expected = [...manifest.entries.map((entry) => entry.path)].sort();
  const inventoryMatches =
    JSON.stringify(discovered) === JSON.stringify(expected) &&
    manifest.schemaVersion === 1 &&
    manifest.fixtureSchemaVersion === 1 &&
    JSON.stringify(manifest.tasks) === JSON.stringify([...TASK_DIRECTORIES]);
  const byPath = new Map(manifest.entries.map((entry) => [entry.path, entry]));

  return Promise.all(
    discovered.map(async (relativePath) => {
      const fixture = JSON.parse(
        await readFile(path.join(input.outputsRoot, relativePath), "utf8"),
      ) as unknown;
      const entry = byPath.get(relativePath);
      const criteria = blankCriteria();
      const digestMatches =
        entry?.semanticSha256 === task013SemanticDigest(fixture);
      for (const criterion of entry?.criteria ?? ["persisted-evidence"]) {
        const shapeFailure = validateCriterionShape(criterion, fixture);
        criteria[criterion] =
          inventoryMatches && digestMatches && !shapeFailure
            ? result("pass")
            : result(
                "fail",
                shapeFailure ??
                  (!inventoryMatches
                    ? "fixture inventory or manifest schema changed"
                    : "six-criterion semantic projection changed"),
              );
      }
      return {
        id: relativePath,
        source: "golden-fixture",
        criteria,
      };
    }),
  );
}

export function task013RowsPass(rows: Task013AcceptanceRow[]): boolean {
  return rows.every((row) =>
    TASK_013_CRITERIA.every(
      (criterion) => row.criteria[criterion].status !== "fail",
    ),
  );
}

export function summarizeTask013Rows(rows: Task013AcceptanceRow[]) {
  return {
    rows: rows.length,
    passed: rows.filter((row) =>
      TASK_013_CRITERIA.every(
        (criterion) => row.criteria[criterion].status !== "fail",
      ),
    ).length,
    failed: rows.filter((row) =>
      TASK_013_CRITERIA.some(
        (criterion) => row.criteria[criterion].status === "fail",
      ),
    ).length,
    criteria: Object.fromEntries(
      TASK_013_CRITERIA.map((criterion) => [
        criterion,
        {
          pass: rows.filter((row) => row.criteria[criterion].status === "pass")
            .length,
          fail: rows.filter((row) => row.criteria[criterion].status === "fail")
            .length,
          notApplicable: rows.filter(
            (row) => row.criteria[criterion].status === "not-applicable",
          ).length,
        },
      ]),
    ),
  };
}
