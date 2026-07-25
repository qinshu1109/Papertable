import type {
  AppSettings,
  AttentionMetrics,
  Card,
  EdgeType,
  InteractionEvent,
  InteractionEventType,
  Proposal,
  ProposalEvidence,
  SessionBoundary,
  SessionEndReason,
  SourceAnchor,
} from "../types";

/** 30 分钟没有有效交互后，下一次有效行为会开启一个新会话。 */
export const SESSION_IDLE_MS = 30 * 60 * 1000;
export const PROPOSAL_COOL_MS = 72 * 60 * 60 * 1000;
export const PROPOSAL_PURGE_MS = 7 * 24 * 60 * 60 * 1000;

export type SignalTier = "strong" | "medium" | "weak";

export const signalWeight: Record<SignalTier, number> = {
  strong: 6,
  medium: 3,
  weak: 1,
};

/** 本地日期是状态机边界，不能交给模型解释。 */
export function localDateKey(timestamp: number): string {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function signalTier(event: InteractionEvent): SignalTier {
  switch (event.type) {
    case "favorite-set":
    case "reference-sent":
    case "concept-promoted":
    case "title-edited":
    case "question-rerouted":
      return "strong";
    case "card-created":
    case "card-reopened":
      return "medium";
    case "concept-preview-opened":
    case "card-dwell":
      return "weak";
  }
}

export function isPositiveSignal(event: InteractionEvent): boolean {
  return event.type !== "favorite-set" || event.active !== false;
}

export function isStrongSignal(event: InteractionEvent): boolean {
  return isPositiveSignal(event) && signalTier(event) === "strong";
}

const uidFallback = (prefix: string) =>
  `${prefix}-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;

function activeSessionFor(
  sessions: SessionBoundary[],
  projectId: string,
): SessionBoundary | undefined {
  return sessions
    .filter((session) => session.projectId === projectId && !session.endedAt)
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0];
}

function endSession(
  session: SessionBoundary,
  endedAt: number,
  reason: SessionEndReason,
): SessionBoundary {
  return {
    ...session,
    lastActiveAt: Math.max(session.lastActiveAt, endedAt),
    endedAt,
    endReason: reason,
  };
}

export interface SessionTransition {
  sessions: SessionBoundary[];
  session: SessionBoundary;
  started: boolean;
  closed?: SessionBoundary;
}

/**
 * 在第一个有效行为时懒启动；跨本地日期或超过 30 分钟则先关闭旧会话。
 */
export function ensureProjectSession(
  sessions: SessionBoundary[],
  projectId: string,
  now: number,
  createId: (prefix: string) => string = uidFallback,
): SessionTransition {
  const current = activeSessionFor(sessions, projectId);
  if (
    current &&
    current.localDate === localDateKey(now) &&
    now - current.lastActiveAt < SESSION_IDLE_MS
  ) {
    const updated = { ...current, lastActiveAt: now };
    return {
      sessions: sessions.map((session) =>
        session.id === updated.id ? updated : session,
      ),
      session: updated,
      started: false,
    };
  }

  const reason: SessionEndReason | undefined = current
    ? current.localDate !== localDateKey(now)
      ? "date-change"
      : "idle"
    : undefined;
  const closed =
    current && reason ? endSession(current, now, reason) : undefined;
  const session: SessionBoundary = {
    id: createId("session"),
    projectId,
    localDate: localDateKey(now),
    startedAt: now,
    lastActiveAt: now,
  };
  return {
    sessions: [
      ...sessions.map((item) => (closed?.id === item.id ? closed : item)),
      session,
    ],
    session,
    started: true,
    closed,
  };
}

export function closeProjectSession(
  sessions: SessionBoundary[],
  projectId: string,
  now: number,
  reason: SessionEndReason,
): SessionBoundary[] {
  const active = activeSessionFor(sessions, projectId);
  if (!active) return sessions;
  return sessions.map((session) =>
    session.id === active.id ? endSession(active, now, reason) : session,
  );
}

/** 页面重开时补写来不及落下的会话结束边界。 */
export function recoverSessions(
  sessions: SessionBoundary[],
  now: number,
): SessionBoundary[] {
  return sessions.map((session) => {
    if (session.endedAt) return session;
    if (session.localDate !== localDateKey(now))
      return endSession(session, now, "startup-recovery");
    if (now - session.lastActiveAt >= SESSION_IDLE_MS)
      return endSession(session, now, "startup-recovery");
    return session;
  });
}

export interface AttentionEventInput {
  projectId: string;
  sessionId: string;
  type: InteractionEventType;
  createdAt: number;
  targetCardId?: string;
  sourceCardId?: string;
  targetTurnId?: string;
  sourceAnchorId?: string;
  relation?: EdgeType;
  concept?: string;
  active?: boolean;
}

export function makeInteractionEvent(
  input: AttentionEventInput,
  createId: (prefix: string) => string = uidFallback,
): InteractionEvent {
  return { id: createId("event"), ...input };
}

interface Candidate {
  key: string;
  projectId: string;
  sessionId: string;
  parentCardId: string;
  anchorIds: string[];
  relation: EdgeType;
  events: InteractionEvent[];
  score: number;
  strong: number;
  medium: number;
  lastSignalAt: number;
}

function eventTargetKey(event: InteractionEvent): string {
  return (
    event.targetCardId ??
    event.sourceAnchorId ??
    event.sourceCardId ??
    event.concept ??
    "project"
  );
}

function candidateKeyFor(event: InteractionEvent): string {
  if (event.sourceAnchorId) return `anchor:${event.sourceAnchorId}`;
  if (event.concept && event.sourceCardId)
    return `concept:${event.sourceCardId}:${event.concept}`;
  return `card:${event.sourceCardId ?? event.targetCardId ?? "unknown"}`;
}

function relationFor(event: InteractionEvent): EdgeType {
  return event.relation ?? "child";
}

/**
 * 信号首先在同一会话内按「事件类型 + 目标」去重。收藏使用最后状态，取消会抵消。
 */
export function collectSessionCandidates(input: {
  session: SessionBoundary;
  events: InteractionEvent[];
}): Candidate[] {
  const relevant = input.events
    .filter(
      (event) =>
        event.projectId === input.session.projectId &&
        event.sessionId === input.session.id,
    )
    .sort((a, b) => a.createdAt - b.createdAt);
  const deduped = new Map<string, InteractionEvent>();
  for (const event of relevant) {
    const key = `${event.type}:${eventTargetKey(event)}`;
    // 对收藏，最后一次状态就是该会话内的有效状态；对其他事件保留首次。
    if (event.type === "favorite-set" || !deduped.has(key))
      deduped.set(key, event);
  }

  const byCandidate = new Map<string, Candidate>();
  for (const event of deduped.values()) {
    if (!isPositiveSignal(event)) continue;
    const key = candidateKeyFor(event);
    const parentCardId = event.sourceCardId ?? event.targetCardId;
    if (!parentCardId) continue;
    const current = byCandidate.get(key) ?? {
      key,
      projectId: event.projectId,
      sessionId: event.sessionId,
      parentCardId,
      anchorIds: [],
      relation: relationFor(event),
      events: [],
      score: 0,
      strong: 0,
      medium: 0,
      lastSignalAt: 0,
    };
    const tier = signalTier(event);
    current.events.push(event);
    current.score += signalWeight[tier];
    if (tier === "strong") current.strong += 1;
    if (tier === "medium") current.medium += 1;
    current.lastSignalAt = Math.max(current.lastSignalAt, event.createdAt);
    if (
      event.sourceAnchorId &&
      !current.anchorIds.includes(event.sourceAnchorId)
    )
      current.anchorIds.push(event.sourceAnchorId);
    // 创建关系时，新卡片的来源关系比普通点击更能指导幽灵分支方向。
    if (event.relation) current.relation = event.relation;
    byCandidate.set(key, current);
  }
  return [...byCandidate.values()]
    .filter((candidate) => candidate.strong >= 1 || candidate.medium >= 2)
    .sort((a, b) => b.score - a.score || b.lastSignalAt - a.lastSignalAt);
}

function sourceTextFor(
  candidate: Candidate,
  anchors: SourceAnchor[],
): string | undefined {
  for (const id of candidate.anchorIds) {
    const anchor = anchors.find((item) => item.id === id);
    const text = anchor?.exact ?? anchor?.text;
    if (text) return text;
  }
  return undefined;
}

function deterministicQuestion(
  candidate: Candidate,
  cardTitle: string,
  anchors: SourceAnchor[],
): string {
  const selected = sourceTextFor(candidate, anchors)?.slice(0, 42);
  if (candidate.relation === "branch")
    return `如果从「${cardTitle}」在这里换一个前提，哪条路径最值得重新走一遍？`;
  if (candidate.relation === "divergent")
    return `围绕「${cardTitle}」，哪一个相邻方向最可能改变你现在的判断？`;
  if (selected)
    return `从「${selected}」继续往下问，最需要先澄清的前提是什么？`;
  return `你在「${cardTitle}」附近反复停留；下一步最值得验证的关键区别是什么？`;
}

function deterministicReason(candidate: Candidate, cardTitle: string): string {
  const strong = candidate.strong ? `${candidate.strong} 个强信号` : "";
  const medium = candidate.medium ? `${candidate.medium} 个中信号` : "";
  const signals = [strong, medium].filter(Boolean).join("、") || "行为信号";
  return `来自「${cardTitle}」的 ${signals}，不是 AI 自动总结。`;
}

function wildcardDraft(input: {
  session: SessionBoundary;
  events: InteractionEvent[];
  cards: Card[];
  coveredCardIds: Set<string>;
}): Omit<Proposal, "id" | "createdAt" | "expiresAt" | "purgeAt"> | null {
  const sessionEvents = input.events.filter(
    (event) =>
      event.projectId === input.session.projectId &&
      event.sessionId === input.session.id &&
      isPositiveSignal(event),
  );
  if (!sessionEvents.some((event) => signalTier(event) !== "weak")) return null;
  const scoreByCard = new Map<string, { score: number; last: number }>();
  for (const event of sessionEvents) {
    const cardId = event.sourceCardId ?? event.targetCardId;
    if (!cardId || input.coveredCardIds.has(cardId)) continue;
    const current = scoreByCard.get(cardId) ?? { score: 0, last: 0 };
    current.score += signalWeight[signalTier(event)];
    current.last = Math.max(current.last, event.createdAt);
    scoreByCard.set(cardId, current);
  }
  const card = [...scoreByCard.entries()]
    .sort((a, b) => b[1].score - a[1].score || b[1].last - a[1].last)
    .map(([id]) => input.cards.find((candidate) => candidate.id === id))
    .find((candidate) => candidate?.concepts.length);
  if (!card) return null;
  const term = card.concepts[0];
  if (!term) return null;
  const score = scoreByCard.get(card.id)!;
  return {
    projectId: input.session.projectId,
    sessionId: input.session.id,
    title: `${term} · 另一种入口`,
    explorationQuestion: `如果把「${term}」当成新的入口，它会怎样改变你对「${card.title}」的理解？`,
    reason: `AI 意外提名：它复用了你已看见的概念「${term}」，没有新增模型调用。`,
    sourceAnchorIds: [],
    suggestedParentCardId: card.id,
    suggestedRelation: "divergent",
    evidence: "ai-wildcard",
    status: "queued",
    candidateKey: `wildcard:${input.session.id}:${card.id}:${term}`,
    signalScore: score.score,
    signalEventIds: sessionEvents
      .filter((event) => (event.sourceCardId ?? event.targetCardId) === card.id)
      .map((event) => event.id),
    lastSignalAt: score.last,
  };
}

export interface ProposalGenerationResult {
  proposals: Proposal[];
  replacedIds: string[];
  candidates: number;
}

/**
 * 为一条已经结束的会话生成 0–3 条候选。这里没有任何模型调用，所有句子来自模板。
 */
export function generateSessionProposals(input: {
  session: SessionBoundary;
  events: InteractionEvent[];
  cards: Card[];
  anchors: SourceAnchor[];
  existing: Proposal[];
  now: number;
  createId?: (prefix: string) => string;
}): ProposalGenerationResult {
  const createId = input.createId ?? uidFallback;
  const candidates = collectSessionCandidates({
    session: input.session,
    events: input.events,
  });
  const projectCards = input.cards.filter(
    (card) => card.projectId === input.session.projectId && !card.trashed,
  );
  const existingKeys = new Set(
    input.existing.map((proposal) => proposal.candidateKey),
  );
  const drafts: Array<
    Omit<Proposal, "id" | "createdAt" | "expiresAt" | "purgeAt">
  > = [];
  for (const candidate of candidates) {
    if (drafts.length >= 3 || existingKeys.has(candidate.key)) continue;
    const card = projectCards.find(
      (item) => item.id === candidate.parentCardId,
    );
    if (!card) continue;
    drafts.push({
      projectId: candidate.projectId,
      sessionId: candidate.sessionId,
      title: `${card.title} · 值得再问一次`,
      explorationQuestion: deterministicQuestion(
        candidate,
        card.title,
        input.anchors,
      ),
      reason: deterministicReason(candidate, card.title),
      sourceAnchorIds: candidate.anchorIds,
      suggestedParentCardId: candidate.parentCardId,
      suggestedRelation: candidate.relation,
      evidence: "human-signals",
      status: "queued",
      candidateKey: candidate.key,
      signalScore: candidate.score,
      signalEventIds: candidate.events.map((event) => event.id),
      lastSignalAt: candidate.lastSignalAt,
    });
  }
  const wildcard = wildcardDraft({
    session: input.session,
    events: input.events,
    cards: projectCards,
    coveredCardIds: new Set(
      candidates.map((candidate) => candidate.parentCardId),
    ),
  });
  if (wildcard && drafts.length < 3 && !existingKeys.has(wildcard.candidateKey))
    drafts.push(wildcard);

  const unprocessed = input.existing
    .filter(
      (proposal) =>
        proposal.projectId === input.session.projectId &&
        ["queued", "opened", "cooled"].includes(proposal.status),
    )
    .sort((a, b) => a.signalScore - b.signalScore || a.createdAt - b.createdAt);
  const accepted: Proposal[] = [];
  const replacedIds: string[] = [];
  let available = Math.max(0, 5 - unprocessed.length);
  const replaceable = [...unprocessed];
  for (const draft of drafts) {
    if (accepted.length >= 3) break;
    if (available > 0) {
      available -= 1;
    } else {
      const weakest = replaceable.shift();
      if (!weakest || draft.signalScore < weakest.signalScore + 2) continue;
      replacedIds.push(weakest.id);
    }
    accepted.push({
      ...draft,
      id: createId("proposal"),
      createdAt: input.now,
      expiresAt: input.now + PROPOSAL_COOL_MS,
      purgeAt: input.now + PROPOSAL_PURGE_MS,
    });
  }
  return { proposals: accepted, replacedIds, candidates: candidates.length };
}

/** 72 小时进入冷却；7 天后只保留每个高信号会话的一条短记录。 */
export function applyProposalLifecycle(
  proposals: Proposal[],
  now: number,
): Proposal[] {
  const cooled = proposals.map((proposal) => {
    if (
      ["queued", "opened"].includes(proposal.status) &&
      now >= proposal.expiresAt
    )
      return { ...proposal, status: "cooled" as const };
    return proposal;
  });
  const retainHighBySession = new Map<string, string>();
  for (const proposal of cooled
    .filter(
      (proposal) =>
        proposal.status === "cooled" &&
        now >= proposal.purgeAt &&
        proposal.signalScore >= signalWeight.strong,
    )
    .sort(
      (a, b) =>
        b.signalScore - a.signalScore || b.lastSignalAt - a.lastSignalAt,
    )) {
    if (!retainHighBySession.has(proposal.sessionId))
      retainHighBySession.set(proposal.sessionId, proposal.id);
  }
  return cooled.filter((proposal) => {
    if (proposal.status !== "cooled" || now < proposal.purgeAt) return true;
    return retainHighBySession.get(proposal.sessionId) === proposal.id;
  });
}

export interface ProcessAttentionResult {
  sessions: SessionBoundary[];
  proposals: Proposal[];
  generated: Proposal[];
}

/** 仅处理“前一自然日已结束且尚未处理”的会话。 */
export function processPriorSessions(input: {
  sessions: SessionBoundary[];
  proposals: Proposal[];
  events: InteractionEvent[];
  cards: Card[];
  anchors: SourceAnchor[];
  now: number;
  createId?: (prefix: string) => string;
}): ProcessAttentionResult {
  const today = localDateKey(input.now);
  let proposals = applyProposalLifecycle(input.proposals, input.now);
  const generated: Proposal[] = [];
  const sessions = input.sessions.map((session) => {
    if (!session.endedAt || session.processedAt || session.localDate >= today)
      return session;
    const result = generateSessionProposals({
      session,
      events: input.events,
      cards: input.cards,
      anchors: input.anchors,
      existing: proposals,
      now: input.now,
      createId: input.createId,
    });
    if (result.replacedIds.length)
      proposals = proposals.filter(
        (proposal) => !result.replacedIds.includes(proposal.id),
      );
    proposals = [...proposals, ...result.proposals];
    generated.push(...result.proposals);
    return { ...session, processedAt: input.now };
  });
  return { sessions, proposals, generated };
}

export function activeProposalsForProject(
  proposals: Proposal[],
  projectId: string,
): Proposal[] {
  return proposals
    .filter(
      (proposal) =>
        proposal.projectId === projectId &&
        ["queued", "opened"].includes(proposal.status),
    )
    .sort(
      (a, b) =>
        b.signalScore - a.signalScore || b.lastSignalAt - a.lastSignalAt,
    );
}

export function potentialDirectionCount(input: {
  sessions: SessionBoundary[];
  events: InteractionEvent[];
  projectId: string;
}): number {
  const session = activeSessionFor(input.sessions, input.projectId);
  if (!session) return 0;
  return collectSessionCandidates({ session, events: input.events }).length;
}

export function buildAttentionMetrics(input: {
  events: InteractionEvent[];
  proposals: Proposal[];
  cards: Card[];
  settings: AppSettings;
  now: number;
}): AttentionMetrics {
  const today = localDateKey(input.now);
  const daily = { strong: 0, medium: 0, weak: 0 };
  for (const event of input.events) {
    if (localDateKey(event.createdAt) !== today || !isPositiveSignal(event))
      continue;
    daily[signalTier(event)] += 1;
  }
  const proposalCards = new Map(
    input.cards
      .filter((card) => card.origin === "proposal")
      .map((card) => [card.id, card]),
  );
  const secondaryStrongCardIds = new Set<string>();
  for (const event of input.events) {
    if (!isStrongSignal(event)) continue;
    for (const id of [event.targetCardId, event.sourceCardId]) {
      const card = id ? proposalCards.get(id) : undefined;
      if (card && event.createdAt > card.createdAt)
        secondaryStrongCardIds.add(card.id);
    }
  }
  const proposalCount = input.proposals.length;
  const openedCount = input.proposals.filter(
    (proposal) => proposal.status === "accepted",
  ).length;
  const startedAt =
    input.settings.attentionExperimentStartedAt ??
    input.settings.seededAt ??
    input.now;
  return {
    dayIndex: Math.max(1, Math.floor((input.now - startedAt) / 86_400_000) + 1),
    paused: Boolean(input.settings.attentionPaused),
    today: daily,
    promptCount:
      input.settings.attentionPromptHistory?.length ??
      Object.keys(input.settings.attentionPromptedDates ?? {}).length,
    proposalCount,
    openedCount,
    openedRate: proposalCount ? openedCount / proposalCount : 0,
    secondaryStrongSignalCount: secondaryStrongCardIds.size,
  };
}

export function proposalEvidenceLabel(evidence: ProposalEvidence): string {
  return evidence === "human-signals" ? "人类行为信号" : "AI 意外提名";
}
