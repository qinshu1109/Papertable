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
  probeProviderCapabilities,
  type ProviderHealth,
} from "./lib/provider";
import {
  AgentRunFailure,
  controlledCitations,
  runAgentTurn,
} from "./lib/agent";
import {
  exportNoteCorpusForBackup,
  importNoteCorpusFromBackup,
  noteLibraries,
} from "./lib/notes";
import { connectDesktopVault } from "./lib/notes/tauri";
import {
  backupCounts,
  buildLibraryBackup,
  diffBackupCounts,
  parseLibraryBackup,
} from "./lib/backup";
import {
  SENTINEL_INSTRUCTION,
  createAnswerGate,
  visibleModelOutput,
} from "./lib/modelOutput";
import { createStreamThrottle } from "./lib/streamThrottle";
import { vault } from "./lib/vault";
import {
  DEFAULT_VAULT_SUBTREE,
  planProjectSync,
  syncableCards,
} from "./lib/vaultPlan";
import { parseWikilinks, stripWikilinks } from "./lib/wikilink";
import { preferredProjectCard } from "./lib/projectScope";
import {
  attentionAsUpsert,
  diffAttention,
  diffWorkspace,
  type AttentionSnapshot,
  type AttentionUpsert,
  type WorkspaceSnapshot,
  type WorkspaceUpsert,
} from "./lib/delta";
import {
  applyAttentionChanges,
  applyChanges,
  clearWorkspace,
  deleteProjectCascade,
  deleteProposals,
  deleteReferences,
  loadAttentionState,
  importLibrary,
  loadWorkspace,
  putAttentionState,
  saveWorkspace,
  seedIfEmpty,
} from "./lib/storage";
import { EDGE_META } from "./types";
import type {
  AnswerMode,
  AgentExecutionMode,
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
  VaultConflict,
  ViewState,
} from "./types";
import type { IndexReport, NoteLibrary } from "./lib/notes";

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
  providerCapabilities: [],
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

/** 变更点上「这批 id 没了」的显式意图，用于驱动显式删除。 */
function removedIds<T extends { id: string }>(
  before: readonly T[],
  after: readonly T[],
): string[] {
  if (!before.length) return [];
  const live = new Set(after.map((row) => row.id));
  return before.filter((row) => !live.has(row.id)).map((row) => row.id);
}

type RemovedProject = {
  workspace: WorkspaceUpsert;
  attention: AttentionUpsert;
};

/**
 * 项目级联删除后把基线里的对应行摘掉，让基线继续等于「库里真正有什么」。
 * 按级联实际删掉的 id 摘，而不是按 projectId 重新推断——那样又会退回到用内存
 * 猜测数据库内容。
 */
function withoutProject(
  baseline: WorkspaceSnapshot | null,
  projectId: string,
  removed: RemovedProject,
): WorkspaceSnapshot | null {
  if (!baseline) return baseline;
  const cardIds = new Set(removed.workspace.cards.upserts.map((row) => row.id));
  const edgeIds = new Set(removed.workspace.edges.upserts.map((row) => row.id));
  const anchorIds = new Set(
    removed.workspace.anchors.upserts.map((row) => row.id),
  );
  const snapshotIds = new Set(
    removed.workspace.snapshots.upserts.map((row) => row.id),
  );
  const referenceIds = new Set(
    removed.workspace.references.upserts.map((row) => row.id),
  );
  return {
    ...baseline,
    projects: baseline.projects.filter((row) => row.id !== projectId),
    cards: baseline.cards.filter((row) => !cardIds.has(row.id)),
    edges: baseline.edges.filter((row) => !edgeIds.has(row.id)),
    anchors: baseline.anchors.filter(
      (row) => !row.id || !anchorIds.has(row.id),
    ),
    snapshots: baseline.snapshots.filter((row) => !snapshotIds.has(row.id)),
    references: baseline.references.filter((row) => !referenceIds.has(row.id)),
  };
}

function withoutAttentionProject(
  baseline: AttentionSnapshot | null,
  projectId: string,
): AttentionSnapshot | null {
  if (!baseline) return baseline;
  return {
    events: baseline.events.filter((row) => row.projectId !== projectId),
    sessions: baseline.sessions.filter((row) => row.projectId !== projectId),
    proposals: baseline.proposals.filter((row) => row.projectId !== projectId),
  };
}

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
  streamingCardIds: ReadonlySet<string>;
  backgroundGenerationCount: number;
  streamingTurnId: string | null;
  lastCreated: { cardId: string; type: EdgeType } | null;
  hydrated: boolean;
  provider: ProviderHealth | null;
  agentMode: AgentExecutionMode;
  noteLibraries: NoteLibrary[];
  boundNoteLibraryIds: string[];

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
  stopStream: (cardId?: string) => void;
  retryLast: () => void;
  contextForCurrent: () => BuiltContext;
  refreshProvider: () => Promise<ProviderHealth | null>;
  refreshNoteLibraries: () => Promise<void>;
  importNoteLibrary: (files: File[], name?: string) => Promise<IndexReport>;
  setProjectNoteLibraries: (libraryIds: string[]) => Promise<void>;
  removeNoteLibrary: (id: string) => Promise<void>;
  importFiles: (format: ImportInput["format"], files: File[]) => Promise<void>;
  exportProject: (format: "md-dir" | "canvas" | "bundle") => Promise<void>;
  exportAllBackup: () => Promise<void>;
  exportLibraryBackup: () => Promise<void>;
  importLibraryBackup: (
    text: string,
  ) => Promise<{ equal: boolean; mismatches: string[] }>;
  /** 桌面版为 true；web 端整个同步 UI 都不出现。 */
  vaultAvailable: boolean;
  vaultConflicts: VaultConflict[];
  vaultPath?: string;
  vaultSyncedProjects: string[];
  chooseVaultPath: () => Promise<void>;
  rescanVault: () => Promise<void>;
  vaultIndexed: number;
  toggleProjectVaultSync: (projectId: string) => Promise<void>;
  resolveVaultConflict: (
    cardId: string,
    keep: "papertable" | "note",
  ) => Promise<void>;
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
  /** 挂起中的 vault 冲突。常驻横幅，不是 toast——它需要用户做一次二选一。 */
  const [vaultConflicts, setVaultConflicts] = useState<VaultConflict[]>([]);
  const [vaultIndexed, setVaultIndexed] = useState(0);
  /** 资料库与卡片工作区完全分表；这里只缓存 UI 视图与当前项目的已绑定范围。 */
  const [noteLibraryList, setNoteLibraryList] = useState<NoteLibrary[]>([]);
  const [boundNoteLibraryIds, setBoundNoteLibraryIds] = useState<string[]>([]);
  const vaultTimer = useRef<number | null>(null);
  const [streamingTurnsByCard, setStreamingTurnsByCard] = useState<
    Record<string, string>
  >({});
  const [lastCreated, setLastCreated] = useState<{
    cardId: string;
    type: EdgeType;
  } | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const streamingTurnsRef = useRef<Record<string, string>>({});
  const generationTasksRef = useRef(
    new Map<
      string,
      {
        cardId: string;
        controller: AbortController;
        flush: () => void;
      }
    >(),
  );
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
  const streamingCardIds = useMemo(
    () => new Set(Object.keys(streamingTurnsByCard)),
    [streamingTurnsByCard],
  );
  const streamingTurnId = streamingTurnsByCard[currentCardId] ?? null;
  const backgroundGenerationCount = Math.max(
    0,
    streamingCardIds.size - (streamingTurnId ? 1 : 0),
  );
  const hasActiveGenerations = streamingCardIds.size > 0;
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

  const agentMode: AgentExecutionMode =
    settings.providerCapabilities?.find(
      (capability) =>
        capability.baseUrl ===
          (settings.providerBaseUrl ?? "https://cozai.net/v1") &&
        capability.model === settings.model,
    )?.mode ?? "two-stage";

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
      // 播种在事务内重新确认库是空的，两个标签页同时冷启不会各写一份种子。
      const next = saved ?? (await seedIfEmpty(seed));
      if (!active) return;
      // 落库基线 = 此刻库里真正的内容。下面的裁剪与默认值补齐会成为第一次
      // 增量保存的 diff 内容。注意力基线用 savedAttention 而不是裁剪后的结果：
      // 基线要如实反映库里有什么。
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
        providerCapabilities: next.settings.providerCapabilities ?? [],
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
      // 水合时也会跑一次生命周期淘汰；被清理掉的提案要显式从库里删掉，否则
      // 下次重载又会被读回来。
      const purged = removedIds(savedAttention.proposals, processed.proposals);
      if (purged.length) void deleteProposals(purged);
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
    const delay = hasActiveGenerations
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
    hasActiveGenerations,
  ]);

  useEffect(
    () => () => {
      if (persistTimer.current) window.clearTimeout(persistTimer.current);
    },
    [],
  );

  useEffect(
    () => () => {
      generationTasksRef.current.forEach((task) => task.controller.abort());
      generationTasksRef.current.clear();
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

  const refreshNoteLibraries = useCallback(async () => {
    const [libraries, bindings] = await Promise.all([
      noteLibraries.listLibraries(),
      noteLibraries.projectLibraryIds(activeProjectId),
    ]);
    setNoteLibraryList(libraries);
    setBoundNoteLibraryIds(bindings);
  }, [activeProjectId]);

  useEffect(() => {
    if (!hydrated) return;
    void refreshNoteLibraries().catch(() => {
      // 资料库不可用不能阻断原有卡片流程；发送时会明确显示为无绑定资料。
      setNoteLibraryList([]);
      setBoundNoteLibraryIds([]);
    });
  }, [hydrated, refreshNoteLibraries]);

  const importNoteLibrary = useCallback(
    async (files: File[], name?: string): Promise<IndexReport> => {
      if (!files.length) throw new Error("请先选择至少一篇 Markdown 笔记。");
      const now = Date.now();
      const library: NoteLibrary = {
        id: uid("library"),
        name:
          name?.trim() ||
          `只读资料库 · ${new Date(now).toLocaleDateString("zh-CN")}`,
        kind: "web-import",
        createdAt: now,
        updatedAt: now,
      };
      const report = await noteLibraries.importFiles({
        library,
        files: await Promise.all(
          files.map(async (file) => ({
            relativePath:
              (file as File & { webkitRelativePath?: string })
                .webkitRelativePath || file.name,
            content: await file.text(),
            modifiedAt: file.lastModified || now,
          })),
        ),
      });
      const previous = await noteLibraries.projectLibraryIds(activeProjectId);
      await noteLibraries.setProjectLibraries(activeProjectId, [
        ...previous,
        library.id,
      ]);
      await refreshNoteLibraries();
      showToast({
        text: `已建立只读资料库：${report.documents} 篇笔记、${report.chunks} 个片段；已绑定当前项目。`,
      });
      return report;
    },
    [activeProjectId, refreshNoteLibraries, showToast],
  );

  const setProjectNoteLibraries = useCallback(
    async (libraryIds: string[]) => {
      await noteLibraries.setProjectLibraries(activeProjectId, libraryIds);
      await refreshNoteLibraries();
    },
    [activeProjectId, refreshNoteLibraries],
  );

  const removeNoteLibrary = useCallback(
    async (id: string) => {
      await noteLibraries.removeLibrary(id);
      await refreshNoteLibraries();
      showToast({ text: "已移除只读资料库；项目卡片没有被修改。" });
    },
    [refreshNoteLibraries, showToast],
  );

  const ensureProviderCapability = useCallback(async () => {
    const current = latestRef.current.settings;
    const baseUrl = current.providerBaseUrl ?? "https://cozai.net/v1";
    const model = current.model;
    const cached = current.providerCapabilities?.find(
      (capability) =>
        capability.baseUrl === baseUrl && capability.model === model,
    );
    if (cached) return cached;
    try {
      const probe = await probeProviderCapabilities();
      const next = {
        baseUrl,
        model,
        mode: probe.mode,
        streamingToolCalls: probe.streamingToolCalls,
        toolResultAccepted: probe.toolResultAccepted,
        testedAt: Date.parse(probe.testedAt) || Date.now(),
      } as const;
      setSettings((previous) => {
        // A late probe for an old endpoint must never overwrite a new setting.
        if (
          previous.model !== model ||
          (previous.providerBaseUrl ?? "https://cozai.net/v1") !== baseUrl
        )
          return previous;
        return {
          ...previous,
          providerCapabilities: [
            ...(previous.providerCapabilities ?? []).filter(
              (capability) =>
                capability.baseUrl !== baseUrl || capability.model !== model,
            ),
            next,
          ].slice(-12),
        };
      });
      return next;
    } catch {
      // Unknown is intentionally deterministic: safe two-stage retrieval.
      return {
        baseUrl,
        model,
        mode: "two-stage" as const,
        streamingToolCalls: false,
        toolResultAccepted: false,
        testedAt: Date.now(),
      };
    }
  }, []);

  const updateCard = useCallback(
    (cardId: string, updater: (card: Card) => Card) =>
      setCards((current) =>
        current.map((card) => (card.id === cardId ? updater(card) : card)),
      ),
    [],
  );

  const commitAttention = useCallback((next: AttentionSnapshot) => {
    // 提案会被生命周期淘汰（冷却后 7 天清理、被更强候选替换）。这是变更点的显式
    // 意图：前后两个内存值由同一段代码在同一 tick 产出，和「永不对账的持久化基线」
    // 是两回事。不在这里删，被淘汰的提案会在下次重载时复活。
    const gone = removedIds(attentionRef.current.proposals, next.proposals);
    if (gone.length) void deleteProposals(gone);
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
      // 必须是 upsert-only：这里曾经 clear() 掉会话与提案再用本标签页的内存重写，
      // 于是关闭第二个标签页就会销毁第一个标签页生成的全部提案。
      void putAttentionState(attentionRef.current);
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

  const unregisterGeneration = useCallback((cardId: string, turnId: string) => {
    if (streamingTurnsRef.current[cardId] !== turnId) return;
    const next = { ...streamingTurnsRef.current };
    delete next[cardId];
    streamingTurnsRef.current = next;
    setStreamingTurnsByCard(next);
  }, []);

  const stopStream = useCallback(
    (cardId = currentCardId) => {
      const id = streamingTurnsRef.current[cardId];
      if (!id) return;
      const task = generationTasksRef.current.get(id);
      // 缓冲区里可能还有已经通过输出闸门、但尚未到下一次 UI 提交节拍的正文。
      // 先 flush 再标 stopped，停止不会丢掉最后几十毫秒的可见内容。
      task?.flush();
      task?.controller.abort();
      generationTasksRef.current.delete(id);
      unregisterGeneration(cardId, id);
      // 只重建拥有这条轮次的卡片、以及那一条轮次。之前这里无条件重建了每张卡片
      // 和每条轮次的对象，而增量保存按引用比较——一次停止会把整个工作区的轮次
      // 全部重写一遍。
      setCards((current) =>
        current.map((card) =>
          card.id === cardId && card.turns.some((turn) => turn.id === id)
            ? {
                ...card,
                turns: card.turns.map((turn) =>
                  turn.id === id
                    ? { ...turn, streaming: false, status: "stopped" }
                    : turn,
                ),
              }
            : card,
        ),
      );
    },
    [currentCardId, unregisterGeneration],
  );

  const runBackgroundTasks = useCallback(
    async (cardId: string, title: string, answer: string) => {
      const titlePrompt = [
        {
          role: "system" as const,
          content: `根据用户问题和回答，给出一个不超过 18 个中文字符的知识卡片标题。只输出标题。\n${SENTINEL_INSTRUCTION}`,
        },
        {
          role: "user" as const,
          content: `当前标题：${title}\n回答：${answer.slice(0, 1800)}`,
        },
      ];
      const conceptPrompt = [
        {
          role: "system" as const,
          content: `从文本中找出最多 6 个值得继续探索的概念。只输出 JSON 字符串数组；每一项必须逐字出现在文本中。\n${SENTINEL_INSTRUCTION}`,
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
        // 必须在 28 字截断之前 sanitize，否则截断只会留下一段推理片段当标题。
        const clean = visibleModelOutput(newTitle.value)
          .replace(/[\n#*`"“”]/g, "")
          .trim()
          .slice(0, 28);
        if (clean)
          updateCard(cardId, (card) =>
            card.title === title ? { ...card, title: clean } : card,
          );
      }
      if (conceptText.status === "fulfilled") {
        const terms = parseStructuredArray(
          visibleModelOutput(conceptText.value),
        )
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
      if (!target || streamingTurnsRef.current[input.cardId]) return;
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
      const nextStreaming = {
        ...streamingTurnsRef.current,
        [input.cardId]: aiId,
      };
      streamingTurnsRef.current = nextStreaming;
      setStreamingTurnsByCard(nextStreaming);
      const controller = new AbortController();
      // 闸门的缓冲区只存在于这个闭包里，从不进入 state，所以被停止时结构上
      // 不可能把未释放的草稿刷到盘上。
      const gate = createAnswerGate();
      let answer = "";
      const throttle = createStreamThrottle<string>({
        commit: (content) =>
          updateCard(input.cardId, (card) => ({
            ...card,
            turns: card.turns.map((turn) =>
              turn.id === aiId &&
              turn.status === "streaming" &&
              content.length >= turn.content.length
                ? { ...turn, content }
                : turn,
            ),
          })),
        schedule: (callback, delay) => window.setTimeout(callback, delay),
        cancel: (id) => window.clearTimeout(id),
        // 当前可见卡片保持平滑；切到别的卡片、别的项目或把应用放到后台后，
        // 只降低 React/Markdown 刷新频率，不停止模型流。
        delayForNextCommit: () =>
          document.visibilityState === "visible" &&
          latestRef.current.view.currentCardId === input.cardId
            ? 80
            : 360,
      });
      generationTasksRef.current.set(aiId, {
        cardId: input.cardId,
        controller,
        flush: throttle.flush,
      });
      try {
        const built = buildContext({
          cards: input.cardsSnapshot,
          edges: input.edgesSnapshot ?? edges,
          snapshots: input.snapshotsSnapshot ?? snapshots,
          references: input.references,
          currentCardId: input.cardId,
        });
        // 资料库范围在一轮开始时从宿主绑定表冻结。模型工具永远拿不到
        // libraryId、Vault 路径或项目 scope，切项目也不会改变这次后台任务的范围。
        const libraryIds = await noteLibraries.projectLibraryIds(
          target.projectId,
        );
        // 普通卡片聊天不需要先花一次真实模型请求探测工具能力。只有用户明确
        // 绑定了只读资料库，才探测并进入 Harness；这也避免无资料项目首问变慢。
        const capability = libraryIds.length
          ? await ensureProviderCapability()
          : undefined;
        const outcome = await runAgentTurn({
          built,
          projectId: target.projectId,
          libraryIds,
          capability,
          signal: controller.signal,
          onPhase: (agentPhase) =>
            updateCard(input.cardId, (card) => ({
              ...card,
              turns: card.turns.map((turn) =>
                turn.id === aiId && turn.status === "streaming"
                  ? { ...turn, agentPhase }
                  : turn,
              ),
            })),
          onToken: (event) => {
            gate.push(event.text, event.channel);
            const nextAnswer = gate.visible();
            if (nextAnswer === answer) return;
            answer = nextAnswer;
            throttle.push(answer);
          },
        });
        if (!controller.signal.aborted) {
          // 收尾 flush 只在正常结束时发生；中断路径永远不会走到这里。
          answer = outcome.directAnswer ?? gate.finish();
          throttle.dispose();
          if (!answer.trim())
            throw new Error("模型没有返回可显示的最终文本，请重试。");
          const cited = controlledCitations(answer, outcome.readChunks);
          answer = cited.content;
          updateCard(input.cardId, (card) => ({
            ...card,
            turns: card.turns.map((turn) =>
              turn.id === aiId
                ? {
                    ...turn,
                    content: answer,
                    streaming: false,
                    status: "complete",
                    agentPhase: undefined,
                    agentRun: outcome.trace,
                    citations: cited.citations,
                  }
                : turn,
            ),
          }));
          if (answer.trim())
            void runBackgroundTasks(input.cardId, target.title, answer);
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          throttle.dispose();
          const message =
            error instanceof Error ? error.message : "模型生成失败。";
          const agentRun =
            error instanceof AgentRunFailure ? error.trace : undefined;
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
                    agentPhase: undefined,
                    ...(agentRun ? { agentRun } : {}),
                  }
                : turn,
            ),
          }));
          showToast({ text: message });
        }
      } finally {
        throttle.dispose();
        generationTasksRef.current.delete(aiId);
        unregisterGeneration(input.cardId, aiId);
      }
    },
    [
      edges,
      ensureProviderCapability,
      runBackgroundTasks,
      settings.model,
      showToast,
      snapshots,
      unregisterGeneration,
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
      // 提问里写的 [[双链]] 也算这次带入的引用。解析是异步的，所以先发出这一轮，
      // 解析到了就作为下一次的引用留在输入器里——绝不为了等它而卡住发送。
      void resolveWikilinks(text, activeProjectId).then((chips) => {
        if (chips.length)
          setReferenceStore((current) => [...current, ...chips]);
      });
      setCards(nextCards);
      setReferenceStore((current) => {
        const cleared = current
          .filter((reference) => reference.projectId === activeProjectId)
          .map((reference) => reference.id);
        if (cleared.length) void deleteReferences(cleared);
        return current.filter(
          (reference) => reference.projectId !== activeProjectId,
        );
      });
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

  /**
   * 取消跟踪并删掉这批卡片的笔记。
   *
   * 同步签名的 fire-and-forget：调用点都在状态更新的路径上，不该为了删文件变成
   * async，删失败也绝不能回滚本地数据。
   *
   * vault 路径从 `latestRef` 读而不是从闭包里的 `settings` 读：它的调用方
   * (`deleteCard` / `deleteProject`) 的依赖数组里没有它，闭包会停在创建它的那一次
   * 渲染上——换过知识库目录之后就会拿着旧路径去删。
   */
  const forgetInVault = useCallback((cardIds: string[]) => {
    const { vaultPath, vaultSubtree } = latestRef.current.settings;
    if (!vault.available || !vaultPath || !cardIds.length) return;
    void vault
      .forget({
        vault: vaultPath,
        subtree: vaultSubtree ?? DEFAULT_VAULT_SUBTREE,
        cardIds,
      })
      .catch(() => undefined);
  }, []);

  const deleteCard = useCallback(
    (id: string) => {
      const card = cards.find((candidate) => candidate.id === id);
      if (!card || card.projectId !== activeProjectId) return;
      const ids = subtreeIds(edges, id);
      ids.forEach((cardId) => stopStream(cardId));
      const fallback =
        incomingEdge(edges, id)?.sourceCardId ??
        cards.find(
          (candidate) =>
            candidate.projectId === activeProjectId &&
            !candidate.trashed &&
            !ids.includes(candidate.id),
        )?.id;
      // 进回收站的卡片要连带删掉知识库里的笔记，否则它会永远留在那里。
      forgetInVault(ids);
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
    [
      activeProjectId,
      cards,
      currentCardId,
      dismissToast,
      edges,
      showToast,
      stopStream,
    ],
  );

  const setActiveProject = useCallback(
    (id: string) => {
      if (
        id === activeProjectId ||
        !projects.some((project) => project.id === id)
      )
        return;
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
  // 引用是普通交互里唯一的硬删除。调用点永远拿得到具体 id，所以直接告诉存储层
  // 删哪几行，而不是让它去比较内存基线。
  const removeReference = useCallback((id: string) => {
    setReferenceStore((current) =>
      current.filter((reference) => reference.id !== id),
    );
    void deleteReferences([id]);
  }, []);
  const clearReferences = useCallback(() => {
    setReferenceStore((current) => {
      const cleared = current
        .filter((reference) => reference.projectId === activeProjectId)
        .map((reference) => reference.id);
      if (cleared.length) void deleteReferences(cleared);
      return current.filter(
        (reference) => reference.projectId !== activeProjectId,
      );
    });
  }, [activeProjectId]);
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
      removedCardIds.forEach((cardId) => stopStream(cardId));
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
      // 在事务内按 projectId 重新查库定位从属行，不依赖任何内存基线——另一个
      // 标签页刚建在这个项目下的卡片也会被正确删除。返回值是「删除前库里真正
      // 有什么」，撤销据此精确还原，比还原本标签页记得的内容更完整。
      // 必须在级联之前：sync_state 的 card_id 挂了 ON DELETE CASCADE，
      // 级联跑完之后就查不到这些卡片写过哪些文件了。
      forgetInVault([...removedCardIds]);
      const removed: { current: RemovedProject | null } = { current: null };
      void deleteProjectCascade(id).then((rows) => {
        removed.current = rows;
        // 库里已经删干净，两条基线必须跟上，否则撤销时 diff 会认为这些行
        // 「没变」而不重写。
        persistedRef.current = withoutProject(persistedRef.current, id, rows);
        persistedAttentionRef.current = withoutAttentionProject(
          persistedAttentionRef.current,
          id,
        );
      });
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
          // 把级联删掉的行按 id 原样写回。用库返回的快照而不是 attentionSnapshot，
          // 因为后者只包含本标签页记得的内容。
          const rows = removed.current;
          if (rows) {
            void applyChanges(rows.workspace);
            void applyAttentionChanges(rows.attention);
          } else {
            void applyAttentionChanges(attentionAsUpsert(attentionSnapshot));
          }
          persistedAttentionRef.current = attentionSnapshot;
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
      stopStream,
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
  /**
   * 整库备份：一个 JSON 覆盖全部 12 张表。从**库**里读而不是从内存读——交接要交的
   * 是已经落盘的内容。IndexedDB → SQLite 无法自动迁移，这个文件是唯一的通路。
   */
  const exportLibraryBackup = useCallback(async () => {
    const [workspace, attention, noteCorpus] = await Promise.all([
      loadWorkspace(),
      loadAttentionState(),
      exportNoteCorpusForBackup(),
    ]);
    if (!workspace) throw new Error("本机还没有可备份的数据。");
    const backup = buildLibraryBackup({
      workspace,
      attention,
      noteCorpus,
      exportedAt: Date.now(),
    });
    const counts = backupCounts(backup);
    downloadArtifact({
      filename: `papertable-library-${new Date().toISOString().slice(0, 10)}.json`,
      blob: new Blob([JSON.stringify(backup)], { type: "application/json" }),
    });
    showToast({
      text: `已导出整库备份：${counts.projects} 个项目 · ${counts.cards} 张卡片 · ${counts.turns} 条轮次${counts.noteLibraries ? ` · ${counts.noteLibraries} 个只读资料库` : ""}。请自己收好，迁移到桌面版时需要它。`,
    });
  }, [showToast]);

  /**
   * 导入整库备份，然后**立刻重新读出来逐表比对**，把结果交给调用方显示在 UI 上。
   *
   * 源（web 端的 IndexedDB / 那个备份文件）全程不被修改，所以这一步失败是可回滚的。
   * 在未经校验的数据上跑桌面版，而浏览器里还留着真本，等于同时存在两份互相分叉的
   * 库——那比只有一份坏掉的严格更糟。
   */
  const importLibraryBackup = useCallback(
    async (text: string) => {
      const backup = parseLibraryBackup(text);
      await importLibrary({
        workspace: backup.workspace,
        attention: backup.attention,
      });
      await importNoteCorpusFromBackup(backup.noteCorpus);
      const [workspace, attention] = await Promise.all([
        loadWorkspace(),
        loadAttentionState(),
      ]);
      if (!workspace) throw new Error("导入之后读不回任何内容，请勿继续使用。");
      const check = diffBackupCounts(
        backup,
        buildLibraryBackup({
          workspace,
          attention,
          noteCorpus: await exportNoteCorpusForBackup(),
          exportedAt: Date.now(),
        }),
      );
      showToast({
        text: check.equal
          ? "导入已校验：每张表的行数都与备份一致。刷新后生效。"
          : `导入后校验不一致：${check.mismatches.join("；")}。请勿在此数据上继续使用。`,
      });
      await refreshNoteLibraries();
      return check;
    },
    [refreshNoteLibraries, showToast],
  );

  // -------------------------------------------------------------------------
  // vault 同步（仅桌面版）
  // -------------------------------------------------------------------------

  /**
   * 触发时机：卡片完成之后防抖 2 秒，**绝不跟随 500 ms 的流式自动保存**——按那个
   * 节奏写盘会把 vault 打烂，并让 Obsidian 的索引器永不停歇。
   *
   * 依赖里只放“是否仍有生成任务”和已完成卡片的指纹，所以打字、滚动、折叠这些
   * 纯视图变化不会触发同步。
   */
  const syncFingerprint =
    vault.available && settings.vaultPath
      ? (settings.vaultSyncedProjects ?? [])
          .flatMap((projectId) =>
            syncableCards(cards, projectId).map(
              (card) => `${card.id}:${card.title}:${card.turns.length}`,
            ),
          )
          .join("|")
      : "";

  useEffect(() => {
    if (!hydrated || !vault.available || !settings.vaultPath) return;
    if (hasActiveGenerations) return; // 任一后台任务生成中都不写：等它落定
    if (!syncFingerprint) return;
    if (vaultTimer.current) window.clearTimeout(vaultTimer.current);
    vaultTimer.current = window.setTimeout(() => {
      vaultTimer.current = null;
      void (async () => {
        const vaultPath = settings.vaultPath;
        if (!vaultPath) return;
        const now = Date.now();
        for (const projectId of settings.vaultSyncedProjects ?? []) {
          const project = latestRef.current.projects.find(
            (item) => item.id === projectId,
          );
          if (!project) continue;
          const subtree =
            latestRef.current.settings.vaultSubtree ?? DEFAULT_VAULT_SUBTREE;
          const notes = planProjectSync({
            project,
            cards: latestRef.current.cards,
            edges: latestRef.current.edges,
            syncedAt: now,
            subtree,
          });
          if (!notes.length) continue;
          // 顺手清掉已经进回收站、但笔记还留在知识库里的卡片。
          // 点删除时会调用一次 forgetInVault，但卡片也可能通过导入、撤销或直接改
          // 数据变成 trashed——只依赖那一次调用，笔记会永远留在那里。
          // Rust 侧对没有同步记录的 id 直接跳过，所以这是幂等的。
          forgetInVault(
            latestRef.current.cards
              .filter((card) => card.projectId === projectId && card.trashed)
              .map((card) => card.id),
          );
          try {
            await vault.sync({ vault: vaultPath, subtree, notes, now });
          } catch (cause) {
            // 同步失败绝不能影响本地数据；只提示，不回滚任何东西。
            showToast({
              text:
                cause instanceof Error
                  ? `同步到知识库失败：${cause.message}`
                  : "同步到知识库失败。",
            });
            return;
          }
        }
        await refreshVaultConflicts();
      })();
    }, 2000);
    return () => {
      if (vaultTimer.current) window.clearTimeout(vaultTimer.current);
      vaultTimer.current = null;
    };
    // 依赖刻意只有这四项：syncFingerprint 已经概括了「哪些已完成卡片会被写出去」，
    // 而 showToast / refreshVaultConflicts 的身份变化不该重启防抖。
  }, [hasActiveGenerations, hydrated, syncFingerprint, settings.vaultPath]);

  useEffect(() => {
    if (!hydrated) return;
    void refreshVaultConflicts();
    // 启动时重建索引并接上监听。选目录时会做一次，但重启之后没人做——
    // 不在这里做，重启后监听器就是死的，而界面上看不出任何异常。
    const vaultPath = settings.vaultPath;
    if (vault.available && vaultPath)
      void vault
        .watch(vaultPath)
        .then(setVaultIndexed)
        .catch(() => undefined);
    // 只在水合完成时跑一次；此后由每次同步结束后主动刷新挂起列表。
  }, [hydrated]);

  const refreshVaultConflicts = useCallback(async () => {
    if (!vault.available) return;
    const rows = await vault.conflicts();
    setVaultConflicts(rows.map(([cardId, path]) => ({ cardId, path })));
  }, []);

  const chooseVaultPath = useCallback(async () => {
    const picked = await vault.chooseVault();
    if (!picked) return;
    setSettings((current) => ({ ...current, vaultPath: picked }));
    const indexed = await vault.watch(picked);
    setVaultIndexed(indexed);
    // Desktop-only: connection creates/updates a read-only library separate
    // from the existing optional Papertable→Vault export sync.
    try {
      const library = await connectDesktopVault(picked);
      const bound = await noteLibraries.projectLibraryIds(activeProjectId);
      await noteLibraries.setProjectLibraries(activeProjectId, [
        ...bound,
        library.id,
      ]);
      await refreshNoteLibraries();
    } catch {
      // The vault watcher remains useful for ordinary wikilinks even if the
      // Harness corpus cannot be built (for example a transient DB lock).
    }
    showToast({
      text: `已选择知识库：${picked}，索引到 ${indexed} 篇笔记；当前项目已尝试绑定为只读资料库。Papertable 只会写入其中的 ${settings.vaultSubtree ?? DEFAULT_VAULT_SUBTREE}/。`,
    });
  }, [activeProjectId, refreshNoteLibraries, settings.vaultSubtree, showToast]);

  /** 监听器出问题时的手动兜底。 */
  const rescanVault = useCallback(async () => {
    if (!settings.vaultPath) return;
    const indexed = await vault.watch(settings.vaultPath);
    setVaultIndexed(indexed);
    showToast({ text: `已重新扫描知识库，共 ${indexed} 篇笔记。` });
  }, [settings.vaultPath, showToast]);

  /**
   * 把提问里的 `[[双链]]` 解析成引用。**只生成 ReferenceChip，绝不推断 CardEdge**
   * ——边携带冻结的 ContextSnapshot，而一条链接没有快照。
   */
  const resolveWikilinks = useCallback(
    async (text: string, projectId: string): Promise<ReferenceChip[]> => {
      if (!vault.available) return [];
      const links = parseWikilinks(text);
      if (!links.length) return [];
      const chips: ReferenceChip[] = [];
      for (const link of links) {
        const hits = await vault.resolveLink(link.name);
        if (!hits.length) continue; // 指不到真实笔记就不造引用
        chips.push({
          id: uid("ref"),
          projectId,
          sourceTitle: link.name,
          excerpt: stripWikilinks(link.label).slice(0, 180),
          anchor: { cardId: currentCardId, text: link.label },
        });
      }
      return chips;
    },
    [currentCardId],
  );

  /**
   * 按项目开关同步。开启时立刻整项目写一次，这样用户马上能在 Obsidian 里看到
   * 结果，而不是要等下一次问答完成才知道有没有生效。
   */
  const toggleProjectVaultSync = useCallback(
    async (projectId: string) => {
      const enabled = settings.vaultSyncedProjects ?? [];
      const on = enabled.includes(projectId);
      const next = on
        ? enabled.filter((id) => id !== projectId)
        : [...enabled, projectId];
      setSettings((current) => ({ ...current, vaultSyncedProjects: next }));
      if (on || !settings.vaultPath) return;

      const project = projects.find((item) => item.id === projectId);
      if (!project) return;
      const subtree = settings.vaultSubtree ?? DEFAULT_VAULT_SUBTREE;
      const notes = planProjectSync({
        project,
        cards: latestRef.current.cards,
        edges: latestRef.current.edges,
        syncedAt: Date.now(),
        subtree,
      });
      if (!notes.length) {
        showToast({ text: "这个项目还没有已完成的卡片，暂时没有内容可同步。" });
        return;
      }
      const reports = await vault.sync({
        vault: settings.vaultPath,
        subtree,
        notes,
        now: Date.now(),
      });
      await refreshVaultConflicts();
      const conflicts = reports.filter((r) => r.outcome === "conflict").length;
      showToast({
        text: conflicts
          ? `已同步 ${reports.length - conflicts} 篇；${conflicts} 篇因为你在 Obsidian 里改过而挂起。`
          : `已同步 ${reports.length} 个文件到知识库。`,
      });
    },
    [projects, refreshVaultConflicts, settings, showToast],
  );

  const resolveVaultConflict = useCallback(
    async (cardId: string, keep: "papertable" | "note") => {
      const vaultPath = latestRef.current.settings.vaultPath;
      if (!vaultPath) return;
      // 意图字符串原样透传，这里不做任何分支映射——映射只存在 Rust 侧一处。
      const status = await vault.resolveConflict({
        vault: vaultPath,
        subtree:
          latestRef.current.settings.vaultSubtree ?? DEFAULT_VAULT_SUBTREE,
        cardId,
        keep,
      });
      await refreshVaultConflicts();
      // 提示基于**落库后的真实状态**，不是点击意图。接线若在任何一层出错，
      // 这行字会当场把它暴露出来，而不是用一句确认话术盖过去。
      showToast({
        text:
          status === "force"
            ? "已标记：下次同步会用 Papertable 的内容覆盖那篇笔记。"
            : status === "detached"
              ? "已保留你的笔记，这张卡片不再同步。"
              : `冲突处理返回了未知状态：${status}`,
      });
    },
    [refreshVaultConflicts, showToast],
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
    generationTasksRef.current.forEach((task) => task.controller.abort());
    generationTasksRef.current.clear();
    streamingTurnsRef.current = {};
    setStreamingTurnsByCard({});
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
    setNoteLibraryList([]);
    setBoundNoteLibraryIds([]);
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
      streamingCardIds,
      backgroundGenerationCount,
      streamingTurnId,
      lastCreated,
      hydrated,
      provider,
      agentMode,
      noteLibraries: noteLibraryList,
      boundNoteLibraryIds,
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
      refreshNoteLibraries,
      importNoteLibrary,
      setProjectNoteLibraries,
      removeNoteLibrary,
      importFiles,
      exportProject,
      exportAllBackup,
      exportLibraryBackup,
      importLibraryBackup,
      vaultAvailable: vault.available,
      vaultConflicts,
      vaultPath: settings.vaultPath,
      vaultSyncedProjects: settings.vaultSyncedProjects ?? [],
      chooseVaultPath,
      rescanVault,
      vaultIndexed,
      toggleProjectVaultSync,
      resolveVaultConflict,
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
      streamingCardIds,
      backgroundGenerationCount,
      streamingTurnId,
      lastCreated,
      hydrated,
      provider,
      agentMode,
      noteLibraryList,
      boundNoteLibraryIds,
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
      refreshNoteLibraries,
      importNoteLibrary,
      setProjectNoteLibraries,
      removeNoteLibrary,
      importFiles,
      exportProject,
      exportAllBackup,
      exportLibraryBackup,
      importLibraryBackup,
      // vault.available 是编译期常量，不需要进依赖数组。
      vaultConflicts,
      chooseVaultPath,
      toggleProjectVaultSync,
      resolveVaultConflict,
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
