import type {
  BuiltContext,
  ProviderCapability,
  ProviderStreamEvent,
  ToolCall,
} from "../types";
import {
  AgentRunFailure,
  controlledCitations,
  runAgentTurn,
  type AgentRuntime,
} from "./agent";
import { appendAgentBudgetTerminal } from "./agentBudgetAudit";
import type { AppendAgentStepInput } from "./agentEvents";
import type { AgentTerminalState } from "./agentTerminal";
import type { NoteChunk, NoteHit } from "./notes/types";
import {
  TASK_013_CRITERIA,
  type Task013AcceptanceRow,
  type Task013Criterion,
  type Task013CriterionResult,
} from "./task013Acceptance";

export const TASK013_SYNTHETIC_EVIDENCE: NoteChunk = {
  id: "task-013-evidence",
  libraryId: "task-013-library",
  documentId: "task-013-document",
  documentVersionHash: "task-013-hash",
  relativePath: "synthetic/task-013-evidence.md",
  titlePath: ["Synthetic", "TASK-013 evidence"],
  tags: ["task-013"],
  ordinal: 0,
  start: 0,
  end: 46,
  text: "Synthetic acceptance fact: ORBIT-97 is the verified code.",
};

const EVIDENCE_HIT: NoteHit = {
  chunk: TASK013_SYNTHETIC_EVIDENCE,
  score: 10,
  snippet: TASK013_SYNTHETIC_EVIDENCE.text,
};

export function task013NativeCapability(
  model = "deterministic-flagship",
): ProviderCapability {
  return {
    schemaVersion: 1,
    baseUrl: "http://127.0.0.1/task-013",
    model,
    mode: "native-tools",
    protocolAdapterVersion: "openai-native-tools-v2",
    gatewayResponseShape: "openai-chat-completions-v1",
    toolCallEmission: { status: "passed" },
    toolResultAcceptance: { status: "passed" },
    streamingToolCallDelta: { status: "passed" },
    testedAt: 1,
    expiresAt: Number.MAX_SAFE_INTEGER,
    ttlMs: 86_400_000,
  };
}

function built(prompt: string): BuiltContext {
  return {
    answerMode: "general",
    system: [
      "TASK-013 synthetic acceptance. Use only host tools and evidence.",
    ],
    messages: [
      {
        role: "system",
        content:
          "TASK-013 synthetic acceptance. Use only host tools and evidence.",
      },
      { role: "user", content: prompt },
    ],
    provenance: [],
    excluded: [],
    estimatedTokens: 32,
  };
}

function stream(events: ProviderStreamEvent[]) {
  return (async function* () {
    yield* events;
  })();
}

function toolRound(call: ToolCall): ProviderStreamEvent[] {
  return [
    {
      type: "tool-call-delta",
      index: 0,
      id: call.id,
      name: call.name,
      arguments: call.arguments,
    },
    {
      type: "done",
      finishReason: "tool_calls",
      gatewayResponseShape: "openai-chat-completions-v1",
    },
  ];
}

function finalRound(answer: string): ProviderStreamEvent[] {
  return answer
    ? [
        { type: "token", text: answer, channel: "final" },
        {
          type: "done",
          finishReason: "stop",
          gatewayResponseShape: "openai-chat-completions-v1",
        },
      ]
    : [
        {
          type: "done",
          finishReason: "stop",
          gatewayResponseShape: "openai-chat-completions-v1",
        },
      ];
}

interface RuntimeObservation {
  hostToolCalls: Array<{
    name: "search_notes" | "read_notes";
    signature: string;
    attachmentCardId?: string;
  }>;
  authorizedChunkIds: Set<string>;
  unauthorizedReadAttempts: string[];
  audit: AppendAgentStepInput[];
  visible: string[];
}

function observedRuntime(
  rounds: ProviderStreamEvent[][],
  observation: RuntimeObservation,
  options: {
    malformedCompletion?: boolean;
  } = {},
): AgentRuntime {
  let round = 0;
  return {
    complete: async () => ({
      content: "",
      toolCalls: options.malformedCompletion
        ? ([
            {
              id: "task-013-malformed-complete",
              name: "",
              arguments: '{"query":"synthetic"}',
            },
          ] as unknown as ToolCall[])
        : [],
    }),
    stream: () => stream(rounds[round++] ?? finalRound("")),
    search: async (input) => {
      observation.hostToolCalls.push({
        name: "search_notes",
        signature: JSON.stringify({
          query: input.query,
          limit: input.limit,
        }),
        ...(input.attachmentCardId
          ? { attachmentCardId: input.attachmentCardId }
          : {}),
      });
      observation.authorizedChunkIds.add(TASK013_SYNTHETIC_EVIDENCE.id);
      return [EVIDENCE_HIT];
    },
    read: async (input) => {
      observation.hostToolCalls.push({
        name: "read_notes",
        signature: JSON.stringify([...input.chunkIds].sort()),
        ...(input.attachmentCardId
          ? { attachmentCardId: input.attachmentCardId }
          : {}),
      });
      for (const id of input.chunkIds)
        if (!observation.authorizedChunkIds.has(id))
          observation.unauthorizedReadAttempts.push(id);
      return input.chunkIds.includes(TASK013_SYNTHETIC_EVIDENCE.id)
        ? [TASK013_SYNTHETIC_EVIDENCE]
        : [];
    },
    now: () => 100,
    sleep: async () => undefined,
  };
}

function criterion(passed: boolean, detail?: string): Task013CriterionResult {
  return {
    status: passed ? "pass" : "fail",
    ...(!passed && detail ? { detail } : {}),
  };
}

function allCriteria(
  checks: Record<Task013Criterion, boolean>,
  details: Partial<Record<Task013Criterion, string>> = {},
): Record<Task013Criterion, Task013CriterionResult> {
  return Object.fromEntries(
    TASK_013_CRITERIA.map((name) => [
      name,
      criterion(checks[name], details[name]),
    ]),
  ) as Record<Task013Criterion, Task013CriterionResult>;
}

interface RuntimeScenario {
  id: string;
  prompt: string;
  rounds: ProviderStreamEvent[][];
  expectedTools: Array<"search_notes" | "read_notes">;
  expectedTerminal: AgentTerminalState;
  budgetLimits?: { rounds?: number; calls?: number };
  attachmentCardId?: string;
  expectReadEvidence?: boolean;
  expectDuplicateStop?: boolean;
  protocolFailure?: boolean;
  malformedCompletion?: boolean;
}

const SEARCH_CALL: ToolCall = {
  id: "task-013-search",
  name: "search_notes",
  arguments: '{"query":"ORBIT-97","limit":4}',
};
const READ_CALL: ToolCall = {
  id: "task-013-read",
  name: "read_notes",
  arguments: `{"chunkIds":["${TASK013_SYNTHETIC_EVIDENCE.id}"]}`,
};

function deterministicScenarios(): RuntimeScenario[] {
  const malformed = [
    {
      type: "tool-call-delta",
      index: 0,
      id: "task-013-malformed",
      name: "",
      arguments: '{"query":"ORBIT-97"}',
    },
    {
      type: "done",
      finishReason: "tool_calls",
      gatewayResponseShape: "openai-chat-completions-v1",
    },
  ] satisfies ProviderStreamEvent[];
  return [
    {
      id: "natural-convergence",
      prompt: "Read the synthetic note and report its verified code.",
      rounds: [
        toolRound(SEARCH_CALL),
        toolRound(READ_CALL),
        finalRound(
          `The verified code is ORBIT-97. [[source:${TASK013_SYNTHETIC_EVIDENCE.id}]]`,
        ),
      ],
      expectedTools: ["search_notes", "read_notes"],
      expectedTerminal: { result: "completed", reason: "none" },
      expectReadEvidence: true,
    },
    {
      id: "exhaustion-successful-synthesis",
      prompt:
        "Read the synthetic note, then synthesize within the fixed budget.",
      rounds: [
        toolRound(SEARCH_CALL),
        toolRound(READ_CALL),
        finalRound(
          `Partial evidence: ORBIT-97. [[source:${TASK013_SYNTHETIC_EVIDENCE.id}]]`,
        ),
      ],
      expectedTools: ["search_notes", "read_notes"],
      expectedTerminal: { result: "partial", reason: "rounds_exhausted" },
      budgetLimits: { rounds: 2 },
      expectReadEvidence: true,
    },
    {
      id: "exhaustion-failed-repair",
      prompt: "Read the synthetic note, then exercise empty synthesis repair.",
      rounds: [
        toolRound(SEARCH_CALL),
        toolRound(READ_CALL),
        ...Array.from({ length: 6 }, () => finalRound("")),
      ],
      expectedTools: ["search_notes", "read_notes"],
      expectedTerminal: { result: "failed", reason: "protocol_error" },
      budgetLimits: { rounds: 2 },
      expectReadEvidence: true,
      protocolFailure: true,
    },
    {
      id: "no-progress-lure",
      prompt: "Repeat the exact same synthetic search until the host stops it.",
      rounds: [
        toolRound({ ...SEARCH_CALL, id: "duplicate-search-1" }),
        toolRound({ ...SEARCH_CALL, id: "duplicate-search-2" }),
        toolRound({ ...SEARCH_CALL, id: "duplicate-search-3" }),
        finalRound("No further progress is possible."),
      ],
      expectedTools: ["search_notes"],
      expectedTerminal: {
        result: "refused",
        reason: "insufficient_evidence",
      },
      expectDuplicateStop: true,
    },
    {
      id: "attachment-citation",
      prompt: "Read only the current synthetic attachment and cite its code.",
      rounds: [
        toolRound(SEARCH_CALL),
        toolRound(READ_CALL),
        finalRound(
          `Attachment code: ORBIT-97. [[source:${TASK013_SYNTHETIC_EVIDENCE.id}]]`,
        ),
      ],
      expectedTools: ["search_notes", "read_notes"],
      expectedTerminal: { result: "completed", reason: "none" },
      attachmentCardId: "task-013-card",
      expectReadEvidence: true,
    },
    {
      id: "protocol-failure-injection",
      prompt: "Exercise the native protocol failure boundary.",
      rounds: [malformed, malformed, malformed],
      expectedTools: [],
      expectedTerminal: { result: "failed", reason: "protocol_error" },
      protocolFailure: true,
      malformedCompletion: true,
      budgetLimits: { rounds: 10 },
    },
  ];
}

async function executeScenario(
  scenario: RuntimeScenario,
): Promise<Task013AcceptanceRow> {
  const observation: RuntimeObservation = {
    hostToolCalls: [],
    authorizedChunkIds: new Set(),
    unauthorizedReadAttempts: [],
    audit: [],
    visible: [],
  };
  const capability = task013NativeCapability();
  const audit = {
    runId: `task-013-${scenario.id}`,
    turnId: `task-013-${scenario.id}`,
    hostScope: {
      projectId: "task-013-project",
      libraryIds: ["task-013-library"],
      ...(scenario.attachmentCardId
        ? {
            cardId: scenario.attachmentCardId,
            attachmentScope: `attachment:${scenario.attachmentCardId}`,
          }
        : {}),
    },
    appendStep: async (step: AppendAgentStepInput) => {
      observation.audit.push(structuredClone(step));
    },
  };
  let terminal: AgentTerminalState | undefined;
  let readChunks: NoteChunk[] = [];
  try {
    const outcome = await runAgentTurn({
      built: built(scenario.prompt),
      projectId: "task-013-project",
      libraryIds: ["task-013-library"],
      attachmentCardId: scenario.attachmentCardId,
      capability,
      signal: new AbortController().signal,
      onPhase: () => undefined,
      onToken: (event) => observation.visible.push(event.text),
      runtime: observedRuntime(scenario.rounds, observation, {
        malformedCompletion: scenario.malformedCompletion,
      }),
      budgetLimits: scenario.budgetLimits,
      audit,
      protocolRecovery: {
        invalidateAndReprobe: async () => capability,
      },
    });
    terminal = outcome.terminal;
    readChunks = outcome.readChunks;
    const answer = observation.visible.join("");
    const cited = controlledCitations(answer, readChunks);
    await appendAgentBudgetTerminal(audit, outcome.trace, terminal, 101, {
      answer: cited.content,
      citations: cited.citations,
    });
  } catch (cause) {
    if (cause instanceof AgentRunFailure) {
      terminal = cause.terminal;
      readChunks = cause.readChunks;
      await appendAgentBudgetTerminal(audit, cause.trace, terminal, 101);
    }
  }

  const actualTools = observation.hostToolCalls.map((call) => call.name);
  const duplicateEvents = observation.audit
    .map((step) => step.event.message)
    .filter((event) => event.kind === "duplicate-call-detected");
  const actualSignatures = observation.hostToolCalls.map(
    (call) => `${call.name}:${call.signature}`,
  );
  const duplicateHostExecution =
    new Set(actualSignatures).size !== actualSignatures.length;
  const terminalPersisted = observation.audit.some(
    (step) =>
      step.event.message.kind === "terminal" &&
      JSON.stringify(step.event.message.terminal) ===
        JSON.stringify(scenario.expectedTerminal),
  );
  const readPersisted = observation.audit.some(
    (step) => step.event.message.kind === "read-completed",
  );
  const attachmentScopePreserved = observation.hostToolCalls.every(
    (call) =>
      !scenario.attachmentCardId ||
      call.attachmentCardId === scenario.attachmentCardId,
  );
  const protocolActions = observation.audit.filter(
    (step) => step.event.message.kind === "protocol-repaired",
  );
  const protocolStayedNative =
    !scenario.protocolFailure ||
    (protocolActions.length > 0 && observation.hostToolCalls.length === 0) ||
    scenario.id === "exhaustion-failed-repair";
  const noVisibleFailureAnswer =
    scenario.expectedTerminal.result !== "failed" ||
    observation.visible.join("").trim().length === 0;

  return {
    id: scenario.id,
    source: "deterministic-runtime",
    criteria: allCriteria(
      {
        "correct-tool-calls":
          JSON.stringify(actualTools) ===
          JSON.stringify(scenario.expectedTools),
        "correct-terminal-state":
          JSON.stringify(terminal) ===
          JSON.stringify(scenario.expectedTerminal),
        "persisted-evidence":
          terminalPersisted &&
          (!scenario.expectReadEvidence ||
            (readPersisted && readChunks.length > 0)),
        "no-unauthorized-reads":
          observation.unauthorizedReadAttempts.length === 0 &&
          attachmentScopePreserved,
        "no-unhandled-duplicate-calls":
          !duplicateHostExecution &&
          (!scenario.expectDuplicateStop ||
            JSON.stringify(
              duplicateEvents.map((event) =>
                event.kind === "duplicate-call-detected"
                  ? event.occurrences
                  : 0,
              ),
            ) === JSON.stringify([2, 3])),
        "no-two-stage-on-protocol-failure":
          protocolStayedNative && noVisibleFailureAnswer,
      },
      {
        "correct-tool-calls": `expected ${scenario.expectedTools.join(",") || "no tools"}; observed ${actualTools.join(",") || "no tools"}`,
        "correct-terminal-state": `expected ${JSON.stringify(scenario.expectedTerminal)}; observed ${JSON.stringify(terminal)}`,
        "persisted-evidence":
          "terminal/read evidence was not preserved in schema-v1 audit events",
        "no-unauthorized-reads":
          "a read escaped search authority or the frozen attachment scope",
        "no-unhandled-duplicate-calls":
          "a duplicate reached the host or did not produce occurrences 2 and 3",
        "no-two-stage-on-protocol-failure":
          "protocol failure produced retrieval/downgrade behavior or visible answer text",
      },
    ),
  };
}

export async function runTask013DeterministicRuntimeMatrix(): Promise<
  Task013AcceptanceRow[]
> {
  const rows: Task013AcceptanceRow[] = [];
  for (const scenario of deterministicScenarios())
    rows.push(await executeScenario(scenario));
  return rows;
}
