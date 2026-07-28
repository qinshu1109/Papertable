import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_TERMINAL_ERROR_MESSAGES,
  LEGAL_AGENT_TERMINAL_REASONS,
  agentTerminalErrorMessage,
  agentTerminalMessage,
  createAgentTerminalState,
  isLegalAgentTerminalState,
  type AgentRunResult,
  type AgentTerminalState,
  type StopReason,
} from "./agentTerminal";

const LEGAL_STATES: readonly AgentTerminalState[] = [
  { result: "completed", reason: "none" },
  { result: "partial", reason: "rounds_exhausted" },
  { result: "partial", reason: "calls_exhausted" },
  { result: "partial", reason: "wall_exhausted" },
  { result: "partial", reason: "tokens_exhausted" },
  { result: "partial", reason: "no_progress" },
  { result: "refused", reason: "insufficient_evidence" },
  { result: "failed", reason: "protocol_error" },
  { result: "failed", reason: "none" },
  { result: "aborted", reason: "user_abort" },
];

const ILLEGAL_STATES: ReadonlyArray<{
  result: AgentRunResult;
  reason: StopReason;
}> = [
  { result: "completed", reason: "protocol_error" },
  { result: "completed", reason: "insufficient_evidence" },
  { result: "partial", reason: "none" },
  { result: "partial", reason: "protocol_error" },
  { result: "refused", reason: "none" },
  { result: "refused", reason: "user_abort" },
  { result: "failed", reason: "rounds_exhausted" },
  { result: "failed", reason: "insufficient_evidence" },
  { result: "aborted", reason: "wall_exhausted" },
  { result: "aborted", reason: "none" },
];

test("legal-combination table contains every ADR-002 terminal state", () => {
  const flattened = Object.entries(LEGAL_AGENT_TERMINAL_REASONS).flatMap(
    ([result, reasons]) =>
      reasons.map((reason) => ({
        result: result as AgentRunResult,
        reason,
      })),
  );
  assert.deepEqual(flattened, LEGAL_STATES);
});

test("all legal combinations are accepted and have UI-facing messages", () => {
  for (const state of LEGAL_STATES) {
    assert.equal(
      isLegalAgentTerminalState(state.result, state.reason),
      true,
      `${state.result}/${state.reason}`,
    );
    assert.deepEqual(
      createAgentTerminalState(state.result, state.reason),
      state,
    );
    assert.ok(agentTerminalMessage(state).trim().length > 0);
  }
});

test("at least five illegal result/reason combinations are rejected", () => {
  assert.ok(ILLEGAL_STATES.length >= 5);
  for (const state of ILLEGAL_STATES) {
    assert.equal(
      isLegalAgentTerminalState(state.result, state.reason),
      false,
      `${state.result}/${state.reason}`,
    );
    assert.throws(
      () => createAgentTerminalState(state.result, state.reason),
      new RegExp(`${state.result}/${state.reason}`),
    );
  }
});

test("the discriminated union rejects illegal combinations at typecheck", () => {
  // @ts-expect-error completed/protocol_error is forbidden by AgentTerminalState.
  const illegal: AgentTerminalState = {
    result: "completed",
    reason: "protocol_error",
  };
  assert.equal(
    isLegalAgentTerminalState(illegal.result, illegal.reason),
    false,
  );
});

test("provider-empty and final-answer-empty use distinct stable codes and copy", () => {
  assert.notEqual(
    AGENT_TERMINAL_ERROR_MESSAGES["provider-empty-response"],
    AGENT_TERMINAL_ERROR_MESSAGES["final-answer-empty"],
  );
  assert.equal(
    agentTerminalErrorMessage("provider-empty-response"),
    "模型服务没有返回可处理的内容，请重试。",
  );
  assert.equal(
    agentTerminalErrorMessage("final-answer-empty"),
    "模型回答已结束，但没有可显示的最终文本，请重试。",
  );
});
