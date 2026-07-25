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
import { downloadArtifact, formatAdapters } from "./lib/formats";
import { incomingEdge, subtreeIds } from "./lib/graph";
import {
  generateModel,
  getProviderHealth,
  streamModel,
  type ProviderHealth,
} from "./lib/provider";
import { preferredProjectCard } from "./lib/projectScope";
import {
  clearWorkspace,
  loadWorkspace,
  saveWorkspace,
  type WorkspaceSnapshot,
} from "./lib/storage";
import { EDGE_META } from "./types";
import type {
  AppSettings,
  BuiltContext,
  Card,
  CardEdge,
  ConceptPreviewCacheEntry,
  ContextSnapshot,
  EdgeType,
  ImportInput,
  Project,
  ReferenceChip,
  SourceAnchor,
  Turn,
  ViewState,
} from "./types";

const uid = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;
const defaultSettings: AppSettings = {
  id: "app",
  model: "claude-opus-5",
  providerBaseUrl: "https://cozai.net/v1",
  providerStatus: "unknown",
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

export interface CreateCardInput {
  type: EdgeType;
  sourceCardId: string;
  sourceTurnId?: string;
  sourceText?: string;
  sourceBlockText?: string;
  title: string;
  seedTurns?: Turn[];
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
  deleteCard: (id: string) => void;
  toggleFavoriteCard: (id: string) => void;
  toggleCollapse: (id: string) => void;
  markRead: (id: string) => void;
  cacheConceptPreview: (
    cardId: string,
    cacheKey: string,
    entry: ConceptPreviewCacheEntry,
  ) => void;
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
  return {
    projects: DEMO_PROJECTS,
    cards: DEMO_CARDS,
    edges: DEMO_EDGES,
    anchors: [],
    snapshots: [],
    references: DEMO_REFERENCES,
    view: defaultView(),
    settings: { ...defaultSettings, seededAt: Date.now() },
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
  const lastPersistedAt = useRef(0);
  const latestRef = useRef<WorkspaceSnapshot>(seed);

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

  useEffect(() => {
    let active = true;
    void (async () => {
      const saved = await loadWorkspace();
      if (!active) return;
      const next = saved ?? seed;
      if (!saved) await saveWorkspace(seed);
      setProjects(next.projects);
      setCards(next.cards);
      setEdges(next.edges);
      setAnchors(next.anchors);
      setSnapshots(next.snapshots);
      setReferenceStore(next.references);
      setView(next.view);
      setSettings(next.settings);
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
      void saveWorkspace(latestRef.current);
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
          answer += event.text;
          updateCard(input.cardId, (card) => ({
            ...card,
            turns: card.turns.map((turn) =>
              turn.id === aiId ? { ...turn, content: answer } : turn,
            ),
          }));
        }
        if (!controller.signal.aborted) {
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
      setView((current) => ({
        ...current,
        currentCardId: id,
        lastCardByProject: {
          ...current.lastCardByProject,
          [activeProjectId]: id,
        },
      }));
      updateCard(id, (current) => ({ ...current, unread: false }));
    },
    [activeProjectId, cards, updateCard],
  );

  const createCard = useCallback(
    (input: CreateCardInput) => {
      const source = cards.find((card) => card.id === input.sourceCardId);
      if (!source || source.projectId !== activeProjectId)
        throw new Error("不能从其他项目创建卡片。");
      const cardId = uid("card");
      const edgeId = uid("edge");
      const anchorId = input.sourceText ? uid("anchor") : undefined;
      const sourceTurns =
        input.type === "branch" && input.sourceTurnId
          ? source.turns.slice(
              0,
              source.turns.findIndex((turn) => turn.id === input.sourceTurnId) +
                1,
            )
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
        turns: input.seedTurns ?? [],
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
    [activeProjectId, cards, edges, snapshots, streamAnswer],
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
    },
    [activeProjectId, cards, projects, stopStream, view.lastCardByProject],
  );

  const contextForCurrent = useCallback(
    () => buildContext({ cards, edges, snapshots, references, currentCardId }),
    [cards, currentCardId, edges, references, snapshots],
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
    (id: string) =>
      updateCard(id, (card) => ({ ...card, favorite: !card.favorite })),
    [updateCard],
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
      if (activeProjectId === id && next) {
        const nextCard = preferredProjectCard(cards, next.id);
        if (nextCard)
          setView((current) => ({
            ...current,
            activeProjectId: next.id,
            currentCardId: nextCard.id,
          }));
      }
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
          dismissToast();
        },
      });
    },
    [activeProjectId, cards, dismissToast, edges, projects, showToast],
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
    setProjects(next.projects);
    setCards(next.cards);
    setEdges(next.edges);
    setAnchors(next.anchors);
    setSnapshots(next.snapshots);
    setReferenceStore(next.references);
    setView(next.view);
    setSettings(next.settings);
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
      deleteCard,
      toggleFavoriteCard,
      toggleCollapse,
      markRead,
      cacheConceptPreview,
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
      deleteCard,
      toggleFavoriteCard,
      toggleCollapse,
      markRead,
      cacheConceptPreview,
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
      showToast,
      dismissToast,
    ],
  );
  return <StoreCtx.Provider value={value}>{children}</StoreCtx.Provider>;
}
