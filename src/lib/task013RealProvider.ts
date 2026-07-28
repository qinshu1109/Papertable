import type {
  BuiltContext,
  ProviderCapability,
  ProviderMessage,
  ProviderStreamEvent,
  ToolCall,
} from "../types";
import { AgentRunFailure, runAgentTurn, type AgentRuntime } from "./agent";
import { appendAgentBudgetTerminal } from "./agentBudgetAudit";
import type { AppendAgentStepInput } from "./agentEvents";
import type { AgentTerminalState } from "./agentTerminal";
import type { NoteHit } from "./notes/types";
import { completeModel, streamModel } from "./provider/http";
import {
  TASK_013_CRITERIA,
  type Task013AcceptanceRow,
  type Task013Criterion,
  type Task013CriterionResult,
} from "./task013Acceptance";
import { TASK013_SYNTHETIC_EVIDENCE } from "./task013Runtime";

interface RealScenario {
  id: string;
  prompt: string;
  expectedTools: Array<"search_notes" | "read_notes">;
  expectedTerminal: AgentTerminalState;
  budgetLimits?: { rounds?: number };
  attachmentCardId?: string;
  expectDuplicateStop?: boolean;
}

const REAL_SCENARIOS: RealScenario[] = [
  {
    id: "natural-convergence",
    prompt: [
      "This is a safe synthetic acceptance case.",
      "Call search_notes for ORBIT-97, read the returned chunk, then answer only from that chunk.",
    ].join(" "),
    expectedTools: ["search_notes", "read_notes"],
    expectedTerminal: { result: "completed", reason: "none" },
  },
  {
    id: "budget-exhaustion",
    prompt: [
      "This is a safe synthetic acceptance case with a two-round host budget.",
      "Call search_notes for ORBIT-97, then read the returned chunk.",
      "After the host ends exploration, synthesize only from the read evidence.",
    ].join(" "),
    expectedTools: ["search_notes", "read_notes"],
    expectedTerminal: { result: "partial", reason: "rounds_exhausted" },
    budgetLimits: { rounds: 2 },
  },
  {
    id: "no-progress-lure",
    prompt: [
      "This is a duplicate-call acceptance case.",
      "Call search_notes with query exactly REPEAT-ORBIT three times in separate model rounds.",
      "The synthetic search intentionally returns zero hits.",
      "Do not answer after the first or second tool result: immediately issue the identical search_notes call again.",
      "Do not call read_notes and do not change the query after the host reminder.",
    ].join(" "),
    expectedTools: ["search_notes"],
    expectedTerminal: { result: "refused", reason: "insufficient_evidence" },
    expectDuplicateStop: true,
  },
  {
    id: "attachment-citation",
    prompt: [
      "This is a safe synthetic attachment case.",
      "Call search_notes for ORBIT-97, read the returned attachment chunk, and cite only that chunk.",
    ].join(" "),
    expectedTools: ["search_notes", "read_notes"],
    expectedTerminal: { result: "completed", reason: "none" },
    attachmentCardId: "task-013-real-card",
  },
];

function built(prompt: string): BuiltContext {
  return {
    answerMode: "general",
    system: [
      "TASK-013 safe synthetic acceptance. Follow the requested native-tool sequence exactly.",
    ],
    messages: [
      {
        role: "system",
        content:
          "TASK-013 safe synthetic acceptance. Follow the requested native-tool sequence exactly.",
      },
      { role: "user", content: prompt },
    ],
    provenance: [],
    excluded: [],
    estimatedTokens: 64,
  };
}

function criterion(passed: boolean, detail?: string): Task013CriterionResult {
  return {
    status: passed ? "pass" : "fail",
    ...(!passed && detail ? { detail } : {}),
  };
}

function criteria(
  checks: Record<Task013Criterion, boolean>,
  details: Partial<Record<Task013Criterion, string>>,
): Record<Task013Criterion, Task013CriterionResult> {
  return Object.fromEntries(
    TASK_013_CRITERIA.map((name) => [
      name,
      criterion(checks[name], details[name]),
    ]),
  ) as Record<Task013Criterion, Task013CriterionResult>;
}

function syntheticHit(): NoteHit {
  return {
    chunk: TASK013_SYNTHETIC_EVIDENCE,
    score: 10,
    snippet: TASK013_SYNTHETIC_EVIDENCE.text,
  };
}

async function runExternalScenario(
  capability: ProviderCapability,
  scenario: RealScenario,
): Promise<Task013AcceptanceRow> {
  const audit: AppendAgentStepInput[] = [];
  const hostTools: Array<{
    name: "search_notes" | "read_notes";
    signature: string;
    attachmentCardId?: string;
  }> = [];
  const authorized = new Set<string>();
  const unauthorizedReads: string[] = [];
  const visible: string[] = [];
  const persistence = {
    runId: `task-013-real-${scenario.id}`,
    turnId: `task-013-real-${scenario.id}`,
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
      audit.push(structuredClone(step));
    },
  };
  const runtime: AgentRuntime = {
    complete: completeModel,
    stream: streamModel,
    search: async (input) => {
      hostTools.push({
        name: "search_notes",
        signature: JSON.stringify({
          query: input.query,
          limit: input.limit,
        }),
        ...(input.attachmentCardId
          ? { attachmentCardId: input.attachmentCardId }
          : {}),
      });
      authorized.add(TASK013_SYNTHETIC_EVIDENCE.id);
      return scenario.expectDuplicateStop ? [] : [syntheticHit()];
    },
    read: async (input) => {
      hostTools.push({
        name: "read_notes",
        signature: JSON.stringify([...input.chunkIds].sort()),
        ...(input.attachmentCardId
          ? { attachmentCardId: input.attachmentCardId }
          : {}),
      });
      for (const id of input.chunkIds)
        if (!authorized.has(id)) unauthorizedReads.push(id);
      return input.chunkIds.includes(TASK013_SYNTHETIC_EVIDENCE.id)
        ? [TASK013_SYNTHETIC_EVIDENCE]
        : [];
    },
    now: Date.now,
    sleep: (delayMs, signal) =>
      new Promise<void>((resolve, reject) => {
        if (signal.aborted) return reject(signal.reason);
        const timer = setTimeout(resolve, delayMs);
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(signal.reason);
          },
          { once: true },
        );
      }),
  };
  let terminal: AgentTerminalState | undefined;
  let readCount = 0;
  try {
    const outcome = await runAgentTurn({
      built: built(scenario.prompt),
      projectId: "task-013-project",
      libraryIds: ["task-013-library"],
      attachmentCardId: scenario.attachmentCardId,
      capability,
      signal: new AbortController().signal,
      onPhase: () => undefined,
      onToken: (event) => visible.push(event.text),
      budgetLimits: scenario.budgetLimits,
      runtime,
      audit: persistence,
      protocolRecovery: {
        invalidateAndReprobe: async () => capability,
      },
    });
    terminal = outcome.terminal;
    readCount = outcome.readChunks.length;
    await appendAgentBudgetTerminal(
      persistence,
      outcome.trace,
      terminal,
      Date.now(),
    );
  } catch (cause) {
    if (cause instanceof AgentRunFailure) {
      terminal = cause.terminal;
      readCount = cause.readChunks.length;
      await appendAgentBudgetTerminal(
        persistence,
        cause.trace,
        terminal,
        Date.now(),
      );
    }
  }
  const actualTools = hostTools.map((call) => call.name);
  const signatures = hostTools.map((call) => `${call.name}:${call.signature}`);
  const duplicateEvents = audit
    .map((step) => step.event.message)
    .filter((event) => event.kind === "duplicate-call-detected");
  const terminalPersisted = audit.some(
    (step) => step.event.message.kind === "terminal",
  );
  const readNeeded = scenario.expectedTools.includes("read_notes");
  const readPersisted = audit.some(
    (step) => step.event.message.kind === "read-completed",
  );
  const frozenScope = hostTools.every(
    (call) =>
      !scenario.attachmentCardId ||
      call.attachmentCardId === scenario.attachmentCardId,
  );
  const duplicateOccurrences = duplicateEvents.map((event) =>
    event.kind === "duplicate-call-detected" ? event.occurrences : 0,
  );
  const avoidedNoProgressLure =
    Boolean(scenario.expectDuplicateStop) &&
    duplicateOccurrences.length === 0 &&
    terminal?.result === "completed" &&
    terminal.reason === "none";
  const handledNoProgressLure =
    Boolean(scenario.expectDuplicateStop) &&
    JSON.stringify(duplicateOccurrences) === JSON.stringify([2, 3]) &&
    terminal?.result === "refused" &&
    terminal.reason === "insufficient_evidence";
  const terminalMatches =
    avoidedNoProgressLure ||
    handledNoProgressLure ||
    (!scenario.expectDuplicateStop &&
      JSON.stringify(terminal) === JSON.stringify(scenario.expectedTerminal));
  const duplicatesHandled =
    new Set(signatures).size === signatures.length &&
    (!scenario.expectDuplicateStop ||
      avoidedNoProgressLure ||
      handledNoProgressLure);

  return {
    id: scenario.id,
    source: "real-provider",
    model: capability.model,
    execution: "external",
    criteria: criteria(
      {
        "correct-tool-calls":
          JSON.stringify(actualTools) ===
          JSON.stringify(scenario.expectedTools),
        "correct-terminal-state": terminalMatches,
        "persisted-evidence":
          terminalPersisted &&
          (!readNeeded || (readPersisted && readCount > 0)),
        "no-unauthorized-reads": unauthorizedReads.length === 0 && frozenScope,
        "no-unhandled-duplicate-calls": duplicatesHandled,
        "no-two-stage-on-protocol-failure":
          terminal?.reason !== "protocol_error" || visible.length === 0,
      },
      {
        "correct-tool-calls": `expected ${scenario.expectedTools.join(",")}; observed ${actualTools.join(",")}`,
        "correct-terminal-state": scenario.expectDuplicateStop
          ? `expected completed/none when the lure is avoided or refused/insufficient_evidence after occurrences 2 and 3; observed ${JSON.stringify(terminal)}`
          : `expected ${JSON.stringify(scenario.expectedTerminal)}; observed ${JSON.stringify(terminal)}`,
        "persisted-evidence":
          "terminal or actual read evidence was not persisted",
        "no-unauthorized-reads":
          "read authority or frozen attachment scope was violated",
        "no-unhandled-duplicate-calls":
          "duplicate call handling did not stop at occurrences 2 and 3",
        "no-two-stage-on-protocol-failure":
          "a protocol error produced visible answer text",
      },
    ),
  };
}

function injectedStream(events: ProviderStreamEvent[]) {
  return (async function* () {
    yield* events;
  })();
}

async function runChineseSynthesisToolLock(
  capability: ProviderCapability,
): Promise<Task013AcceptanceRow> {
  const messages: ProviderMessage[] = [
    {
      role: "system",
      content:
        "你正在进行最终综合。工具已禁用；只使用历史工具结果输出一份简洁的中文最终正文，不得调用工具。",
    },
    {
      role: "user",
      content: "基于已经读取的多份材料总结共同结论，并明确说明证据覆盖有限。",
    },
  ];
  for (let index = 1; index <= 4; index += 1) {
    const callId = `task-013-synthesis-history-${index}`;
    messages.push({
      role: "assistant",
      content: null,
      toolCalls: [
        {
          id: callId,
          name: index % 2 === 1 ? "search_notes" : "read_notes",
          arguments:
            index % 2 === 1
              ? `{"query":"中文多片段证据 ${index}"}`
              : `{"chunkIds":["task-013-evidence"]}`,
        },
      ],
    });
    messages.push({
      role: "tool",
      toolCallId: callId,
      content: JSON.stringify({
        chunks: [
          {
            chunkId: "task-013-evidence",
            content: TASK013_SYNTHETIC_EVIDENCE.text,
          },
        ],
      }),
    });
  }

  const visible: string[] = [];
  const toolCalls: ProviderStreamEvent[] = [];
  let finishReason: string | undefined;
  for await (const event of streamModel({
    task: "agent",
    messages,
    signal: new AbortController().signal,
    toolChoice: "none",
  })) {
    if (event.type === "token") visible.push(event.text);
    if (event.type === "tool-call-delta") toolCalls.push(event);
    if (event.type === "done") finishReason = event.finishReason;
  }
  const hasAnswer = visible.join("").trim().length > 0;
  const toolLockHeld = toolCalls.length === 0 && finishReason !== "tool_calls";
  return {
    id: "chinese-multi-tool-history-synthesis-lock",
    source: "real-provider",
    model: capability.model,
    execution: "external",
    criteria: {
      "correct-tool-calls": criterion(
        toolLockHeld,
        "tool_choice=none 的中文最终综合仍返回了工具调用",
      ),
      "correct-terminal-state": criterion(
        hasAnswer && toolLockHeld,
        "中文最终综合没有返回可显示正文",
      ),
      "persisted-evidence": { status: "not-applicable" },
      "no-unauthorized-reads": criterion(
        toolCalls.length === 0,
        "最终综合试图发起新的读取",
      ),
      "no-unhandled-duplicate-calls": criterion(
        toolCalls.length === 0,
        "最终综合重复了历史工具调用",
      ),
      "no-two-stage-on-protocol-failure": { status: "not-applicable" },
    },
  };
}

async function runInjectedFailure(
  capability: ProviderCapability,
  input: { id: string; exhaustedSynthesis: boolean },
): Promise<Task013AcceptanceRow> {
  const audit: AppendAgentStepInput[] = [];
  let hostSearches = 0;
  let hostReads = 0;
  let terminal: AgentTerminalState | undefined;
  let evidenceCount = 0;
  const visible: string[] = [];
  const malformed: ProviderStreamEvent[] = [
    {
      type: "tool-call-delta",
      index: 0,
      id: "task-013-bad",
      name: "",
      arguments: '{"query":"ORBIT-97"}',
    },
    {
      type: "done",
      finishReason: "tool_calls",
      gatewayResponseShape: "openai-chat-completions-v1",
    },
  ];
  const search: ProviderStreamEvent[] = [
    {
      type: "tool-call-delta",
      index: 0,
      id: "task-013-injected-search",
      name: "search_notes",
      arguments: '{"query":"ORBIT-97"}',
    },
    {
      type: "done",
      finishReason: "tool_calls",
      gatewayResponseShape: "openai-chat-completions-v1",
    },
  ];
  const read: ProviderStreamEvent[] = [
    {
      type: "tool-call-delta",
      index: 0,
      id: "task-013-injected-read",
      name: "read_notes",
      arguments: `{"chunkIds":["${TASK013_SYNTHETIC_EVIDENCE.id}"]}`,
    },
    {
      type: "done",
      finishReason: "tool_calls",
      gatewayResponseShape: "openai-chat-completions-v1",
    },
  ];
  const empty: ProviderStreamEvent[] = [
    {
      type: "done",
      finishReason: "stop",
      gatewayResponseShape: "openai-chat-completions-v1",
    },
  ];
  let request = 0;
  const rounds = input.exhaustedSynthesis
    ? [search, read, ...Array.from({ length: 6 }, () => empty)]
    : [malformed, malformed, malformed];
  const persistence = {
    runId: `task-013-real-${input.id}`,
    turnId: `task-013-real-${input.id}`,
    appendStep: async (step: AppendAgentStepInput) => {
      audit.push(structuredClone(step));
    },
  };
  const runtime: AgentRuntime = {
    complete: async () => ({
      content: "",
      toolCalls: input.exhaustedSynthesis
        ? []
        : ([
            {
              id: "task-013-bad-complete",
              name: "",
              arguments: '{"query":"ORBIT-97"}',
            },
          ] as unknown as ToolCall[]),
    }),
    stream: () => injectedStream(rounds[request++] ?? empty),
    search: async () => {
      hostSearches += 1;
      return [syntheticHit()];
    },
    read: async () => {
      hostReads += 1;
      return [TASK013_SYNTHETIC_EVIDENCE];
    },
    now: () => 100,
    sleep: async () => undefined,
  };
  try {
    await runAgentTurn({
      built: built("TASK-013 deterministic protocol injection."),
      projectId: "task-013-project",
      libraryIds: ["task-013-library"],
      capability,
      signal: new AbortController().signal,
      onPhase: () => undefined,
      onToken: (event) => visible.push(event.text),
      budgetLimits: input.exhaustedSynthesis ? { rounds: 2 } : { rounds: 10 },
      runtime,
      audit: persistence,
      protocolRecovery: {
        invalidateAndReprobe: async () => capability,
      },
    });
  } catch (cause) {
    if (cause instanceof AgentRunFailure) {
      terminal = cause.terminal;
      evidenceCount = cause.readChunks.length;
      await appendAgentBudgetTerminal(persistence, cause.trace, terminal, 101);
    }
  }
  const expectedTools = input.exhaustedSynthesis
    ? { searches: 1, reads: 1 }
    : { searches: 0, reads: 0 };
  const protocolEvents = audit.filter(
    (step) => step.event.message.kind === "protocol-repaired",
  );
  const terminalPersisted = audit.some(
    (step) => step.event.message.kind === "terminal",
  );
  const readPersisted = audit.some(
    (step) => step.event.message.kind === "read-completed",
  );
  const expectedEvidence = input.exhaustedSynthesis;

  return {
    id: input.id,
    source: "real-provider",
    model: capability.model,
    execution: "injected",
    criteria: criteria(
      {
        "correct-tool-calls":
          hostSearches === expectedTools.searches &&
          hostReads === expectedTools.reads,
        "correct-terminal-state":
          terminal?.result === "failed" && terminal.reason === "protocol_error",
        "persisted-evidence":
          terminalPersisted &&
          (!expectedEvidence || (readPersisted && evidenceCount > 0)),
        "no-unauthorized-reads": hostReads === expectedTools.reads,
        "no-unhandled-duplicate-calls": true,
        "no-two-stage-on-protocol-failure":
          visible.length === 0 &&
          (input.exhaustedSynthesis || protocolEvents.length > 0),
      },
      {
        "correct-tool-calls":
          "injected failure executed an unexpected host tool",
        "correct-terminal-state":
          "injected failure did not end at failed/protocol_error",
        "persisted-evidence":
          "injected failure did not preserve terminal/read evidence",
        "no-unauthorized-reads":
          "injected protocol failure reached an unauthorized read",
        "no-unhandled-duplicate-calls": "",
        "no-two-stage-on-protocol-failure":
          "injected protocol failure emitted an answer or skipped native repair evidence",
      },
    ),
  };
}

export async function runTask013RealProviderMatrix(
  capability: ProviderCapability,
): Promise<Task013AcceptanceRow[]> {
  const rows: Task013AcceptanceRow[] = [];
  for (const scenario of REAL_SCENARIOS)
    rows.push(await runExternalScenario(capability, scenario));
  rows.push(await runChineseSynthesisToolLock(capability));
  rows.push(
    await runInjectedFailure(capability, {
      id: "exhaustion-failed-repair-injection",
      exhaustedSynthesis: true,
    }),
  );
  rows.push(
    await runInjectedFailure(capability, {
      id: "protocol-failure-injection",
      exhaustedSynthesis: false,
    }),
  );
  return rows;
}
