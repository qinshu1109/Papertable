import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  CURRENT_CARD_ID,
  DEMO_CARDS,
  DEMO_EDGES,
  DEMO_PROJECTS,
  DEMO_REFERENCES,
  PROJECT_DEFAULT_CARD_IDS,
} from "./data/demo";
import { buildContext } from "./lib/context";
import {
  activeProposalsForProject,
  buildAttentionMetrics,
  closeProjectSession,
  ensureProjectSession,
  localDateKey,
  makeInteractionEvent,
  processPriorSessions,
  recoverSessions,
  SESSION_IDLE_MS,
} from "./lib/attention";
import { downloadArtifact, formatAdapters } from "./lib/formats";
import { incomingEdge, subtreeIds } from "./lib/graph";
import {
  generateModel,
  getProviderHealth,
  streamModel,
  type ProviderHealth,
} from "./lib/provider";
import { visibleModelOutput } from "./lib/modelOutput";
import { preferredProjectCard } from "./lib/projectScope";
import {
  applyAttentionChanges,
  applyChanges,
  clearWorkspace,
  deleteAttentionForProject,
  diffAttention,
  diffWorkspace,
  loadAttentionState,
  loadWorkspace,
  saveAttentionState,
  saveWorkspace,
  type AttentionSnapshot,
  type WorkspaceSnapshot,
} from "./lib/storage";
import { EDGE_META } from "./types";
import type {
  AnswerMode,
  AppSettings,
  AttentionMetrics,
  BuiltContext,
  Card,
  CardEdge,
  ConceptPreviewCacheEntry,
  ContextSnapshot,
  EdgeType,
  ImportInput,
  InteractionEvent,
  Proposal,
  Project,
  ReferenceChip,
  SourceAnchor,
  SessionBoundary,
  Turn,
  ViewState,
} from "./types";

const uid = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;
const defaultSettings: AppSettings = {
  id: "app",
  model: "claude-opus-5",
  providerBaseUrl: "https://cozai.net/v1",
  providerStatus: "unknown",
  attentionPaused: false,
  attentionExperimentStartedAt: Date.now(),
  attentionPromptedDates: {},
  attentionPromptHistory: [],
};
const defaultView = (): ViewState => ({
  id: "main",
  activeProjectId: "p-quantum",
  currentCardId: CURRENT_CARD_ID,
  drafts: {},
  lastCardByProject: PROJECT_DEFAULT_CARD_IDS,
  collapsed: [],
  scrollPositions: {},
});

/** 删除项目或异常中断后，清理不再指向有效项目/卡片的纯视图元数据。 */
function pruneProjectScopedState(input: {
  projects: Project[];
  cards: Card[];
  view: ViewState;
  settings: AppSettings;
}) {
  const projectIds = new Set(input.projects.map((project) => project.id));
  const cardIds = new Set(input.cards.map((card) => card.id));
  const fallbackProjectId = input.projects[0]?.id ?? input.view.activeProjectId;
  const activeProjectId = projectIds.has(input.view.activeProjectId)
    ? input.view.activeProjectId
    : fallbackProjectId;
  const fallbackCardId = input.cards.find(
    (card) => card.projectId === activeProjectId && !card.trashed,
  )?.id;
  const currentCardId = cardIds.has(input.view.currentCardId)
    ? input.view.currentCardId
    : (fallbackCardId ?? input.view.currentCardId);
  const belongsToLiveProject = (id: string) => projectIds.has(id);
  const belongsToLiveCard = (id: string) => cardIds.has(id);
  const promptDates = Object.fromEntries(
    Object.entries(input.settings.attentionPromptedDates ?? {}).filter(([id]) =>
      belongsToLiveProject(id),
    ),
  );
  const promptHistory = (input.settings.attentionPromptHistory ?? []).filter(
    (entry) => belongsToLiveProject(entry.slice(0, entry.lastIndexOf(":"))),
  );
  return {
    view: {
      ...input.view,
      activeProjectId,
      currentCardId,
      drafts: Object.fromEntries(
        Object.entries(input.view.drafts).filter(([id]) =>
          belongsToLiveProject(id),
        ),
      ),
      lastCardByProject: Object.fromEntries(
        Object.entries(input.view.lastCardByProject).filter(
          ([id, cardId]) =>
            belongsToLiveProject(id) && belongsToLiveCard(cardId),
        ),
      ),
      collapsed: input.view.collapsed.filter(belongsToLiveCard),
      scrollPositions: Object.fromEntries(
        Object.entries(input.view.scrollPositions).filter(([id]) =>
          belongsToLiveCard(id),
        ),
      ),
    },
    settings: {
      ...input.settings,
      attentionPromptedDates: promptDates,
      attentionPromptHistory: promptHistory,
    },
  };
}

export interface CreateCardInput {
  type: EdgeType;
  sourceCardId: string;
  sourceTurnId?: string;
  sourceText?: string;
  sourceBlockText?: string;
  title: string;
  seedTurns?: Turn[];
  /** 建卡来源不影响关系语义，只用于事件和后续实验统计。 */
  origin?: Card["origin"];
  proposalId?: string;
  /** branch 的冻结历史截止点；null 表示不继承任何旧轮次。 */
  contextThroughTurnId?: string | null;
}

interface Toast {
  id: string;
  text: string;
  actionLabel?: string;
  onAction?: () => void;
}

interface Ctx {
  projects: Project[];
  activeProjectId: string;
  cards: Card[];
  edges: CardEdge[];
  anchors: SourceAnchor[];
  snapshots: ContextSnapshot[];
  interactionEvents: InteractionEvent[];
  sessions: SessionBoundary[];
  proposals: Proposal[];
  activeProposals: Proposal[];
  attentionMetrics: AttentionMetrics;
  attentionPaused: boolean;
  morningPrompt: { projectId: string; count: number } | null;
  proposalTrayOpen: boolean;
  selectedProposalId: string | null;
  currentCardId: string;
  references: ReferenceChip[];
  draft: string;
  collapsed: Set<string>;
  toast: Toast | null;
  streamingTurnId: string | null;
  lastCreated: { cardId: string; type: EdgeType } | null;
  hydrated: boolean;
  provider: ProviderHealth | null;

  cardById: (id: string) => Card | undefined;
  setActiveProject: (id: string) => void;
  renameProject: (id: string, name: string) => void;
  togglePinProject: (id: string) => void;
  createProject: () => void;
  deleteProject: (id: string) => void;
  setCurrentCard: (id: string) => void;
  createCard: (input: CreateCardInput) => string;
  setCardAnswerMode: (cardId: string, mode: AnswerMode) => void;
  renameCard: (id: string, title: string) => void;
  rerouteEditedQuestion: (
    cardId: string,
    turnId: string,
    text: string,
  ) => string;
  deleteCard: (id: string) => void;
  toggleFavoriteCard: (id: string) => void;
  toggleCollapse: (id: string) => void;
  markRead: (id: string) => void;
  cacheConceptPreview: (
    cardId: string,
    cacheKey: string,
    entry: ConceptPreviewCacheEntry,
  ) => void;
  recordConceptPreviewOpened: (input: {
    cardId: string;
    turnId?: string;
    concept: string;
  }) => void;
  recordCardDwell: (cardId: string) => void;
  addReference: (anchor: SourceAnchor, sourceTitle: string) => void;
  removeReference: (id: string) => void;
  clearReferences: () => void;
  setDraft: (value: string) => void;
  rememberCardScroll: (cardId: string, scrollTop: number) => void;
  cardScroll: (cardId: string) => number;
  send: (text: string) => void;
  stopStream: () => void;
  retryLast: () => void;
  contextForCurrent: () => BuiltContext;
  refreshProvider: () => Promise<ProviderHealth | null>;
  importFiles: (format: ImportInput["format"], files: File[]) => Promise<void>;
  exportProject: (format: "md-dir" | "canvas" | "bundle") => Promise<void>;
  exportAllBackup: () => Promise<void>;
  clearLocalData: () => Promise<void>;
  previewProposal: (id: string) => void;
  materializeProposal: (id: string, finalQuestion: string) => string | null;
  clearProposalPreview: () => void;
  dismissProposal: (id: string) => void;
  setProposalTrayOpen: (open: boolean) => void;
  dismissMorningPrompt: () => void;
  setAttentionPaused: (paused: boolean) => void;
  showToast: (toast: Omit<Toast, "id">) => void;
  dismissToast: () => void;
}

const StoreCtx = createContext<Ctx | null>(null);
export const useStore = () => {
  const value = useContext(StoreCtx);
  if (!value) throw new Error("StoreProvider missing");
  return value;
};

function seedSnapshot(): WorkspaceSnapshot {
  const now = Date.now();
  return {
    projects: DEMO_PROJECTS,
    cards: DEMO_CARDS,
    edges: DEMO_EDGES,
    anchors: [],
    snapshots: [],
    references: DEMO_REFERENCES,
    view: defaultView(),
    settings: {
      ...defaultSettings,
      seededAt: now,
      attentionExperimentStartedAt: now,
      attentionPromptedDates: {},
      attentionPromptHistory: [],
    },
  };
}

function parseStructuredArray(content: string): string[] {
  const raw = content.match(/\[[\s\S]*\]/)?.[0] ?? "[]";
  try {
    const result = JSON.parse(raw);
    return Array.isArray(result)
      ? result.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

export function StoreProvider({ children }: { children: React.ReactNode }) {
  const seed = useMemo(seedSnapshot, []);
  const [projects, setProjects] = useState<Project[]>(seed.projects);
  const [cards, setCards] = useState<Card[]>(seed.cards);
  const [edges, setEdges] = useState<CardEdge[]>(seed.edges);
  const [anchors, setAnchors] = useState<SourceAnchor[]>(seed.anchors);
  const [snapshots, setSnapshots] = useState<ContextSnapshot[]>(seed.snapshots);
  const [referenceStore, setReferenceStore] = useState<ReferenceChip[]>(
    seed.references,
  );
  const [view, setView] = useState<ViewState>(seed.view);
  const [settings, setSettings] = useState<AppSettings>(seed.settings);
  const [interactionEvents, setInteractionEvents] = useState<
    InteractionEvent[]
  >([]);
  const [sessions, setSessions] = useState<SessionBoundary[]>([]);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [morningPrompt, setMorningPrompt] = useState<{
    projectId: string;
    count: number;
  } | null>(null);
  const [proposalTrayOpen, setProposalTrayOpenState] = useState(false);
  const [selectedProposalId, setSelectedProposalId] = useState<string | null>(
    null,
  );
  const [toast, setToast] = useState<Toast | null>(null);
  const [streamingTurnId, setStreamingTurnId] = useState<string | null>(null);
  const [lastCreated, setLastCreated] = useState<{
    cardId: string;
    type: EdgeType;
  } | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);
  const toastTimer = useRef<number | null>(null);
  const persistTimer = useRef<number | null>(null);
  const attentionPersistTimer = useRef<number | null>(null);
  const lastPersistedAt = useRef(0);
  const latestRef = useRef<WorkspaceSnapshot>(seed);
  const attentionRef = useRef<AttentionSnapshot>({
    events: [],
    sessions: [],
    proposals: [],
  });
  // 上次成功落库的快照，增量保存的比较基线。写失败时保持不动，下一次 diff 会
  // 重新带上这批变化，因此失败只会重写，不会丢。
  const persistedRef = useRef<WorkspaceSnapshot | null>(null);
  const persistedAttentionRef = useRef<AttentionSnapshot | null>(null);
  const hiddenAtRef = useRef<number | null>(null);
  const materializingProposalIdsRef = useRef(new Set<string>());

  const activeProjectId = view.activeProjectId;
  const currentCardId = view.currentCardId;
  const references = useMemo(
    () =>
      referenceStore.filter(
        (reference) => reference.projectId === activeProjectId,
      ),
    [referenceStore, activeProjectId],
  );
  const draft = view.drafts[activeProjectId] ?? "";
  const collapsed = useMemo(() => new Set(view.collapsed), [view.collapsed]);
  const provider =
    settings.providerStatus === "unknown"
      ? null
      : {
          configured: settings.providerStatus === "ready",
          model: settings.model,
          baseUrl: settings.providerBaseUrl ?? "https://cozai.net/v1",
          message: settings.providerMessage ?? "",
        };

  const activeProposals = useMemo(
    () => activeProposalsForProject(proposals, activeProjectId),
    [activeProjectId, proposals],
  );
  const attentionMetrics = useMemo(
    () =>
      buildAttentionMetrics({
        events: interactionEvents,
        proposals,
        cards,
        settings,
        now: Date.now(),
      }),
    [cards, interactionEvents, proposals, settings],
  );

  useEffect(() => {
    let active = true;
    void (async () => {
      const [saved, savedAttention] = await Promise.all([
        loadWorkspace(),
        loadAttentionState(),
      ]);
      if (!active) return;
      const now = Date.now();
      const next = saved ?? seed;
      if (!saved) await saveWorkspace(seed);
      // 落库基线 = 此刻库里真正的内容。下面的裁剪与默认值补齐会成为第一次
      // 增量保存的 diff 内容。
      persistedRef.current = next;
      persistedAttentionRef.current = savedAttention;
      const withDefaults: AppSettings = {
        ...next.settings,
        attentionPaused: next.settings.attentionPaused ?? false,
        attentionExperimentStartedAt:
          next.settings.attentionExperimentStartedAt ??
          next.settings.seededAt ??
          now,
        attentionPromptedDates: next.settings.attentionPromptedDates ?? {},
        attentionPromptHistory: next.settings.attentionPromptHistory ?? [],
      };
      const pruned = pruneProjectScopedState({
        projects: next.projects,
        cards: next.cards,
        view: next.view,
        settings: withDefaults,
      });
      const validProjectIds = new Set(
        next.projects.map((project) => project.id),
      );
      const survivingAttention: AttentionSnapshot = {
        events: savedAttention.events.filter((event) =>
          validProjectIds.has(event.projectId),
        ),
        sessions: savedAttention.sessions.filter((session) =>
          validProjectIds.has(session.projectId),
        ),
        proposals: savedAttention.proposals.filter((proposal) =>
          validProjectIds.has(proposal.projectId),
        ),
      };
      const nextSettings = pruned.settings;
      const recovered = recoverSessions(survivingAttention.sessions, now);
      const processed = nextSettings.attentionPaused
        ? {
            sessions: recovered,
            proposals: survivingAttention.proposals,
            generated: [] as Proposal[],
          }
        : processPriorSessions({
            sessions: recovered,
            proposals: survivingAttention.proposals,
            events: survivingAttention.events,
            cards: next.cards,
            anchors: next.anchors,
            now,
            createId: uid,
          });
      const todaysActive = activeProposalsForProject(
        processed.proposals,
        pruned.view.activeProjectId,
      );
      const today = localDateKey(now);
      const shouldPrompt =
        !nextSettings.attentionPaused &&
        todaysActive.length > 0 &&
        nextSettings.attentionPromptedDates?.[pruned.view.activeProjectId] !==
          today;
      const finalSettings = shouldPrompt
        ? {
            ...nextSettings,
            attentionPromptedDates: {
              ...nextSettings.attentionPromptedDates,
              [pruned.view.activeProjectId]: today,
            },
            attentionPromptHistory: [
              ...(nextSettings.attentionPromptHistory ?? []),
              `${pruned.view.activeProjectId}:${today}`,
            ],
          }
        : nextSettings;
      setProjects(next.projects);
      setCards(next.cards);
      setEdges(next.edges);
      setAnchors(next.anchors);
      setSnapshots(next.snapshots);
      setReferenceStore(next.references);
      setView(pruned.view);
      setSettings(finalSettings);
      attentionRef.current = {
        events: survivingAttention.events,
        sessions: processed.sessions,
        proposals: processed.proposals,
      };
      setInteractionEvents(survivingAttention.events);
      setSessions(processed.sessions);
      setProposals(processed.proposals);
      if (shouldPrompt)
        setMorningPrompt({
          projectId: pruned.view.activeProjectId,
          count: todaysActive.length,
        });
      setHydrated(true);
      void navigator.storage?.persist?.();
    })();
    return () => {
      active = false;
    };
  }, [seed]);

  useEffect(() => {
    latestRef.current = {
      projects,
      cards,
      edges,
      anchors,
      snapshots,
      references: referenceStore,
      view,
      settings,
    };
    if (!hydrated) return;
    if (persistTimer.current) return;
    const delay = streamingTurnId
      ? Math.max(0, 500 - (Date.now() - lastPersistedAt.current))
      : 120;
    persistTimer.current = window.setTimeout(() => {
      persistTimer.current = null;
      lastPersistedAt.current = Date.now();
      const target = latestRef.current;
      void applyChanges(diffWorkspace(persistedRef.current, target)).then(
        () => {
          persistedRef.current = target;
        },
        () => {
          // 基线保持不动：下一次 diff 会重新包含这批变化。
        },
      );
    }, delay);
  }, [
    projects,
    cards,
    edges,
    anchors,
    snapshots,
    referenceStore,
    view,
    settings,
    hydrated,
    streamingTurnId,
  ]);

  useEffect(
    () => () => {
      if (persistTimer.current) window.clearTimeout(persistTimer.current);
    },
    [],
  );

  useEffect(() => {
    const snapshot = {
      events: interactionEvents,
      sessions,
      proposals,
    };
    attentionRef.current = snapshot;
    if (!hydrated) return;
    if (attentionPersistTimer.current) return;
    attentionPersistTimer.current = window.setTimeout(() => {
      attentionPersistTimer.current = null;
      const target = attentionRef.current;
      void applyAttentionChanges(
        diffAttention(persistedAttentionRef.current, target),
      ).then(
        () => {
          persistedAttentionRef.current = target;
        },
        () => {
          // 同上：写失败时不推进基线。
        },
      );
    }, 120);
  }, [hydrated, interactionEvents, proposals, sessions]);

  useEffect(
    () => () => {
      if (attentionPersistTimer.current)
        window.clearTimeout(attentionPersistTimer.current);
    },
    [],
  );

  const showToast = useCallback((next: Omit<Toast, "id">) => {
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    setToast({ ...next, id: uid("toast") });
    toastTimer.current = window.setTimeout(() => setToast(null), 6_000);
  }, []);
  const dismissToast = useCallback(() => {
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    setToast(null);
  }, []);
  const cardById = useCallback(
    (id: string) => cards.find((card) => card.id === id),
    [cards],
  );

  const refreshProvider = useCallback(async () => {
    try {
      const health = await getProviderHealth();
      setSettings((current) => ({
        ...current,
        model: health.model,
        providerBaseUrl: health.baseUrl,
        providerStatus: health.configured ? "ready" : "missing",
        providerMessage: health.message,
      }));
      return health;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "无法检查模型服务。";
      setSettings((current) => ({
        ...current,
        providerStatus: "error",
        providerMessage: message,
      }));
      return null;
    }
  }, []);

  useEffect(() => {
    if (hydrated) void refreshProvider();
  }, [hydrated, refreshProvider]);

  const updateCard = useCallback(
    (cardId: string, updater: (card: Card) => Card) =>
      setCards((current) =>
        current.map((card) => (card.id === cardId ? updater(card) : card)),
      ),
    [],
  );

  const commitAttention = useCallback((next: AttentionSnapshot) => {
    attentionRef.current = next;
    setInteractionEvents(next.events);
    setSessions(next.sessions);
    setProposals(next.proposals);
  }, []);

  /**
   * 行为记录是唯一开启会话的入口。暂停时完全不写事件，也不在恢复后补算。
   */
  const recordInteraction = useCallback(
    (
      input: Omit<
        Parameters<typeof makeInteractionEvent>[0],
        "sessionId" | "createdAt"
      >,
    ) => {
      if (!hydrated || settings.attentionPaused) return undefined;
      const now = Date.now();
      const current = attentionRef.current;
      const transition = ensureProjectSession(
        current.sessions,
        input.projectId,
        now,
        uid,
      );
      const event = makeInteractionEvent(
        { ...input, sessionId: transition.session.id, createdAt: now },
        uid,
      );
      commitAttention({
        events: [...current.events, event],
        sessions: transition.sessions,
        proposals: current.proposals,
      });
      return event;
    },
    [commitAttention, hydrated, settings.attentionPaused],
  );

  const closeAttentionSession = useCallback(
    (
      projectId: string,
      reason:
        "project-switch" | "idle" | "hidden-idle" | "pagehide" | "date-change",
    ) => {
      const current = attentionRef.current;
      const nextSessions = closeProjectSession(
        current.sessions,
        projectId,
        Date.now(),
        reason,
      );
      if (nextSessions !== current.sessions)
        commitAttention({ ...current, sessions: nextSessions });
    },
    [commitAttention],
  );

  const processAttention = useCallback(
    (now = Date.now(), projectId = activeProjectId) => {
      if (!hydrated || settings.attentionPaused) return;
      const current = attentionRef.current;
      const result = processPriorSessions({
        sessions: recoverSessions(current.sessions, now),
        proposals: current.proposals,
        events: current.events,
        cards,
        anchors,
        now,
        createId: uid,
      });
      commitAttention({
        events: current.events,
        sessions: result.sessions,
        proposals: result.proposals,
      });
      const active = activeProposalsForProject(result.proposals, projectId);
      const today = localDateKey(now);
      if (
        active.length &&
        settings.attentionPromptedDates?.[projectId] !== today
      ) {
        setSettings((currentSettings) => ({
          ...currentSettings,
          attentionPromptedDates: {
            ...currentSettings.attentionPromptedDates,
            [projectId]: today,
          },
          attentionPromptHistory: [
            ...(currentSettings.attentionPromptHistory ?? []),
            `${projectId}:${today}`,
          ],
        }));
        setMorningPrompt({ projectId, count: active.length });
      }
    },
    [
      activeProjectId,
      anchors,
      cards,
      commitAttention,
      hydrated,
      settings.attentionPaused,
      settings.attentionPromptedDates,
    ],
  );

  useEffect(() => {
    if (!hydrated) return;
    const checkpoint = () => {
      if (settings.attentionPaused) return;
      const current = attentionRef.current;
      const active = current.sessions
        .filter(
          (session) =>
            session.projectId === activeProjectId && !session.endedAt,
        )
        .sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0];
      if (!active) return;
      const next = {
        ...active,
        lastActiveAt: Date.now(),
      };
      commitAttention({
        ...current,
        sessions: current.sessions.map((session) =>
          session.id === next.id ? next : session,
        ),
      });
    };
    const onVisibility = () => {
      if (document.hidden) {
        hiddenAtRef.current = Date.now();
        checkpoint();
        return;
      }
      const hiddenAt = hiddenAtRef.current;
      hiddenAtRef.current = null;
      if (!hiddenAt) return;
      const now = Date.now();
      if (
        now - hiddenAt >= SESSION_IDLE_MS ||
        localDateKey(hiddenAt) !== localDateKey(now)
      )
        closeAttentionSession(activeProjectId, "hidden-idle");
      processAttention(now, activeProjectId);
    };
    const onPageHide = () => {
      closeAttentionSession(activeProjectId, "pagehide");
      void saveAttentionState(attentionRef.current);
    };
    // 即使页面一直开着也要让 30 分钟空闲、72 小时冷却和 7 天清理自然推进；
    // 这里只跑本地状态机，绝不会触发任何模型请求。
    const maintenanceTimer = window.setInterval(() => {
      processAttention(Date.now(), activeProjectId);
    }, 60_000);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.clearInterval(maintenanceTimer);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [
    activeProjectId,
    closeAttentionSession,
    commitAttention,
    hydrated,
    processAttention,
    settings.attentionPaused,
  ]);

  const stopStream = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    const id = streamingTurnId;
    setStreamingTurnId(null);
    if (id)
      setCards((current) =>
        current.map((card) => ({
          ...card,
          turns: card.turns.map((turn) =>
            turn.id === id
              ? { ...turn, streaming: false, status: "stopped" }
              : turn,
          ),
        })),
      );
  }, [streamingTurnId]);

  const runBackgroundTasks = useCallback(
    async (cardId: string, title: string, answer: string) => {
      const titlePrompt = [
        {
          role: "system" as const,
          content:
            "根据用户问题和回答，给出一个不超过 18 个中文字符的知识卡片标题。只输出标题。",
        },
        {
          role: "user" as const,
          content: `当前标题：${title}\n回答：${answer.slice(0, 1800)}`,
        },
      ];
      const conceptPrompt = [
        {
          role: "system" as const,
          content:
            "从文本中找出最多 6 个值得继续探索的概念。只输出 JSON 字符串数组；每一项必须逐字出现在文本中。",
        },
        { role: "user" as const, content: answer.slice(0, 5000) },
      ];
      const [newTitle, conceptText] = await Promise.allSettled([
        generateModel({
          task: "title",
          messages: titlePrompt,
          temperature: 0.15,
        }),
        generateModel({
          task: "concepts",
          messages: conceptPrompt,
          temperature: 0,
        }),
      ]);
      if (newTitle.status === "fulfilled") {
        const clean = newTitle.value
          .replace(/[\n#*`"“”]/g, "")
          .trim()
          .slice(0, 28);
        if (clean)
          updateCard(cardId, (card) =>
            card.title === title ? { ...card, title: clean } : card,
          );
      }
      if (conceptText.status === "fulfilled") {
        const terms = parseStructuredArray(conceptText.value)
          .filter(
            (term) =>
              term.length >= 2 && term.length <= 32 && answer.includes(term),
          )
          .slice(0, 6);
        if (terms.length)
          updateCard(cardId, (card) => ({
            ...card,
            concepts: [...new Set(terms)],
          }));
      }
    },
    [updateCard],
  );

  const streamAnswer = useCallback(
    async (input: {
      cardId: string;
      cardsSnapshot: Card[];
      references: ReferenceChip[];
      edgesSnapshot?: CardEdge[];
      snapshotsSnapshot?: ContextSnapshot[];
      relation?: EdgeType;
      retryOf?: string;
    }) => {
      const target = input.cardsSnapshot.find(
        (card) => card.id === input.cardId,
      );
      if (!target) return;
      const aiId = uid("turn");
      const aiTurn: Turn = {
        id: aiId,
        role: "ai",
        content: "",
        createdAt: Date.now(),
        streaming: true,
        status: "streaming",
        model: settings.model,
      };
      updateCard(input.cardId, (card) => ({
        ...card,
        turns: [...card.turns, aiTurn],
      }));
      setStreamingTurnId(aiId);
      const controller = new AbortController();
      controllerRef.current = controller;
      let rawAnswer = "";
      let answer = "";
      try {
        const built = buildContext({
          cards: input.cardsSnapshot,
          edges: input.edgesSnapshot ?? edges,
          snapshots: input.snapshotsSnapshot ?? snapshots,
          references: input.references,
          currentCardId: input.cardId,
        });
        for await (const event of streamModel({
          task: "chat",
          messages: built.messages,
          signal: controller.signal,
        })) {
          if (event.type !== "token") continue;
          rawAnswer += event.text;
          const nextAnswer = visibleModelOutput(rawAnswer);
          if (nextAnswer === answer) continue;
          answer = nextAnswer;
          updateCard(input.cardId, (card) => ({
            ...card,
            turns: card.turns.map((turn) =>
              turn.id === aiId ? { ...turn, content: answer } : turn,
            ),
          }));
        }
        if (!controller.signal.aborted) {
          if (!answer.trim())
            throw new Error("模型没有返回可显示的最终文本，请重试。");
          updateCard(input.cardId, (card) => ({
            ...card,
            turns: card.turns.map((turn) =>
              turn.id === aiId
                ? { ...turn, streaming: false, status: "complete" }
                : turn,
            ),
          }));
          if (answer.trim())
            void runBackgroundTasks(input.cardId, target.title, answer);
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          const message =
            error instanceof Error ? error.message : "模型生成失败。";
          updateCard(input.cardId, (card) => ({
            ...card,
            turns: card.turns.map((turn) =>
              turn.id === aiId
                ? {
                    ...turn,
                    streaming: false,
                    status: "error",
                    error: message,
                    content: answer || "生成失败。",
                  }
                : turn,
            ),
          }));
          showToast({ text: message });
        }
      } finally {
        if (controllerRef.current === controller) controllerRef.current = null;
        setStreamingTurnId((current) => (current === aiId ? null : current));
      }
    },
    [
      edges,
      runBackgroundTasks,
      settings.model,
      showToast,
      snapshots,
      updateCard,
    ],
  );

  const setCurrentCard = useCallback(
    (id: string) => {
      const card = cards.find((candidate) => candidate.id === id);
      if (!card || card.trashed || card.projectId !== activeProjectId) return;
      const alreadySeenInAnotherSession = interactionEvents.some(
        (event) =>
          event.projectId === activeProjectId &&
          (event.targetCardId === id || event.sourceCardId === id) &&
          event.sessionId !==
            attentionRef.current.sessions
              .filter(
                (session) =>
                  session.projectId === activeProjectId && !session.endedAt,
              )
              .sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0]?.id,
      );
      const reopenedInCurrentSession = interactionEvents.some((event) => {
        const currentSessionId = attentionRef.current.sessions
          .filter(
            (session) =>
              session.projectId === activeProjectId && !session.endedAt,
          )
          .sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0]?.id;
        return (
          event.type === "card-reopened" &&
          event.targetCardId === id &&
          event.sessionId === currentSessionId
        );
      });
      setView((current) => ({
        ...current,
        currentCardId: id,
        lastCardByProject: {
          ...current.lastCardByProject,
          [activeProjectId]: id,
        },
      }));
      updateCard(id, (current) => ({ ...current, unread: false }));
      if (alreadySeenInAnotherSession && !reopenedInCurrentSession)
        recordInteraction({
          projectId: activeProjectId,
          type: "card-reopened",
          targetCardId: id,
        });
    },
    [activeProjectId, cards, interactionEvents, recordInteraction, updateCard],
  );

  const createCard = useCallback(
    (input: CreateCardInput) => {
      const source = cards.find((card) => card.id === input.sourceCardId);
      if (!source || source.projectId !== activeProjectId)
        throw new Error("不能从其他项目创建卡片。");
      const cardId = uid("card");
      const edgeId = uid("edge");
      const anchorId = input.sourceText ? uid("anchor") : undefined;
      const branchCutoff =
        input.contextThroughTurnId !== undefined
          ? input.contextThroughTurnId
          : input.sourceTurnId;
      const sourceTurns =
        input.type === "branch"
          ? branchCutoff
            ? source.turns.slice(
                0,
                Math.max(
                  0,
                  source.turns.findIndex((turn) => turn.id === branchCutoff) +
                    1,
                ),
              )
            : []
          : undefined;
      const snapshotId = uid("snapshot");
      const snapshot: ContextSnapshot = {
        id: snapshotId,
        edgeId,
        createdAt: Date.now(),
        sourceTitle: source.title,
        sourceText: input.sourceText,
        sourceBlockText: input.sourceBlockText,
        sourceTurns,
      };
      const anchor: SourceAnchor | undefined = anchorId
        ? {
            id: anchorId,
            cardId: source.id,
            turnId: input.sourceTurnId,
            text: input.sourceText,
            exact: input.sourceText,
            blockText: input.sourceBlockText,
            prefix: input.sourceBlockText?.slice(
              0,
              Math.max(
                0,
                input.sourceBlockText.indexOf(input.sourceText ?? ""),
              ),
            ),
            suffix: input.sourceBlockText?.slice(
              Math.max(
                0,
                input.sourceBlockText.indexOf(input.sourceText ?? "") +
                  (input.sourceText?.length ?? 0),
              ),
              Math.max(
                0,
                input.sourceBlockText.indexOf(input.sourceText ?? "") +
                  (input.sourceText?.length ?? 0) +
                  80,
              ),
            ),
            sourceRevision: `${source.id}:${source.turns.length}:${source.turns[source.turns.length - 1]?.createdAt ?? source.createdAt}`,
          }
        : undefined;
      const newCard: Card = {
        id: cardId,
        projectId: activeProjectId,
        title: input.title,
        favorite: false,
        unread: false,
        createdAt: Date.now(),
        concepts: [],
        answerMode: source.answerMode ?? "general",
        turns: input.seedTurns ?? [],
        origin: input.origin ?? "manual",
        proposalId: input.proposalId,
      };
      const edge: CardEdge = {
        id: edgeId,
        type: input.type,
        sourceCardId: source.id,
        targetCardId: cardId,
        sourceTurnId: input.sourceTurnId,
        sourceText: input.sourceText,
        sourceBlockText: input.sourceBlockText,
        sourceAnchorId: anchorId,
        contextSnapshotId: snapshotId,
        contextCutoffTurnId: input.contextThroughTurnId,
        contextPolicy: EDGE_META[input.type].policy,
      };
      const nextCards = [...cards, newCard];
      setCards(nextCards);
      setEdges((current) => [...current, edge]);
      setSnapshots((current) => [...current, snapshot]);
      if (anchor) setAnchors((current) => [...current, anchor]);
      setView((current) => ({
        ...current,
        currentCardId: cardId,
        lastCardByProject: {
          ...current.lastCardByProject,
          [activeProjectId]: cardId,
        },
      }));
      setLastCreated({ cardId, type: input.type });
      recordInteraction({
        projectId: activeProjectId,
        type: "card-created",
        targetCardId: cardId,
        sourceCardId: source.id,
        sourceAnchorId: anchorId,
        relation: input.type,
      });
      if (input.origin === "concept-promotion")
        recordInteraction({
          projectId: activeProjectId,
          type: "concept-promoted",
          targetCardId: cardId,
          sourceCardId: source.id,
          sourceAnchorId: anchorId,
        });
      if (input.origin === "question-reroute")
        recordInteraction({
          projectId: activeProjectId,
          type: "question-rerouted",
          targetCardId: cardId,
          sourceCardId: source.id,
          targetTurnId: input.sourceTurnId,
          relation: "branch",
        });
      const prompt =
        newCard.turns.length === 1 && newCard.turns[0].role === "user"
          ? newCard.turns[0].content
          : "";
      if (prompt)
        window.setTimeout(() => {
          void streamAnswer({
            cardId,
            cardsSnapshot: nextCards,
            edgesSnapshot: [...edges, edge],
            snapshotsSnapshot: [...snapshots, snapshot],
            references: [],
            relation: input.type,
          });
        }, 0);
      return cardId;
    },
    [activeProjectId, cards, edges, recordInteraction, snapshots, streamAnswer],
  );

  const send = useCallback(
    (text: string) => {
      if (!text.trim() || streamingTurnId) return;
      const card = cards.find(
        (candidate) =>
          candidate.id === currentCardId &&
          candidate.projectId === activeProjectId,
      );
      if (!card) return;
      const userTurn: Turn = {
        id: uid("turn"),
        role: "user",
        content: text.trim(),
        createdAt: Date.now(),
        status: "complete",
      };
      const nextCard = { ...card, turns: [...card.turns, userTurn] };
      const nextCards = cards.map((candidate) =>
        candidate.id === card.id ? nextCard : candidate,
      );
      const activeReferences = references;
      setCards(nextCards);
      setReferenceStore((current) =>
        current.filter((reference) => reference.projectId !== activeProjectId),
      );
      setView((current) => ({
        ...current,
        drafts: { ...current.drafts, [activeProjectId]: "" },
      }));
      // 引用只有真正随一次提问送出时才是强信号；单纯加到输入器不计入。
      activeReferences.forEach((reference) =>
        recordInteraction({
          projectId: activeProjectId,
          type: "reference-sent",
          targetCardId: card.id,
          sourceCardId: reference.anchor.cardId,
          targetTurnId: reference.anchor.turnId,
          sourceAnchorId: reference.anchor.id,
        }),
      );
      void streamAnswer({
        cardId: card.id,
        cardsSnapshot: nextCards,
        references: activeReferences,
      });
    },
    [
      activeProjectId,
      cards,
      currentCardId,
      references,
      recordInteraction,
      streamAnswer,
      streamingTurnId,
    ],
  );

  const retryLast = useCallback(() => {
    if (streamingTurnId) return;
    const card = cards.find((candidate) => candidate.id === currentCardId);
    if (!card) return;
    const user = [...card.turns].reverse().find((turn) => turn.role === "user");
    if (!user) return showToast({ text: "没有可重新生成的用户提问。" });
    void streamAnswer({ cardId: card.id, cardsSnapshot: cards, references });
  }, [
    cards,
    currentCardId,
    references,
    showToast,
    streamAnswer,
    streamingTurnId,
  ]);

  const setProposalTrayOpen = useCallback((open: boolean) => {
    setProposalTrayOpenState(open);
    if (!open) setSelectedProposalId(null);
  }, []);
  const clearProposalPreview = useCallback(
    () => setSelectedProposalId(null),
    [],
  );

  const previewProposal = useCallback(
    (id: string) => {
      const current = attentionRef.current;
      const proposal = current.proposals.find(
        (candidate) =>
          candidate.id === id &&
          candidate.projectId === activeProjectId &&
          ["queued", "opened"].includes(candidate.status),
      );
      if (!proposal) return;
      commitAttention({
        ...current,
        proposals: current.proposals.map((candidate) =>
          candidate.id === proposal.id && candidate.status === "queued"
            ? { ...candidate, status: "opened" }
            : candidate,
        ),
      });
      setSelectedProposalId(proposal.id);
      setProposalTrayOpenState(true);
      setMorningPrompt(null);
    },
    [activeProjectId, commitAttention],
  );

  const materializeProposal = useCallback(
    (id: string, finalQuestion: string) => {
      const question = finalQuestion.trim();
      if (!question) {
        showToast({ text: "请先写下要开始探索的问题。" });
        return null;
      }
      if (materializingProposalIdsRef.current.has(id)) return null;
      const current = attentionRef.current;
      const proposal = current.proposals.find(
        (candidate) =>
          candidate.id === id &&
          candidate.projectId === activeProjectId &&
          ["queued", "opened"].includes(candidate.status),
      );
      if (!proposal) return null;
      const parent = cards.find(
        (card) =>
          card.id === proposal.suggestedParentCardId &&
          card.projectId === activeProjectId &&
          !card.trashed,
      );
      if (!parent) {
        showToast({ text: "这条提案的来源卡片已不存在。" });
        return null;
      }
      materializingProposalIdsRef.current.add(id);
      try {
        const anchor = proposal.sourceAnchorIds
          .map((anchorId) => anchors.find((item) => item.id === anchorId))
          .find(Boolean);
        const sourceTurnId =
          anchor?.turnId ?? parent.turns[parent.turns.length - 1]?.id;
        const cardId = createCard({
          type: proposal.suggestedRelation,
          sourceCardId: parent.id,
          sourceTurnId,
          // 由提案物化时也冻结来源；branch 默认继承到当前来源轮次。
          contextThroughTurnId:
            proposal.suggestedRelation === "branch"
              ? (sourceTurnId ?? null)
              : undefined,
          sourceText: anchor?.exact ?? anchor?.text,
          sourceBlockText: anchor?.blockText,
          title: proposal.title,
          origin: "proposal",
          proposalId: proposal.id,
          seedTurns: [
            {
              id: uid("turn"),
              role: "user",
              content: question,
              createdAt: Date.now(),
              status: "complete",
            },
          ],
        });
        const afterCreate = attentionRef.current;
        commitAttention({
          ...afterCreate,
          proposals: afterCreate.proposals.map((candidate) =>
            candidate.id === proposal.id
              ? {
                  ...candidate,
                  status: "accepted",
                  acceptedCardId: cardId,
                }
              : candidate,
          ),
        });
        setMorningPrompt(null);
        setProposalTrayOpenState(false);
        setSelectedProposalId(null);
        showToast({ text: "已把幽灵分支变成正式卡片，正在生成回答。" });
        return cardId;
      } finally {
        materializingProposalIdsRef.current.delete(id);
      }
    },
    [activeProjectId, anchors, cards, commitAttention, createCard, showToast],
  );

  const dismissProposal = useCallback(
    (id: string) => {
      const current = attentionRef.current;
      const proposal = current.proposals.find(
        (candidate) =>
          candidate.id === id && candidate.projectId === activeProjectId,
      );
      if (!proposal) return;
      commitAttention({
        ...current,
        proposals: current.proposals.map((candidate) =>
          candidate.id === id
            ? {
                ...candidate,
                status: "dismissed",
                dismissedAt: Date.now(),
              }
            : candidate,
        ),
      });
      setSelectedProposalId((currentId) =>
        currentId === id ? null : currentId,
      );
      showToast({ text: "已忽略这条方向；不会自动创建卡片。" });
    },
    [activeProjectId, commitAttention, showToast],
  );

  const dismissMorningPrompt = useCallback(() => setMorningPrompt(null), []);
  const setAttentionPaused = useCallback(
    (paused: boolean) => {
      if (paused) closeAttentionSession(activeProjectId, "pagehide");
      setSettings((current) => ({ ...current, attentionPaused: paused }));
      if (paused) setMorningPrompt(null);
    },
    [activeProjectId, closeAttentionSession],
  );

  const deleteCard = useCallback(
    (id: string) => {
      const card = cards.find((candidate) => candidate.id === id);
      if (!card || card.projectId !== activeProjectId) return;
      const ids = subtreeIds(edges, id);
      const fallback =
        incomingEdge(edges, id)?.sourceCardId ??
        cards.find(
          (candidate) =>
            candidate.projectId === activeProjectId &&
            !candidate.trashed &&
            !ids.includes(candidate.id),
        )?.id;
      setCards((current) =>
        current.map((candidate) =>
          ids.includes(candidate.id)
            ? { ...candidate, trashed: true }
            : candidate,
        ),
      );
      if (ids.includes(currentCardId) && fallback)
        setView((current) => ({ ...current, currentCardId: fallback }));
      showToast({
        text: `已移入回收站 · ${card.title}${ids.length > 1 ? ` 及 ${ids.length - 1} 张下游卡片` : ""}`,
        actionLabel: "撤销",
        onAction: () => {
          setCards((current) =>
            current.map((candidate) =>
              ids.includes(candidate.id)
                ? { ...candidate, trashed: false }
                : candidate,
            ),
          );
          setView((current) => ({ ...current, currentCardId: id }));
          dismissToast();
        },
      });
    },
    [activeProjectId, cards, currentCardId, dismissToast, edges, showToast],
  );

  const setActiveProject = useCallback(
    (id: string) => {
      if (
        id === activeProjectId ||
        !projects.some((project) => project.id === id)
      )
        return;
      stopStream();
      closeAttentionSession(activeProjectId, "project-switch");
      setProposalTrayOpenState(false);
      setSelectedProposalId(null);
      const nextCard = preferredProjectCard(
        cards,
        id,
        view.lastCardByProject[id],
      );
      if (!nextCard) return;
      setView((current) => ({
        ...current,
        activeProjectId: id,
        currentCardId: nextCard.id,
        lastCardByProject: { ...current.lastCardByProject, [id]: nextCard.id },
      }));
      processAttention(Date.now(), id);
    },
    [
      activeProjectId,
      cards,
      closeAttentionSession,
      processAttention,
      projects,
      stopStream,
      view.lastCardByProject,
    ],
  );

  const contextForCurrent = useCallback(
    () => buildContext({ cards, edges, snapshots, references, currentCardId }),
    [cards, currentCardId, edges, references, snapshots],
  );
  const setCardAnswerMode = useCallback(
    (cardId: string, mode: AnswerMode) => {
      const card = cards.find(
        (candidate) =>
          candidate.id === cardId && candidate.projectId === activeProjectId,
      );
      if (!card || card.answerMode === mode) return;
      updateCard(cardId, (current) => ({ ...current, answerMode: mode }));
    },
    [activeProjectId, cards, updateCard],
  );
  const setDraft = useCallback(
    (value: string) =>
      setView((current) => ({
        ...current,
        drafts: { ...current.drafts, [activeProjectId]: value },
      })),
    [activeProjectId],
  );
  const rememberCardScroll = useCallback(
    (cardId: string, scrollTop: number) =>
      setView((current) => ({
        ...current,
        scrollPositions: { ...current.scrollPositions, [cardId]: scrollTop },
      })),
    [],
  );
  const cardScroll = useCallback(
    (cardId: string) => view.scrollPositions[cardId] ?? 0,
    [view.scrollPositions],
  );
  const toggleFavoriteCard = useCallback(
    (id: string) => {
      const card = cards.find(
        (candidate) =>
          candidate.id === id && candidate.projectId === activeProjectId,
      );
      if (!card) return;
      const active = !card.favorite;
      updateCard(id, (current) => ({ ...current, favorite: active }));
      recordInteraction({
        projectId: activeProjectId,
        type: "favorite-set",
        targetCardId: id,
        sourceCardId: id,
        active,
      });
    },
    [activeProjectId, cards, recordInteraction, updateCard],
  );
  const renameCard = useCallback(
    (id: string, title: string) => {
      const clean = title.replace(/\s+/g, " ").trim().slice(0, 80);
      const card = cards.find(
        (candidate) =>
          candidate.id === id && candidate.projectId === activeProjectId,
      );
      if (!card || !clean || clean === card.title) return;
      updateCard(id, (current) => ({ ...current, title: clean }));
      // ContextSnapshot already holds sourceTitle; renaming must never rewrite it.
      recordInteraction({
        projectId: activeProjectId,
        type: "title-edited",
        targetCardId: id,
        sourceCardId: id,
      });
    },
    [activeProjectId, cards, recordInteraction, updateCard],
  );
  const rerouteEditedQuestion = useCallback(
    (cardId: string, turnId: string, text: string) => {
      const card = cards.find(
        (candidate) =>
          candidate.id === cardId && candidate.projectId === activeProjectId,
      );
      const clean = text.trim();
      const turnIndex =
        card?.turns.findIndex((turn) => turn.id === turnId) ?? -1;
      const sourceTurn = turnIndex >= 0 ? card?.turns[turnIndex] : undefined;
      if (!card || !sourceTurn || sourceTurn.role !== "user" || !clean)
        throw new Error("只能从已有用户问题创建改道分支。");
      const priorTurnId =
        turnIndex > 0 ? (card.turns[turnIndex - 1]?.id ?? null) : null;
      return createCard({
        type: "branch",
        sourceCardId: card.id,
        sourceTurnId: sourceTurn.id,
        contextThroughTurnId: priorTurnId,
        title: `${card.title} · 改写路径`,
        origin: "question-reroute",
        seedTurns: [
          {
            id: uid("turn"),
            role: "user",
            content: clean,
            createdAt: Date.now(),
            status: "complete",
          },
        ],
      });
    },
    [activeProjectId, cards, createCard],
  );
  const markRead = useCallback(
    (id: string) => updateCard(id, (card) => ({ ...card, unread: false })),
    [updateCard],
  );
  const cacheConceptPreview = useCallback(
    (cardId: string, cacheKey: string, entry: ConceptPreviewCacheEntry) => {
      updateCard(cardId, (card) => ({
        ...card,
        conceptPreviewCache: { ...card.conceptPreviewCache, [cacheKey]: entry },
      }));
    },
    [updateCard],
  );
  const recordConceptPreviewOpened = useCallback(
    ({
      cardId,
      turnId,
      concept,
    }: {
      cardId: string;
      turnId?: string;
      concept: string;
    }) => {
      const card = cards.find(
        (candidate) =>
          candidate.id === cardId && candidate.projectId === activeProjectId,
      );
      if (!card) return;
      recordInteraction({
        projectId: activeProjectId,
        type: "concept-preview-opened",
        targetCardId: cardId,
        sourceCardId: cardId,
        targetTurnId: turnId,
        concept,
      });
    },
    [activeProjectId, cards, recordInteraction],
  );
  const recordCardDwell = useCallback(
    (cardId: string) => {
      const card = cards.find(
        (candidate) =>
          candidate.id === cardId && candidate.projectId === activeProjectId,
      );
      if (!card || document.visibilityState !== "visible") return;
      recordInteraction({
        projectId: activeProjectId,
        type: "card-dwell",
        targetCardId: cardId,
        sourceCardId: cardId,
      });
    },
    [activeProjectId, cards, recordInteraction],
  );
  const toggleCollapse = useCallback(
    (id: string) =>
      setView((current) => ({
        ...current,
        collapsed: current.collapsed.includes(id)
          ? current.collapsed.filter((item) => item !== id)
          : [...current.collapsed, id],
      })),
    [],
  );
  const addReference = useCallback(
    (anchor: SourceAnchor, sourceTitle: string) => {
      const excerpt = (anchor.text ?? anchor.exact ?? "").trim();
      if (!excerpt) return;
      const nextAnchor = {
        ...anchor,
        id: anchor.id ?? uid("anchor"),
        exact: anchor.exact ?? excerpt,
      };
      setAnchors((current) =>
        current.some((item) => item.id === nextAnchor.id)
          ? current
          : [...current, nextAnchor],
      );
      setReferenceStore((current) =>
        current.some(
          (reference) =>
            reference.projectId === activeProjectId &&
            reference.anchor.cardId === nextAnchor.cardId &&
            reference.excerpt === excerpt,
        )
          ? current
          : [
              ...current,
              {
                id: uid("ref"),
                projectId: activeProjectId,
                anchor: nextAnchor,
                sourceTitle,
                excerpt,
              },
            ],
      );
      showToast({ text: "已添加引用，将作为结构化上下文带入下一次提问" });
    },
    [activeProjectId, showToast],
  );
  const removeReference = useCallback(
    (id: string) =>
      setReferenceStore((current) =>
        current.filter((reference) => reference.id !== id),
      ),
    [],
  );
  const clearReferences = useCallback(
    () =>
      setReferenceStore((current) =>
        current.filter((reference) => reference.projectId !== activeProjectId),
      ),
    [activeProjectId],
  );
  const renameProject = useCallback(
    (id: string, name: string) =>
      setProjects((current) =>
        current.map((project) =>
          project.id === id
            ? { ...project, name, updatedAt: Date.now() }
            : project,
        ),
      ),
    [],
  );
  const togglePinProject = useCallback(
    (id: string) =>
      setProjects((current) =>
        current.map((project) =>
          project.id === id ? { ...project, pinned: !project.pinned } : project,
        ),
      ),
    [],
  );
  const createProject = useCallback(() => {
    const projectId = uid("project");
    const rootId = uid("card");
    setProjects((current) => [
      {
        id: projectId,
        name: "未命名项目",
        pinned: false,
        updatedAt: Date.now(),
      },
      ...current,
    ]);
    setCards((current) => [
      ...current,
      {
        id: rootId,
        projectId,
        title: "未命名卡片",
        turns: [],
        favorite: false,
        unread: false,
        concepts: [],
        answerMode: "general",
        createdAt: Date.now(),
      },
    ]);
    setView((current) => ({
      ...current,
      activeProjectId: projectId,
      currentCardId: rootId,
      lastCardByProject: { ...current.lastCardByProject, [projectId]: rootId },
    }));
  }, []);
  const deleteProject = useCallback(
    (id: string) => {
      const project = projects.find((candidate) => candidate.id === id);
      if (!project) return;
      const snapshot = latestRef.current;
      const attentionSnapshot = attentionRef.current;
      const removedCardIds = new Set(
        cards.filter((card) => card.projectId === id).map((card) => card.id),
      );
      const removedEdgeIds = new Set(
        edges
          .filter(
            (edge) =>
              removedCardIds.has(edge.sourceCardId) ||
              removedCardIds.has(edge.targetCardId),
          )
          .map((edge) => edge.id),
      );
      const remaining = projects.filter((candidate) => candidate.id !== id);
      const next = remaining[0];
      setProjects(remaining);
      setCards((current) => current.filter((card) => card.projectId !== id));
      setEdges((current) =>
        current.filter((edge) => !removedEdgeIds.has(edge.id)),
      );
      setAnchors((current) =>
        current.filter((anchor) => !removedCardIds.has(anchor.cardId)),
      );
      setSnapshots((current) =>
        current.filter((item) => !removedEdgeIds.has(item.edgeId)),
      );
      setReferenceStore((current) =>
        current.filter((reference) => reference.projectId !== id),
      );
      commitAttention({
        events: attentionSnapshot.events.filter(
          (event) => event.projectId !== id,
        ),
        sessions: attentionSnapshot.sessions.filter(
          (session) => session.projectId !== id,
        ),
        proposals: attentionSnapshot.proposals.filter(
          (proposal) => proposal.projectId !== id,
        ),
      });
      void deleteAttentionForProject(id);
      const nextCards = cards.filter((card) => card.projectId !== id);
      const nextCard = next
        ? preferredProjectCard(nextCards, next.id)
        : undefined;
      setView((current) => {
        const cleaned = pruneProjectScopedState({
          projects: remaining,
          cards: nextCards,
          view: current,
          settings: defaultSettings,
        }).view;
        return activeProjectId === id && nextCard
          ? {
              ...cleaned,
              activeProjectId: next.id,
              currentCardId: nextCard.id,
            }
          : cleaned;
      });
      setSettings(
        (current) =>
          pruneProjectScopedState({
            projects: remaining,
            cards: nextCards,
            view: defaultView(),
            settings: current,
          }).settings,
      );
      showToast({
        text: `项目已移入回收站 · ${project.name}`,
        actionLabel: "撤销",
        onAction: () => {
          setProjects(snapshot.projects);
          setCards(snapshot.cards);
          setEdges(snapshot.edges);
          setAnchors(snapshot.anchors);
          setSnapshots(snapshot.snapshots);
          setReferenceStore(snapshot.references);
          setView(snapshot.view);
          setSettings(snapshot.settings);
          commitAttention(attentionSnapshot);
          // 撤销要把 deleteAttentionForProject 删掉的行整体写回，之后基线随之复位。
          void saveAttentionState(attentionSnapshot).then(() => {
            persistedAttentionRef.current = attentionSnapshot;
          });
          dismissToast();
        },
      });
    },
    [
      activeProjectId,
      cards,
      commitAttention,
      dismissToast,
      edges,
      projects,
      showToast,
    ],
  );

  const portable = useCallback(
    (projectId: string) => {
      const project = projects.find((candidate) => candidate.id === projectId);
      if (!project) throw new Error("找不到项目。");
      const selectedCards = cards.filter(
        (card) => card.projectId === projectId,
      );
      const ids = new Set(selectedCards.map((card) => card.id));
      return {
        version: 1 as const,
        project,
        cards: selectedCards,
        edges: edges.filter(
          (edge) => ids.has(edge.sourceCardId) && ids.has(edge.targetCardId),
        ),
        anchors: anchors.filter((anchor) => ids.has(anchor.cardId)),
        snapshots: snapshots.filter((snapshot) =>
          edges.some(
            (edge) => ids.has(edge.targetCardId) && edge.id === snapshot.edgeId,
          ),
        ),
        references: referenceStore.filter(
          (reference) => reference.projectId === projectId,
        ),
        viewState: view,
      };
    },
    [anchors, cards, edges, projects, referenceStore, snapshots, view],
  );
  const exportProject = useCallback(
    async (format: "md-dir" | "canvas" | "bundle") => {
      const artifacts = await formatAdapters[format].export(
        portable(activeProjectId),
      );
      artifacts.forEach(downloadArtifact);
      showToast({
        text: `已导出 ${artifacts.length} 个「${format === "bundle" ? "无损项目包" : format === "canvas" ? "JSON Canvas + Markdown" : "Markdown 文件夹"}」文件。`,
      });
    },
    [activeProjectId, portable, showToast],
  );
  const exportAllBackup = useCallback(async () => {
    const artifacts = await Promise.all(
      projects.map((project) =>
        formatAdapters.bundle
          .export(portable(project.id))
          .then((items) => items[0]),
      ),
    );
    artifacts.forEach(downloadArtifact);
    showToast({ text: `已导出全部 ${artifacts.length} 个项目备份。` });
  }, [portable, projects, showToast]);
  const importFiles = useCallback(
    async (format: ImportInput["format"], files: File[]) => {
      const key = format === "md-file" ? "md-dir" : format;
      const adapter = formatAdapters[key as "md-dir" | "canvas" | "bundle"];
      const imported = await adapter.import({ format, files });
      if (!imported.cards.length) throw new Error("导入内容没有卡片。");

      const projectId = projects.some(
        (project) => project.id === imported.project.id,
      )
        ? uid("project")
        : imported.project.id;
      const occupiedCardIds = new Set(cards.map((card) => card.id));
      const occupiedEdgeIds = new Set(edges.map((edge) => edge.id));
      const cardIdMap = new Map<string, string>();
      const edgeIdMap = new Map<string, string>();
      const normalizedCards = imported.cards.map((card) => {
        const nextId =
          occupiedCardIds.has(card.id) || cardIdMap.has(card.id)
            ? uid("card")
            : card.id;
        cardIdMap.set(card.id, nextId);
        occupiedCardIds.add(nextId);
        return { ...card, id: nextId, projectId };
      });
      const normalizedEdges = imported.edges
        .map((edge) => {
          const nextId =
            occupiedEdgeIds.has(edge.id) || edgeIdMap.has(edge.id)
              ? uid("edge")
              : edge.id;
          edgeIdMap.set(edge.id, nextId);
          occupiedEdgeIds.add(nextId);
          return {
            ...edge,
            id: nextId,
            sourceCardId: cardIdMap.get(edge.sourceCardId) ?? edge.sourceCardId,
            targetCardId: cardIdMap.get(edge.targetCardId) ?? edge.targetCardId,
          };
        })
        .filter(
          (edge) =>
            normalizedCards.some((card) => card.id === edge.sourceCardId) &&
            normalizedCards.some((card) => card.id === edge.targetCardId),
        );
      const normalizedAnchors = imported.anchors.map((anchor) => ({
        ...anchor,
        id:
          anchor.id && anchors.some((candidate) => candidate.id === anchor.id)
            ? uid("anchor")
            : anchor.id,
        cardId: cardIdMap.get(anchor.cardId) ?? anchor.cardId,
        turnId: anchor.turnId,
      }));
      const normalizedSnapshots = imported.snapshots.map((snapshot) => ({
        ...snapshot,
        id: snapshots.some((candidate) => candidate.id === snapshot.id)
          ? uid("snapshot")
          : snapshot.id,
        edgeId: edgeIdMap.get(snapshot.edgeId) ?? snapshot.edgeId,
      }));
      const root = normalizedCards[0];
      const importedProject = {
        ...imported.project,
        id: projectId,
        updatedAt: Date.now(),
      };

      // State changes happen only after the whole input has been validated and normalized.
      setProjects((current) => [importedProject, ...current]);
      setCards((current) => [...current, ...normalizedCards]);
      setEdges((current) => [...current, ...normalizedEdges]);
      setAnchors((current) => [...current, ...normalizedAnchors]);
      setSnapshots((current) => [...current, ...normalizedSnapshots]);
      setReferenceStore((current) => [
        ...current,
        ...imported.references.map((reference) => ({
          ...reference,
          id: current.some((candidate) => candidate.id === reference.id)
            ? uid("ref")
            : reference.id,
          projectId,
          anchor: {
            ...reference.anchor,
            cardId:
              cardIdMap.get(reference.anchor.cardId) ?? reference.anchor.cardId,
          },
        })),
      ]);
      setView((current) => ({
        ...current,
        activeProjectId: projectId,
        currentCardId: root.id,
        lastCardByProject: {
          ...current.lastCardByProject,
          [projectId]: root.id,
        },
      }));
      showToast({
        text: `已导入「${importedProject.name}」· ${normalizedCards.length} 张卡片`,
      });
    },
    [anchors, cards, edges, projects, showToast, snapshots],
  );
  const clearLocalData = useCallback(async () => {
    await clearWorkspace();
    const next = seedSnapshot();
    await saveWorkspace(next);
    // 库被整体重写，两条增量基线必须跟着复位，否则下一次 diff 会拿旧内容比较。
    persistedRef.current = next;
    persistedAttentionRef.current = { events: [], sessions: [], proposals: [] };
    setProjects(next.projects);
    setCards(next.cards);
    setEdges(next.edges);
    setAnchors(next.anchors);
    setSnapshots(next.snapshots);
    setReferenceStore(next.references);
    setView(next.view);
    setSettings(next.settings);
    attentionRef.current = { events: [], sessions: [], proposals: [] };
    setInteractionEvents([]);
    setSessions([]);
    setProposals([]);
    setMorningPrompt(null);
    setProposalTrayOpenState(false);
    setSelectedProposalId(null);
    showToast({ text: "已清除本地数据，并恢复示例项目。" });
  }, [showToast]);

  const value = useMemo<Ctx>(
    () => ({
      projects,
      activeProjectId,
      cards,
      edges,
      anchors,
      snapshots,
      interactionEvents,
      sessions,
      proposals,
      activeProposals,
      attentionMetrics,
      attentionPaused: Boolean(settings.attentionPaused),
      morningPrompt,
      proposalTrayOpen,
      selectedProposalId,
      currentCardId,
      references,
      draft,
      collapsed,
      toast,
      streamingTurnId,
      lastCreated,
      hydrated,
      provider,
      cardById,
      setActiveProject,
      renameProject,
      togglePinProject,
      createProject,
      deleteProject,
      setCurrentCard,
      createCard,
      setCardAnswerMode,
      renameCard,
      rerouteEditedQuestion,
      deleteCard,
      toggleFavoriteCard,
      toggleCollapse,
      markRead,
      cacheConceptPreview,
      recordConceptPreviewOpened,
      recordCardDwell,
      addReference,
      removeReference,
      clearReferences,
      setDraft,
      rememberCardScroll,
      cardScroll,
      send,
      stopStream,
      retryLast,
      contextForCurrent,
      refreshProvider,
      importFiles,
      exportProject,
      exportAllBackup,
      clearLocalData,
      previewProposal,
      materializeProposal,
      clearProposalPreview,
      dismissProposal,
      setProposalTrayOpen,
      dismissMorningPrompt,
      setAttentionPaused,
      showToast,
      dismissToast,
    }),
    [
      projects,
      activeProjectId,
      cards,
      edges,
      anchors,
      snapshots,
      interactionEvents,
      sessions,
      proposals,
      activeProposals,
      attentionMetrics,
      settings.attentionPaused,
      morningPrompt,
      proposalTrayOpen,
      selectedProposalId,
      currentCardId,
      references,
      draft,
      collapsed,
      toast,
      streamingTurnId,
      lastCreated,
      hydrated,
      provider,
      cardById,
      setActiveProject,
      renameProject,
      togglePinProject,
      createProject,
      deleteProject,
      setCurrentCard,
      createCard,
      setCardAnswerMode,
      renameCard,
      rerouteEditedQuestion,
      deleteCard,
      toggleFavoriteCard,
      toggleCollapse,
      markRead,
      cacheConceptPreview,
      recordConceptPreviewOpened,
      recordCardDwell,
      addReference,
      removeReference,
      clearReferences,
      setDraft,
      rememberCardScroll,
      cardScroll,
      send,
      stopStream,
      retryLast,
      contextForCurrent,
      refreshProvider,
      importFiles,
      exportProject,
      exportAllBackup,
      clearLocalData,
      previewProposal,
      materializeProposal,
      clearProposalPreview,
      dismissProposal,
      setProposalTrayOpen,
      dismissMorningPrompt,
      setAttentionPaused,
      showToast,
      dismissToast,
    ],
  );
  return <StoreCtx.Provider value={value}>{children}</StoreCtx.Provider>;
}
