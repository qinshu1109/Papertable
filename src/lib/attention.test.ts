import assert from "node:assert/strict";
import test from "node:test";
import {
  PROPOSAL_COOL_MS,
  PROPOSAL_PURGE_MS,
  SESSION_IDLE_MS,
  applyProposalLifecycle,
  collectSessionCandidates,
  ensureProjectSession,
  generateSessionProposals,
  localDateKey,
  processPriorSessions,
  recoverSessions,
} from "./attention";
import type {
  Card,
  InteractionEvent,
  Proposal,
  SessionBoundary,
} from "../types";

let sequence = 0;
const id = (prefix: string) => `${prefix}-${++sequence}`;
const at = (day: number, hour = 10) =>
  new Date(2026, 6, day, hour, 0, 0, 0).getTime();

const card = (
  cardId: string,
  projectId = "p",
  concepts: string[] = [],
): Card => ({
  id: cardId,
  projectId,
  title: `${cardId} 标题`,
  turns: [],
  favorite: false,
  unread: false,
  concepts,
  createdAt: at(24),
});

const session = (projectId = "p", day = 24): SessionBoundary => ({
  id: `s-${projectId}-${day}`,
  projectId,
  localDate: localDateKey(at(day)),
  startedAt: at(day),
  lastActiveAt: at(day, 11),
  endedAt: at(day, 12),
});

const event = (
  type: InteractionEvent["type"],
  overrides: Partial<InteractionEvent> = {},
): InteractionEvent => ({
  id: id("event"),
  projectId: "p",
  sessionId: "s-p-24",
  type,
  createdAt: at(24, 11),
  targetCardId: "root",
  sourceCardId: "root",
  ...overrides,
});

function proposal(overrides: Partial<Proposal> = {}): Proposal {
  const createdAt = at(24);
  return {
    id: id("proposal"),
    projectId: "p",
    sessionId: "s-p-24",
    title: "方向",
    explorationQuestion: "下一步该先验证什么？",
    reason: "测试",
    sourceAnchorIds: [],
    suggestedParentCardId: "root",
    suggestedRelation: "child",
    evidence: "human-signals",
    status: "queued",
    candidateKey: id("candidate"),
    signalScore: 6,
    signalEventIds: [],
    createdAt,
    lastSignalAt: createdAt,
    expiresAt: createdAt + PROPOSAL_COOL_MS,
    purgeAt: createdAt + PROPOSAL_PURGE_MS,
    ...overrides,
  };
}

test("session boundaries split on idle, local date and startup recovery", () => {
  const first = ensureProjectSession([], "p", at(24, 10), id);
  assert.equal(first.started, true);
  const same = ensureProjectSession(
    first.sessions,
    "p",
    at(24, 10) + 60_000,
    id,
  );
  assert.equal(same.started, false);
  assert.equal(same.session.id, first.session.id);
  const idle = ensureProjectSession(
    same.sessions,
    "p",
    at(24, 10) + 60_000 + SESSION_IDLE_MS + 1,
    id,
  );
  assert.equal(idle.started, true);
  assert.equal(idle.closed?.endReason, "idle");

  const recovered = recoverSessions(
    [{ ...idle.session, endedAt: undefined, localDate: localDateKey(at(24)) }],
    at(25, 9),
  );
  assert.equal(recovered[0].endReason, "startup-recovery");
});

test("signal aggregation deduplicates and a favorite cancellation removes its signal", () => {
  const events = [
    event("favorite-set", { id: "fav-on", active: true }),
    event("favorite-set", {
      id: "fav-off",
      active: false,
      createdAt: at(24, 11) + 1,
    }),
    event("title-edited", { id: "rename", createdAt: at(24, 11) + 2 }),
    event("card-created", {
      id: "deep-1",
      targetCardId: "child-1",
      relation: "child",
      createdAt: at(24, 11) + 3,
    }),
    event("card-created", {
      id: "deep-2",
      targetCardId: "child-2",
      relation: "child",
      createdAt: at(24, 11) + 4,
    }),
  ];
  const [candidate] = collectSessionCandidates({
    session: session(),
    events,
  });
  assert.equal(candidate.score, 12);
  assert.equal(
    candidate.events.some((item) => item.id === "fav-on"),
    false,
  );
  assert.equal(
    candidate.events.some((item) => item.id === "fav-off"),
    false,
  );
  assert.equal(candidate.medium, 2);
  assert.equal(candidate.strong, 1);
});

test("proposal generation stays local, caps output and allows one existing-concept wildcard", () => {
  const events = [
    event("title-edited", { id: "strong", sourceCardId: "root" }),
    event("card-reopened", {
      id: "wildcard-signal",
      targetCardId: "concept-card",
      sourceCardId: "concept-card",
    }),
  ];
  const result = generateSessionProposals({
    session: session(),
    events,
    cards: [card("root"), card("concept-card", "p", ["量子退相干"])],
    anchors: [],
    existing: [],
    now: at(25),
    createId: id,
  });
  assert.equal(result.proposals.length, 2);
  assert.equal(
    result.proposals.filter((item) => item.evidence === "ai-wildcard").length,
    1,
  );
  assert.equal(
    result.proposals
      .find((item) => item.evidence === "ai-wildcard")
      ?.explorationQuestion.includes("量子退相干"),
    true,
  );
});

test("project cap only replaces a proposal when the new score is at least two points higher", () => {
  const existing = Array.from({ length: 5 }, (_, index) =>
    proposal({ id: `old-${index}`, signalScore: 7 + index }),
  );
  const noReplace = generateSessionProposals({
    session: session(),
    events: [event("title-edited", { id: "six" })],
    cards: [card("root")],
    anchors: [],
    existing,
    now: at(25),
    createId: id,
  });
  assert.equal(noReplace.proposals.length, 0);

  const replaces = generateSessionProposals({
    session: session(),
    events: [
      event("title-edited", { id: "a" }),
      event("question-rerouted", { id: "b" }),
    ],
    cards: [card("root")],
    anchors: [],
    existing,
    now: at(25),
    createId: id,
  });
  assert.equal(replaces.proposals.length, 1);
  assert.deepEqual(replaces.replacedIds, ["old-0"]);
});

test("lifecycle cools at 72h and retains only one high-signal cooled record per session after 7d", () => {
  const now = at(25);
  const low = proposal({
    id: "low",
    status: "queued",
    signalScore: 3,
    expiresAt: now - 1,
    purgeAt: now - 1,
  });
  const highA = proposal({
    id: "high-a",
    status: "queued",
    signalScore: 6,
    expiresAt: now - 1,
    purgeAt: now - 1,
  });
  const highB = proposal({
    id: "high-b",
    status: "queued",
    signalScore: 9,
    expiresAt: now - 1,
    purgeAt: now - 1,
    lastSignalAt: now,
  });
  const result = applyProposalLifecycle([low, highA, highB], now);
  assert.deepEqual(
    result.map((item) => item.id),
    ["high-b"],
  );
  assert.equal(result[0].status, "cooled");
});

test("only a prior-day ended session is processed and projects never cross", () => {
  const prior = session("p", 24);
  const otherProject = session("other", 24);
  const current: SessionBoundary = {
    ...session("p", 25),
    endedAt: undefined,
  };
  const result = processPriorSessions({
    sessions: [prior, otherProject, current],
    proposals: [],
    events: [
      event("title-edited", { id: "p-event" }),
      event("title-edited", {
        id: "other-event",
        projectId: "other",
        sessionId: otherProject.id,
        sourceCardId: "other-root",
        targetCardId: "other-root",
      }),
    ],
    cards: [card("root"), card("other-root", "other")],
    anchors: [],
    now: at(25, 9),
    createId: id,
  });
  assert.equal(
    result.sessions.find((item) => item.id === prior.id)?.processedAt,
    at(25, 9),
  );
  assert.equal(
    result.sessions.find((item) => item.id === current.id)?.processedAt,
    undefined,
  );
  assert.deepEqual(
    new Set(result.proposals.map((item) => item.projectId)),
    new Set(["p", "other"]),
  );
});
