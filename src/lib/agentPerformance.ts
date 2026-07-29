import type { AgentRunPerformance } from "../types";

export function agentRunPerformance(input: {
  sentAt: number;
  firstModelRequestAt?: number;
  firstVisibleAt: number;
  finishedAt: number;
}): AgentRunPerformance {
  const elapsed = (at: number) => Math.max(0, Math.round(at - input.sentAt));
  return {
    ...(input.firstModelRequestAt === undefined
      ? {}
      : { preflightMs: elapsed(input.firstModelRequestAt) }),
    firstVisibleMs: elapsed(input.firstVisibleAt),
    totalMs: elapsed(input.finishedAt),
  };
}
