import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowDownRight,
  ArrowUpLeft,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  CornerDownRight,
  Edit3,
  GitBranch,
  MoreHorizontal,
  Quote,
  Split,
  Star,
  Trash2,
  X,
} from "lucide-react";
import { useStore } from "../store";
import { EDGE_META } from "../types";
import { incomingEdge, pathToRoot } from "../lib/graph";
import { Markdown } from "../lib/markdown";
import type { Card, NoteCitation, Turn } from "../types";
import type { TempCard } from "./ConceptPreview";
import { TempCardLayer } from "./TempCardLayer";
import { NoteSourcePreview } from "./NoteSourcePreview";
import { AgentTimeline } from "./AgentTimeline";
import type {
  AgentTimelineNode,
  TrajectoryPromotionDraft,
} from "../lib/agentTimeline";
import { desktopTurnsForDisplay } from "../lib/desktopUi";
import { cutoffBeforeRerouteRound, isGoldEligible } from "../lib/verdicts";
import { GoldAdoptionDialog } from "./GoldAdoptionDialog";

const spring = {
  type: "spring" as const,
  stiffness: 260,
  damping: 30,
  mass: 0.9,
};

const TURN_PREVIEW_LIMIT = 6_000;
const TURN_PAGE_LIMIT = 4_000;
const CARD_TITLE_LIMIT = 80;
const IS_DESKTOP_BUILD = __PAPERTABLE_TARGET__ === "desktop";

/** `Array.from` avoids slicing a surrogate pair in the middle. */
function unicodeLength(value: string) {
  return Array.from(value).length;
}

function unicodeSlice(value: string, end: number) {
  return Array.from(value).slice(0, end).join("");
}

function splitLongTurn(content: string, pageSize = TURN_PAGE_LIMIT) {
  const characters = Array.from(content);
  const pages: string[] = [];
  let start = 0;
  while (start < characters.length) {
    let end = Math.min(characters.length, start + pageSize);
    // Preserve readable Markdown boundaries when there is one in the latter
    // half of a page. The maximum remains exactly pageSize Unicode characters.
    if (end < characters.length) {
      const page = characters.slice(start, end).join("");
      const breakAt = Math.max(
        page.lastIndexOf("\n\n"),
        page.lastIndexOf("\n"),
      );
      if (breakAt >= Math.floor(page.length * 0.55)) {
        end = start + Array.from(page.slice(0, breakAt + 1)).length;
      }
    }
    pages.push(characters.slice(start, end).join(""));
    start = end;
  }
  return pages.length ? pages : [""];
}

interface SelState {
  scope: "selection" | "turn";
  x: number;
  y: number;
  text: string;
  blockText: string;
  turnId: string;
}

interface SelectionSnapshot {
  text: string;
  blockText: string;
  turnId: string;
  rects: Array<Pick<DOMRect, "bottom" | "left" | "right" | "top">>;
}

function selectionHost(node: Node | null) {
  return (
    node instanceof Element ? node : node?.parentElement
  )?.closest<HTMLElement>("[data-turn-ai]");
}

function rangeContainsPoint(range: Range, x: number, y: number) {
  return rectsContainPoint(Array.from(range.getClientRects()), x, y);
}

function rectsContainPoint(
  rects: Array<Pick<DOMRect, "bottom" | "left" | "right" | "top">>,
  x: number,
  y: number,
) {
  return rects.some(
    (rect) =>
      x >= rect.left - 2 &&
      x <= rect.right + 2 &&
      y >= rect.top - 2 &&
      y <= rect.bottom + 2,
  );
}

function desktopMenuPosition(x: number, y: number, scope: SelState["scope"]) {
  const gap = 8;
  const estimatedWidth = 210;
  const estimatedHeight = scope === "selection" ? 122 : 86;
  return {
    x: Math.max(
      gap,
      Math.min(x + gap, window.innerWidth - estimatedWidth - gap),
    ),
    y: Math.max(
      gap,
      Math.min(y + gap, window.innerHeight - estimatedHeight - gap),
    ),
  };
}

function sourceRevision(turn: Turn) {
  let hash = 2166136261;
  for (let index = 0; index < turn.content.length; index += 1) {
    hash = Math.imul(hash ^ turn.content.charCodeAt(index), 16777619);
  }
  return `${turn.id}:${turn.createdAt}:${hash >>> 0}`;
}

export function CardStage() {
  const {
    activeProjectId,
    cards,
    edges,
    currentCardId,
    hasCurrentCard,
    setCurrentCard,
    createRootCard,
    createCard,
    renameCard,
    rerouteEditedQuestion,
    pendingRerouteVerdict,
    confirmRerouteVerdict,
    retryRerouteVerdictDraft,
    skipRerouteVerdict,
    deleteCard,
    toggleFavoriteCard,
    addReference,
    recordConceptPreviewOpened,
    recordCardDwell,
    rememberCardScroll,
    cardScroll,
    retryLast,
    continueAgentRun,
    lastCreated,
    streamingTurnId,
    showToast,
  } = useStore();

  const card = hasCurrentCard
    ? cards.find(
        (candidate) => candidate.id === currentCardId && !candidate.trashed,
      )
    : undefined;
  const path = useMemo(
    () => pathToRoot(edges, currentCardId),
    [edges, currentCardId],
  );
  const ancestors = path.slice(0, -1).slice(-3).reverse();

  const bodyRef = useRef<HTMLDivElement>(null);
  const selectionMenuRef = useRef<HTMLDivElement>(null);
  const desktopSelectionRef = useRef<SelectionSnapshot | null>(null);
  const followStreamingTail = useRef(true);
  const previousStreamingTurn = useRef<string | null>(null);
  const [sel, setSel] = useState<SelState | null>(null);
  const [tempCards, setTempCards] = useState<TempCard[]>([]);
  const tempCardsRef = useRef<TempCard[]>([]);
  const tempProjectRef = useRef(activeProjectId);
  const zCounter = useRef(80);
  const [tempFlashId, setTempFlashId] = useState<string | null>(null);
  const [tempShakeId, setTempShakeId] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [spawn, setSpawn] = useState<
    null | { kind: "divergent" } | { kind: "branch" }
  >(null);
  const [spawnText, setSpawnText] = useState("");
  const [flashTurn, setFlashTurn] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const [noteSource, setNoteSource] = useState<NoteCitation | null>(null);
  const [titleDraft, setTitleDraft] = useState("");
  const [longTurnId, setLongTurnId] = useState<string | null>(null);
  const [goldTurnId, setGoldTurnId] = useState<string | null>(null);
  const [verdictDraft, setVerdictDraft] = useState("");
  const prevCard = useRef(currentCardId);
  const dwellRecordRef = useRef(recordCardDwell);

  useEffect(() => {
    setVerdictDraft(pendingRerouteVerdict?.draft ?? "");
  }, [pendingRerouteVerdict?.cardId, pendingRerouteVerdict?.draft]);

  useEffect(() => {
    if (!pendingRerouteVerdict) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      skipRerouteVerdict();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [pendingRerouteVerdict, skipRerouteVerdict]);

  const updateTempCards = useCallback((next: TempCard[]) => {
    tempCardsRef.current = next;
    setTempCards(next);
  }, []);

  const focusTempCard = useCallback(
    (id: string) => {
      const z = ++zCounter.current;
      updateTempCards(
        tempCardsRef.current.map((tempCard) =>
          tempCard.id === id ? { ...tempCard, z, minimized: false } : tempCard,
        ),
      );
    },
    [updateTempCards],
  );

  const moveTempCard = useCallback(
    (id: string, pos: TempCard["pos"]) => {
      updateTempCards(
        tempCardsRef.current.map((tempCard) =>
          tempCard.id === id ? { ...tempCard, pos } : tempCard,
        ),
      );
    },
    [updateTempCards],
  );

  const minimizeTempCard = useCallback(
    (id: string) => {
      updateTempCards(
        tempCardsRef.current.map((tempCard) =>
          tempCard.id === id ? { ...tempCard, minimized: true } : tempCard,
        ),
      );
    },
    [updateTempCards],
  );

  const closeTempCard = useCallback(
    (id: string) => {
      updateTempCards(
        tempCardsRef.current.filter((tempCard) => tempCard.id !== id),
      );
    },
    [updateTempCards],
  );

  useEffect(() => {
    if (tempProjectRef.current === activeProjectId) return;
    tempProjectRef.current = activeProjectId;
    updateTempCards([]);
    setSel(null);
    desktopSelectionRef.current = null;
    setTempFlashId(null);
    setTempShakeId(null);
    setNoteSource(null);
    setLongTurnId(null);
  }, [activeProjectId, updateTempCards]);

  useEffect(() => {
    setLongTurnId(null);
    setSel(null);
    desktopSelectionRef.current = null;
  }, [currentCardId]);

  useEffect(() => {
    dwellRecordRef.current = recordCardDwell;
  }, [recordCardDwell]);

  /* 只统计页面前台状态下的连续有效阅读，后台挂起不算。 */
  useEffect(() => {
    if (!hasCurrentCard) return;
    let elapsed = 0;
    let startedAt: number | null = null;
    let timer: number | null = null;
    let recorded = false;
    const clearTimer = () => {
      if (timer) window.clearTimeout(timer);
      timer = null;
    };
    const start = () => {
      if (recorded || document.visibilityState !== "visible") return;
      startedAt = Date.now();
      timer = window.setTimeout(
        () => {
          recorded = true;
          dwellRecordRef.current(currentCardId);
        },
        Math.max(0, 120_000 - elapsed),
      );
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        if (startedAt) elapsed += Date.now() - startedAt;
        startedAt = null;
        clearTimer();
      } else {
        start();
      }
    };
    start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearTimer();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [currentCardId, hasCurrentCard]);

  /* ---------- 每张卡片独立滚动位置 ---------- */
  useLayoutEffect(() => {
    if (!hasCurrentCard) return;
    const el = bodyRef.current;
    if (!el) return;
    if (prevCard.current !== currentCardId) prevCard.current = currentCardId;
    el.scrollTop = cardScroll(currentCardId);
    followStreamingTail.current =
      el.scrollHeight - el.clientHeight - el.scrollTop < 96;
  }, [cardScroll, currentCardId, hasCurrentCard]);

  const rememberScroll = () => {
    if (!bodyRef.current) return;
    const el = bodyRef.current;
    followStreamingTail.current =
      el.scrollHeight - el.clientHeight - el.scrollTop < 96;
    rememberCardScroll(currentCardId, el.scrollTop);
  };

  const goCard = useCallback(
    (id: string) => {
      rememberScroll();
      setSel(null);
      desktopSelectionRef.current = null;
      setCurrentCard(id);
    },
    [currentCardId, setCurrentCard],
  );

  const streamingContentLength =
    card?.turns.find((turn) => turn.id === streamingTurnId)?.content.length ??
    0;

  /* ---------- 流式时只在用户仍跟随末尾时自动滚动 ---------- */
  useEffect(() => {
    if (!streamingTurnId || !bodyRef.current) return;
    if (previousStreamingTurn.current !== streamingTurnId) {
      previousStreamingTurn.current = streamingTurnId;
      followStreamingTail.current = true;
    }
    if (!followStreamingTail.current) return;
    const frame = window.requestAnimationFrame(() => {
      const el = bodyRef.current;
      if (el && followStreamingTail.current) el.scrollTop = el.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [streamingContentLength, streamingTurnId]);

  useEffect(() => {
    if (!streamingTurnId) previousStreamingTurn.current = null;
  }, [streamingTurnId]);

  /* ---------- 真实浏览器文本选择 ---------- */
  useEffect(() => {
    if (IS_DESKTOP_BUILD) return;
    const handler = () => {
      const s = window.getSelection();
      if (!s || s.isCollapsed) {
        setSel(null);
        return;
      }
      const text = s.toString().trim();
      if (text.length < 2) {
        setSel(null);
        return;
      }
      const anchorNode = s.anchorNode;
      const host = (
        anchorNode instanceof Element ? anchorNode : anchorNode?.parentElement
      )?.closest("[data-turn-ai]") as HTMLElement | null;
      if (!host) {
        setSel(null);
        return;
      }
      const rect = s.getRangeAt(0).getBoundingClientRect();
      setSel({
        scope: "selection",
        x: Math.max(
          10,
          Math.min(rect.left + rect.width / 2 - 96, window.innerWidth - 210),
        ),
        y: Math.max(56, rect.top - 46),
        text,
        blockText: host.innerText.slice(0, 260),
        turnId: host.dataset.turnAi!,
      });
    };
    const clearWhenCollapsed = () => {
      const s = window.getSelection();
      if (!s || s.isCollapsed) setSel(null);
    };
    document.addEventListener("mouseup", handler);
    document.addEventListener("selectionchange", clearWhenCollapsed);
    return () => {
      document.removeEventListener("mouseup", handler);
      document.removeEventListener("selectionchange", clearWhenCollapsed);
    };
  }, []);

  /* 桌面右键可能先让系统选区失焦，因此静默保存最近一次真实选区。 */
  useEffect(() => {
    if (!IS_DESKTOP_BUILD) return;
    const clearBeforeNewSelection = (event: PointerEvent) => {
      if (event.button === 0) desktopSelectionRef.current = null;
    };
    const captureSelection = (event: MouseEvent) => {
      if (event.button !== 0) return;
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
        desktopSelectionRef.current = null;
        return;
      }
      const text = selection.toString().trim();
      const anchorHost = selectionHost(selection.anchorNode);
      const focusHost = selectionHost(selection.focusNode);
      if (!text || !anchorHost || anchorHost !== focusHost) {
        desktopSelectionRef.current = null;
        return;
      }
      const range = selection.getRangeAt(0);
      const target = event.target instanceof Element ? event.target : null;
      const block = target?.closest<HTMLElement>(
        "p, li, blockquote, pre, h1, h2, h3, h4, h5, h6",
      );
      desktopSelectionRef.current = {
        text,
        blockText: (block?.innerText ?? anchorHost.innerText).slice(0, 260),
        turnId: anchorHost.dataset.turnAi ?? "",
        rects: Array.from(range.getClientRects(), (rect) => ({
          bottom: rect.bottom,
          left: rect.left,
          right: rect.right,
          top: rect.top,
        })),
      };
    };
    document.addEventListener("pointerdown", clearBeforeNewSelection, true);
    document.addEventListener("mouseup", captureSelection);
    return () => {
      document.removeEventListener(
        "pointerdown",
        clearBeforeNewSelection,
        true,
      );
      document.removeEventListener("mouseup", captureSelection);
    };
  }, []);

  const openDesktopTurnMenu = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (!IS_DESKTOP_BUILD || !card) return;
      const target = event.target instanceof Element ? event.target : null;
      const host = target?.closest<HTMLElement>("[data-turn-ai]");
      if (!host) return;
      const turnId = host.dataset.turnAi;
      const turn = card.turns.find(
        (candidate) => candidate.id === turnId && candidate.role === "ai",
      );
      if (!turn) return;

      event.preventDefault();
      const selection = window.getSelection();
      const range =
        selection && !selection.isCollapsed && selection.rangeCount > 0
          ? selection.getRangeAt(0)
          : null;
      const currentSelectedText = selection?.toString().trim() ?? "";
      const currentSelectionIsHere =
        Boolean(range && currentSelectedText) &&
        selectionHost(selection?.anchorNode ?? null) === host &&
        selectionHost(selection?.focusNode ?? null) === host &&
        range !== null &&
        rangeContainsPoint(range, event.clientX, event.clientY);
      const savedSelection = desktopSelectionRef.current;
      const savedSelectionIsHere =
        savedSelection?.turnId === turn.id &&
        rectsContainPoint(savedSelection.rects, event.clientX, event.clientY);
      const selectionIsHere =
        currentSelectionIsHere || Boolean(savedSelectionIsHere);
      if (!selectionIsHere) desktopSelectionRef.current = null;
      const selectedText = currentSelectionIsHere
        ? currentSelectedText
        : (savedSelection?.text ?? "");
      const scope: SelState["scope"] = selectionIsHere ? "selection" : "turn";
      const block = target?.closest<HTMLElement>(
        "p, li, blockquote, pre, h1, h2, h3, h4, h5, h6",
      );
      const position = desktopMenuPosition(event.clientX, event.clientY, scope);

      setMenuOpen(false);
      setSpawn(null);
      setSel({
        scope,
        ...position,
        text: selectionIsHere ? selectedText : turn.content,
        blockText:
          (selectionIsHere
            ? currentSelectionIsHere
              ? block?.innerText
              : savedSelection?.blockText
            : turn.content
          )?.slice(0, 260) ?? "",
        turnId: turn.id,
      });
    },
    [card],
  );

  useEffect(() => {
    if (!IS_DESKTOP_BUILD || !sel) return;
    const close = () => {
      setSel(null);
      desktopSelectionRef.current = null;
    };
    const closeFromOutside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        selectionMenuRef.current?.contains(event.target)
      ) {
        return;
      }
      close();
    };
    document.addEventListener("pointerdown", closeFromOutside, true);
    document.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", closeFromOutside, true);
      document.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [sel]);

  useLayoutEffect(() => {
    if (!IS_DESKTOP_BUILD || !sel || !selectionMenuRef.current) return;
    const rect = selectionMenuRef.current.getBoundingClientRect();
    const gap = 8;
    const x = Math.max(
      gap,
      Math.min(sel.x, window.innerWidth - rect.width - gap),
    );
    const y = Math.max(
      gap,
      Math.min(sel.y, window.innerHeight - rect.height - gap),
    );
    if (x === sel.x && y === sel.y) return;
    setSel((current) => (current ? { ...current, x, y } : current));
  }, [sel]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      // Higher foreground layers own Escape. Their handlers restore focus to
      // their own opener; clearing a card selection underneath them would
      // make the key feel like it acted on two different surfaces.
      if (noteSource || longTurnId || tempCards.length) return;
      if (!sel && !spawn && !menuOpen) return;
      event.preventDefault();
      setSel(null);
      setSpawn(null);
      setMenuOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [longTurnId, menuOpen, noteSource, sel, spawn, tempCards.length]);

  if (!card) {
    return (
      <div className="stage stage-empty" aria-live="polite">
        <div className="empty-card-state">
          <span className="empty-card-state-kicker">当前项目</span>
          <h2>项目暂时没有可用卡片</h2>
          <p>
            已删除的卡片仍在回收站。新建一张根卡片后，就可以从一个问题开始新的探索。
          </p>
          <button
            className="btn primary"
            onClick={() => {
              if (!createRootCard()) {
                showToast({ text: "当前项目不可用，暂时无法新建根卡片。" });
              }
            }}
          >
            新建根卡片
          </button>
        </div>
      </div>
    );
  }

  const inEdge = incomingEdge(edges, card.id);
  const sourceCard = inEdge
    ? cards.find((c) => c.id === inEdge.sourceCardId)
    : undefined;
  const meta = inEdge ? EDGE_META[inEdge.type] : null;

  const openTempCard = (
    term: string,
    blockText: string,
    turn: Turn,
    element: HTMLElement,
  ) => {
    const normalized = term.trim().toLocaleLowerCase();
    const existing = tempCardsRef.current.find(
      (tempCard) => tempCard.term.trim().toLocaleLowerCase() === normalized,
    );
    if (existing) {
      focusTempCard(existing.id);
      setTempFlashId(existing.id);
      window.setTimeout(() => setTempFlashId(null), 360);
      return;
    }

    if (tempCardsRef.current.length >= 4) {
      const oldest = [...tempCardsRef.current].sort(
        (a, b) => a.createdAt - b.createdAt,
      )[0];
      if (oldest) {
        setTempShakeId(oldest.id);
        window.setTimeout(() => setTempShakeId(null), 260);
      }
      showToast({
        text: "最多同时打开 4 张临时卡片，先收起或关闭一张",
      });
      return;
    }

    const rect = element.getBoundingClientRect();
    const maxX = Math.max(12, window.innerWidth - 432);
    const maxY = Math.max(56, window.innerHeight - 390);
    const start = {
      x: Math.max(12, Math.min(maxX, rect.left)),
      y: Math.max(56, Math.min(maxY, rect.bottom + 10)),
    };
    const previous = [...tempCardsRef.current].sort(
      (a, b) => b.createdAt - a.createdAt,
    )[0];
    const cascaded = previous
      ? { x: previous.pos.x + 28, y: previous.pos.y + 28 }
      : start;
    const pos = cascaded.x > maxX || cascaded.y > maxY ? start : cascaded;
    const now = Date.now();
    const next: TempCard = {
      id: `temp-${now}-${Math.random().toString(36).slice(2, 8)}`,
      term,
      anchor: {
        cardId: card.id,
        turnId: turn.id,
        text: term,
        exact: term,
        blockText,
        sourceRevision: sourceRevision(turn),
      },
      pos,
      z: ++zCounter.current,
      minimized: false,
      createdAt: now,
    };
    updateTempCards([...tempCardsRef.current, next]);
  };

  const copy = async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* 剪贴板权限失败时不打断阅读流程。 */
    }
    setCopied(key);
    window.setTimeout(() => setCopied(null), 1400);
    showToast({ text: "已复制到剪贴板" });
  };

  /* ---------- 创建关系卡片 ---------- */
  const spawnChild = (opts?: {
    turnId?: string;
    text?: string;
    blockText?: string;
  }) => {
    rememberScroll();
    const title = opts?.text
      ? opts.text.slice(0, 22)
      : `${card.title} · 继续深挖`;
    const id = createCard({
      type: "child",
      sourceCardId: card.id,
      sourceTurnId: opts?.turnId,
      sourceText: opts?.text,
      sourceBlockText: opts?.blockText,
      title,
      origin: opts?.text ? "selection" : "manual",
      seedTurns: [
        {
          id: `t-${Date.now()}`,
          role: "user",
          content: opts?.text
            ? `深挖：${opts.text}`
            : `深挖：请把「${card.title}」再往下讲一层。`,
          createdAt: Date.now(),
        },
      ],
    });
    setSel(null);
    desktopSelectionRef.current = null;
    window.getSelection()?.removeAllRanges();
    return id;
  };

  const spawnDivergent = (topic: string) => {
    rememberScroll();
    createCard({
      type: "divergent",
      sourceCardId: card.id,
      title: topic.slice(0, 26),
      origin: "manual",
      seedTurns: [
        {
          id: `t-${Date.now()}`,
          role: "user",
          content: `发散：${topic}`,
          createdAt: Date.now(),
        },
      ],
    });
  };

  const spawnBranch = (turnId: string, index: number) => {
    const contextThroughTurnId = cutoffBeforeRerouteRound(card.turns, turnId);
    if (contextThroughTurnId === undefined) {
      showToast({ text: "无法定位这轮问题，请刷新后再改道。" });
      return;
    }
    rememberScroll();
    createCard({
      type: "branch",
      sourceCardId: card.id,
      sourceTurnId: turnId,
      contextThroughTurnId,
      title: `${card.title} · 另一条路径`,
      origin: "manual",
      seedTurns: [
        {
          id: `t-${Date.now()}`,
          role: "user",
          content: `从第 ${index} 轮改道：换一个前提重新往下推。`,
          createdAt: Date.now(),
        },
      ],
    });
  };

  const backToSource = () => {
    if (!inEdge || !sourceCard) return;
    goCard(sourceCard.id);
    if (inEdge.sourceTurnId) {
      setFlashTurn(inEdge.sourceTurnId);
      window.setTimeout(() => {
        document
          .getElementById(`turn-${inEdge.sourceTurnId}`)
          ?.scrollIntoView({ block: "center" });
      }, 60);
      window.setTimeout(() => setFlashTurn(null), 2200);
    }
  };

  const enter =
    lastCreated?.cardId === card.id
      ? EDGE_META[lastCreated.type].enterFrom
      : { x: 0, y: 18, rotate: 0 };
  const displayedTurns = IS_DESKTOP_BUILD
    ? desktopTurnsForDisplay(card.turns)
    : card.turns;
  const aiTurns = displayedTurns.filter((t) => t.role === "ai");
  const normalizedTitleDraft = titleDraft
    .normalize("NFC")
    .replace(/\s+/gu, " ")
    .trim();
  const titleCount = unicodeLength(normalizedTitleDraft);
  const titleIssue = !normalizedTitleDraft
    ? "标题不能为空"
    : titleCount > CARD_TITLE_LIMIT
      ? `标题最多 ${CARD_TITLE_LIMIT} 个字符`
      : null;
  const commitTitle = () => {
    if (titleIssue) {
      showToast({ text: titleIssue });
      return;
    }
    renameCard(card.id, normalizedTitleDraft);
    setEditingTitle(false);
  };
  const longTurn = longTurnId
    ? card.turns.find((turn) => turn.id === longTurnId)
    : undefined;
  const goldTurn = goldTurnId
    ? card.turns.find((turn) => turn.id === goldTurnId)
    : undefined;
  const actionTurn = sel
    ? card.turns.find((turn) => turn.id === sel.turnId && turn.role === "ai")
    : undefined;

  return (
    <div
      className={`stage${tempCards.some((tempCard) => tempCard.minimized) ? " has-temp-dock" : ""}`}
    >
      <div className="stack">
        {/* 后方祖先卡片 */}
        {ancestors.map((id, i) => {
          const c = cards.find((x) => x.id === id);
          if (!c) return null;
          const depth = i + 1;
          const e = incomingEdge(edges, c.id);
          return (
            <div
              key={id}
              className="back-card"
              onClick={() => goCard(id)}
              role="button"
              tabIndex={0}
              onKeyDown={(ev) => ev.key === "Enter" && goCard(id)}
              title={`返回「${c.title}」`}
              style={{
                transform: `translateY(calc(var(--peek) * ${-depth})) scaleX(${1 - depth * 0.032}) rotate(${
                  depth % 2 ? -0.4 : 0.45
                }deg)`,
                transformOrigin: "center top",
                zIndex: 10 - depth,
                filter: `brightness(${1 - depth * 0.02})`,
              }}
            >
              <div className="back-card-label">
                <ArrowUpLeft size={12} />
                <span
                  style={{
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    maxWidth: 300,
                  }}
                >
                  {c.title}
                </span>
                <span style={{ color: "var(--ink-3)", fontSize: 11 }}>
                  · {e ? EDGE_META[e.type].label : "根卡片"}
                </span>
              </div>
            </div>
          );
        })}

        {/* 当前卡片 */}
        <AnimatePresence initial={false}>
          <motion.article
            key={card.id}
            className="card"
            style={{ zIndex: 20 }}
            initial={{
              opacity: 0,
              x: enter.x,
              y: enter.y,
              rotate: enter.rotate,
              scale: 0.975,
            }}
            animate={{ opacity: 1, x: 0, y: 0, rotate: 0, scale: 1 }}
            exit={{ opacity: 0, scale: 0.985, transition: { duration: 0.16 } }}
            transition={spring}
          >
            <header className="card-head">
              <div style={{ flex: 1, minWidth: 0 }}>
                {editingTitle ? (
                  <>
                    <input
                      className="card-title-input"
                      value={titleDraft}
                      onChange={(event) => setTitleDraft(event.target.value)}
                      onBlur={commitTitle}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") commitTitle();
                        if (event.key === "Escape") setEditingTitle(false);
                      }}
                      aria-label="编辑卡片标题"
                      aria-describedby="card-title-count"
                      aria-invalid={Boolean(titleIssue)}
                      autoFocus
                    />
                    <div
                      className={`card-title-count${titleIssue ? " invalid" : ""}`}
                      id="card-title-count"
                      role={titleIssue ? "alert" : undefined}
                    >
                      {titleCount} / {CARD_TITLE_LIMIT}
                      {titleIssue ? ` · ${titleIssue}` : ""}
                    </div>
                  </>
                ) : (
                  <h1
                    className="card-title"
                    onDoubleClick={() => {
                      setTitleDraft(card.title);
                      setEditingTitle(true);
                    }}
                    title="双击编辑标题"
                  >
                    {card.title}
                  </h1>
                )}
                <div className="card-meta">
                  <span className={`rel-pill ${inEdge ? inEdge.type : "root"}`}>
                    {inEdge ? (
                      inEdge.type === "child" ? (
                        <ArrowDownRight size={12} />
                      ) : inEdge.type === "divergent" ? (
                        <Split size={12} />
                      ) : (
                        <GitBranch size={12} />
                      )
                    ) : (
                      <CornerDownRight size={12} />
                    )}
                    {meta ? meta.label : "根卡片"}
                  </span>
                  {sourceCard && meta && (
                    <button
                      className="source-pill"
                      onClick={backToSource}
                      title="返回来源卡片并高亮来源位置"
                    >
                      <ArrowUpLeft size={11} />
                      <span>
                        {(() => {
                          if (inEdge?.type !== "branch" || !inEdge.sourceTurnId)
                            return `${meta.verb}：${sourceCard.title}`;
                          const sourceTurn = sourceCard.turns.find(
                            (turn) => turn.id === inEdge.sourceTurnId,
                          );
                          if (sourceTurn?.role === "user") {
                            const questionNumber = sourceCard.turns
                              .slice(
                                0,
                                sourceCard.turns.findIndex(
                                  (turn) => turn.id === sourceTurn.id,
                                ) + 1,
                              )
                              .filter((turn) => turn.role === "user").length;
                            return `从第 ${questionNumber} 个问题改道：${sourceCard.title}`;
                          }
                          const turnNumber = sourceCard.turns
                            .filter((turn) => turn.role === "ai")
                            .findIndex(
                              (turn) => turn.id === inEdge.sourceTurnId,
                            );
                          return `从第 ${turnNumber + 1} 轮改道：${sourceCard.title}`;
                        })()}
                      </span>
                    </button>
                  )}
                  {inEdge?.sourceText && (
                    <span
                      className="rel-pill root"
                      title={inEdge.sourceBlockText}
                    >
                      <Quote size={11} />
                      {inEdge.sourceText.slice(0, 14)}
                    </span>
                  )}
                </div>
              </div>

              <div className="card-head-actions">
                <button
                  className={`icon-btn${card.favorite ? " active" : ""}`}
                  onClick={() => toggleFavoriteCard(card.id)}
                  title={card.favorite ? "取消收藏" : "收藏卡片"}
                >
                  <Star
                    size={15}
                    fill={card.favorite ? "currentColor" : "none"}
                  />
                </button>
                <div style={{ position: "relative" }}>
                  <button
                    className="icon-btn"
                    onClick={() => setMenuOpen((v) => !v)}
                    title="卡片菜单"
                  >
                    <MoreHorizontal size={16} />
                  </button>
                  {menuOpen && (
                    <>
                      <div
                        style={{ position: "fixed", inset: 0, zIndex: 55 }}
                        onClick={() => setMenuOpen(false)}
                      />
                      <div className="menu" style={{ top: 34, right: 0 }}>
                        <button
                          className="menu-item"
                          onClick={() => {
                            setTitleDraft(card.title);
                            setEditingTitle(true);
                            setMenuOpen(false);
                          }}
                        >
                          <Edit3 size={14} />
                          编辑标题
                        </button>
                        <button
                          className="menu-item"
                          onClick={() => {
                            copy(
                              card.turns.map((t) => t.content).join("\n\n"),
                              "card",
                            );
                            setMenuOpen(false);
                          }}
                        >
                          <Copy size={14} />
                          复制整张卡片
                        </button>
                        <button
                          className="menu-item danger"
                          onClick={() => {
                            setMenuOpen(false);
                            deleteCard(card.id);
                          }}
                        >
                          <Trash2 size={14} />
                          删除卡片及下游
                        </button>
                        <div className="menu-note">
                          进入回收站，6 秒内可撤销
                        </div>
                      </div>
                    </>
                  )}
                </div>
                {!IS_DESKTOP_BUILD && (
                  <button
                    className="deep-btn"
                    onClick={() => spawnChild()}
                    title="以当前卡片为来源创建深挖卡片"
                  >
                    <ArrowDownRight size={14} />
                    深挖
                  </button>
                )}
              </div>
            </header>

            <div
              className="card-body scroll-y"
              ref={bodyRef}
              onScroll={rememberScroll}
              onContextMenu={openDesktopTurnMenu}
            >
              <div className="card-body-inner">
                {card.turns.length === 0 && (
                  <div
                    style={{
                      padding: "40px 0",
                      color: "var(--ink-3)",
                      fontSize: 14,
                      lineHeight: 1.9,
                    }}
                  >
                    这是一张空白卡片。
                    <br />
                    在下方输入器提问开始，或用底部的三种关系从别处带入上下文。
                  </div>
                )}
                {displayedTurns.map((turn) => (
                  <TurnBlock
                    key={turn.id}
                    turn={turn}
                    card={card}
                    index={aiTurns.findIndex((t) => t.id === turn.id) + 1}
                    isBranchPoint={flashTurn === turn.id}
                    streaming={streamingTurnId === turn.id}
                    selectionActive={
                      !IS_DESKTOP_BUILD &&
                      sel?.scope === "selection" &&
                      sel.turnId === turn.id
                    }
                    onConcept={(term, blockText, el) => {
                      recordConceptPreviewOpened({
                        cardId: card.id,
                        turnId: turn.id,
                        concept: term,
                      });
                      openTempCard(term, blockText, turn, el);
                    }}
                    onChild={() =>
                      spawnChild({
                        turnId: turn.id,
                        blockText: turn.content.slice(0, 200),
                      })
                    }
                    onDivergent={() => {
                      setSpawnText("");
                      setSpawn({ kind: "divergent" });
                    }}
                    onBranch={() =>
                      spawnBranch(
                        turn.id,
                        aiTurns.findIndex((t) => t.id === turn.id) + 1,
                      )
                    }
                    onQuote={() =>
                      addReference(
                        {
                          cardId: card.id,
                          turnId: turn.id,
                          text: turn.content
                            .replace(/[#*`>|-]/g, "")
                            .trim()
                            .slice(0, 70),
                          blockText: turn.content.slice(0, 200),
                        },
                        card.title,
                      )
                    }
                    onCopy={() => copy(turn.content, turn.id)}
                    onEditQuestion={(text) => {
                      try {
                        rerouteEditedQuestion(card.id, turn.id, text);
                      } catch (error) {
                        showToast({
                          text:
                            error instanceof Error
                              ? error.message
                              : "无法创建改道分支。",
                        });
                      }
                    }}
                    onRetry={retryLast}
                    onContinue={() => continueAgentRun(turn.id)}
                    onPromoteTrajectory={(_node, draft) => {
                      createCard({
                        type: "child",
                        sourceCardId: card.id,
                        sourceTurnId: turn.id,
                        sourceText: draft.sourceText,
                        sourceBlockText: draft.sourceBlockText,
                        title: draft.title,
                        origin: "trajectory-promotion",
                      });
                      showToast({
                        text: "已通过继承关系提升为真实卡片；轨迹仍不具引用资格。",
                      });
                    }}
                    onCitation={setNoteSource}
                    onOpenLongTurn={(turnId) => setLongTurnId(turnId)}
                    onAdopt={() => setGoldTurnId(turn.id)}
                    copied={copied === turn.id}
                  />
                ))}
                <div style={{ height: 8 }} />
              </div>
            </div>

            {/* 三种关系：位置 + 图标 + 中文标签 */}
            <div className="relation-bar">
              <div style={{ position: "relative" }}>
                <button
                  className="rel-btn k-branch"
                  onClick={() => setSpawn({ kind: "branch" })}
                  title="从某一轮之前的历史另开一条路径"
                >
                  <span className="rel-dir">
                    <GitBranch size={13} />
                  </span>
                  改道 <small>向左分岔</small>
                </button>
                {spawn?.kind === "branch" && (
                  <>
                    <div
                      style={{ position: "fixed", inset: 0, zIndex: 45 }}
                      onClick={() => setSpawn(null)}
                      aria-hidden="true"
                    />
                    <div
                      className="spawn-pop"
                      style={{ left: 0, transform: "none" }}
                      role="dialog"
                      aria-labelledby="branch-pop-title"
                    >
                      <h5 id="branch-pop-title">选择分支点</h5>
                      <p>新卡片继承分支点之前的历史；之后的内容不会带入。</p>
                      {aiTurns.length === 0 && (
                        <p style={{ marginBottom: 0 }}>
                          当前卡片还没有 AI 回复，先提一个问题再改道。
                        </p>
                      )}
                      {aiTurns.map((t, i) => (
                        <button
                          key={t.id}
                          className="fmt-option"
                          onClick={() => {
                            spawnBranch(t.id, i + 1);
                            setSpawn(null);
                          }}
                        >
                          <span className="fmt-icon">
                            <GitBranch size={14} />
                          </span>
                          <span style={{ minWidth: 0 }}>
                            <span className="fmt-name">第 {i + 1} 轮</span>
                            <span className="fmt-desc">
                              {t.content
                                .replace(/[#*`>|\n-]/g, " ")
                                .trim()
                                .slice(0, 42)}
                              …
                            </span>
                          </span>
                        </button>
                      ))}
                      <div className="spawn-row">
                        <button className="btn" onClick={() => setSpawn(null)}>
                          取消
                        </button>
                      </div>
                    </div>
                  </>
                )}
              </div>

              <button
                className="rel-btn k-child"
                onClick={() => spawnChild()}
                title="沿当前路径继续向下"
              >
                <span className="rel-dir">
                  <ArrowDownRight size={13} />
                </span>
                深挖 <small>沿路径向下</small>
              </button>

              <div style={{ position: "relative" }}>
                <button
                  className="rel-btn k-div"
                  onClick={() => {
                    setSpawnText("");
                    setSpawn({ kind: "divergent" });
                  }}
                  title="保留主题相关性，但不继承历史"
                >
                  <span className="rel-dir">
                    <Split size={13} />
                  </span>
                  发散 <small>向右展开</small>
                </button>
                {spawn?.kind === "divergent" && (
                  <>
                    <div
                      style={{ position: "fixed", inset: 0, zIndex: 45 }}
                      onClick={() => setSpawn(null)}
                      aria-hidden="true"
                    />
                    <div
                      className="spawn-pop"
                      style={{ right: 0, left: "auto", transform: "none" }}
                      role="dialog"
                      aria-labelledby="divergent-pop-title"
                    >
                      <h5 id="divergent-pop-title">发散到哪个相关方向？</h5>
                      <p>
                        新卡片只把「{card.title}
                        」当作相关主题，不带入本卡对话历史。
                      </p>
                      <input
                        autoFocus
                        aria-label="发散方向"
                        value={spawnText}
                        onChange={(e) => setSpawnText(e.target.value)}
                        placeholder="例如：这个原理在其他领域怎么用？"
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && spawnText.trim()) {
                            spawnDivergent(spawnText.trim());
                            setSpawn(null);
                          }
                        }}
                      />
                      <div className="spawn-row">
                        <button className="btn" onClick={() => setSpawn(null)}>
                          取消
                        </button>
                        <button
                          className="btn primary"
                          disabled={!spawnText.trim()}
                          onClick={() => {
                            spawnDivergent(spawnText.trim());
                            setSpawn(null);
                          }}
                        >
                          创建发散卡片
                        </button>
                      </div>
                    </div>
                  </>
                )}
              </div>
            </div>
          </motion.article>
        </AnimatePresence>
      </div>

      {/* Web 保留原有的即时选区工具栏。 */}
      {!IS_DESKTOP_BUILD && sel?.scope === "selection" && (
        <div
          className="sel-toolbar"
          style={{ left: sel.x, top: sel.y }}
          role="toolbar"
          aria-label="选区操作"
        >
          <button
            className="tt-btn c-child"
            onClick={() =>
              spawnChild({
                turnId: sel.turnId,
                text: sel.text,
                blockText: sel.blockText,
              })
            }
          >
            <ArrowDownRight size={13} />
            深挖选区
          </button>
          <button
            className="tt-btn"
            onClick={() => {
              addReference(
                {
                  cardId: card.id,
                  turnId: sel.turnId,
                  text: sel.text,
                  blockText: sel.blockText,
                },
                card.title,
              );
              setSel(null);
              window.getSelection()?.removeAllRanges();
            }}
          >
            <Quote size={13} />
            引用选区
          </button>
          <button
            className="tt-btn"
            onClick={() => {
              copy(sel.text, "sel");
              setSel(null);
            }}
          >
            <Copy size={13} />
            复制选区
          </button>
        </div>
      )}

      {/* 桌面端只在回答正文右键时显示；路径导航仍由卡片底部负责。 */}
      {IS_DESKTOP_BUILD && sel && actionTurn && (
        <div
          ref={selectionMenuRef}
          className="menu desktop-turn-context-menu"
          style={{ left: sel.x, top: sel.y }}
          role="menu"
          aria-label={
            sel.scope === "selection" ? "选中文字操作" : "本轮回答操作"
          }
          onContextMenu={(event) => event.preventDefault()}
        >
          {sel.scope === "selection" ? (
            <>
              <button
                className="menu-item"
                role="menuitem"
                onClick={() =>
                  spawnChild({
                    turnId: sel.turnId,
                    text: sel.text,
                    blockText: sel.blockText,
                  })
                }
              >
                <CornerDownRight size={14} />
                用选区创建卡片
              </button>
              <button
                className="menu-item"
                role="menuitem"
                onClick={() => {
                  addReference(
                    {
                      cardId: card.id,
                      turnId: sel.turnId,
                      text: sel.text,
                      blockText: sel.blockText,
                    },
                    card.title,
                  );
                  setSel(null);
                  desktopSelectionRef.current = null;
                  window.getSelection()?.removeAllRanges();
                }}
              >
                <Quote size={14} />
                引用选中内容
              </button>
              <button
                className="menu-item"
                role="menuitem"
                onClick={() => {
                  copy(sel.text, "sel");
                  setSel(null);
                  desktopSelectionRef.current = null;
                  window.getSelection()?.removeAllRanges();
                }}
              >
                <Copy size={14} />
                复制选中内容
              </button>
            </>
          ) : (
            <>
              <button
                className="menu-item"
                role="menuitem"
                disabled={!isGoldEligible(actionTurn)}
                onClick={() => {
                  setGoldTurnId(actionTurn.id);
                  setSel(null);
                }}
              >
                <Star
                  size={14}
                  fill={actionTurn.favorite ? "currentColor" : "none"}
                />
                采纳本轮
              </button>
              <button
                className="menu-item"
                role="menuitem"
                onClick={() => {
                  addReference(
                    {
                      cardId: card.id,
                      turnId: actionTurn.id,
                      text: actionTurn.content
                        .replace(/[#*`>|-]/g, "")
                        .trim()
                        .slice(0, 70),
                      blockText: actionTurn.content.slice(0, 200),
                    },
                    card.title,
                  );
                  setSel(null);
                }}
              >
                <Quote size={14} />
                引用本轮回答
              </button>
              <button
                className="menu-item"
                role="menuitem"
                onClick={() => {
                  copy(actionTurn.content, actionTurn.id);
                  setSel(null);
                }}
              >
                <Copy size={14} />
                复制本轮回答
              </button>
            </>
          )}
        </div>
      )}

      <TempCardLayer
        cards={tempCards}
        flashId={tempFlashId}
        shakeId={tempShakeId}
        onFocus={focusTempCard}
        onMove={moveTempCard}
        onMinimize={minimizeTempCard}
        onRestore={focusTempCard}
        onClose={closeTempCard}
      />
      {noteSource && (
        <NoteSourcePreview
          citation={noteSource}
          projectId={activeProjectId}
          onClose={() => setNoteSource(null)}
        />
      )}
      {pendingRerouteVerdict && (
        <div
          className="overlay"
          onClick={skipRerouteVerdict}
          role="presentation"
          data-testid="reroute-verdict-gate"
        >
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="reroute-verdict-title"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="modal-head">
              <GitBranch size={17} />
              <h3 id="reroute-verdict-title">确认这次改道留下的墓碑</h3>
              <button
                className="icon-btn"
                onClick={skipRerouteVerdict}
                aria-label="跳过墓碑并继续"
              >
                <X size={16} />
              </button>
            </header>
            <div className="modal-body">
              {pendingRerouteVerdict.status === "drafting" ? (
                <p aria-live="polite">正在根据被裁掉的完整问答起草一句墓碑…</p>
              ) : pendingRerouteVerdict.status === "draft-failed" ? (
                <p className="verdict-gate-error" role="alert">
                  {pendingRerouteVerdict.error}
                </p>
              ) : (
                <>
                  <p>
                    这只是临时草稿。确认后才写入判决簿；你也可以改写或跳过。
                  </p>
                  <textarea
                    className="verdict-draft-input"
                    aria-label="墓碑草稿"
                    value={verdictDraft}
                    maxLength={500}
                    disabled={pendingRerouteVerdict.status === "writing"}
                    onChange={(event) => setVerdictDraft(event.target.value)}
                    autoFocus
                  />
                  {pendingRerouteVerdict.error && (
                    <p className="verdict-gate-error" role="alert">
                      {pendingRerouteVerdict.error}
                    </p>
                  )}
                </>
              )}
            </div>
            <footer className="modal-foot">
              <button
                className="btn"
                disabled={pendingRerouteVerdict.status === "writing"}
                onClick={skipRerouteVerdict}
              >
                跳过并继续
              </button>
              {pendingRerouteVerdict.status === "draft-failed" ? (
                <button
                  className="btn primary"
                  onClick={retryRerouteVerdictDraft}
                >
                  重试起草
                </button>
              ) : (
                <button
                  className="btn primary"
                  disabled={
                    pendingRerouteVerdict.status === "drafting" ||
                    pendingRerouteVerdict.status === "writing" ||
                    !verdictDraft.trim()
                  }
                  onClick={() => void confirmRerouteVerdict(verdictDraft)}
                >
                  {pendingRerouteVerdict.status === "writing"
                    ? "正在写入…"
                    : "确认并继续"}
                </button>
              )}
            </footer>
          </section>
        </div>
      )}
      {longTurn && (
        <LongTurnViewer
          turn={longTurn}
          index={aiTurns.findIndex((turn) => turn.id === longTurn.id) + 1}
          onClose={() => setLongTurnId(null)}
          onCopy={() => copy(longTurn.content, longTurn.id)}
          copied={copied === longTurn.id}
        />
      )}
      {goldTurn && (
        <GoldAdoptionDialog
          key={goldTurn.id}
          card={card}
          turn={goldTurn}
          onClose={() => setGoldTurnId(null)}
        />
      )}
    </div>
  );
}

/* ---------------------------------------------------------- */

function TurnBlock({
  turn,
  card,
  index,
  isBranchPoint,
  streaming,
  selectionActive,
  onConcept,
  onChild,
  onDivergent,
  onBranch,
  onQuote,
  onCopy,
  onEditQuestion,
  onRetry,
  onContinue,
  onPromoteTrajectory,
  onCitation,
  onOpenLongTurn,
  onAdopt,
  copied,
}: {
  turn: Turn;
  card: Card;
  index: number;
  isBranchPoint: boolean;
  streaming: boolean;
  selectionActive: boolean;
  onConcept: (term: string, blockText: string, el: HTMLElement) => void;
  onChild: () => void;
  onDivergent: () => void;
  onBranch: () => void;
  onQuote: () => void;
  onCopy: () => void;
  onEditQuestion: (text: string) => void;
  onRetry: () => void;
  onContinue: () => void;
  onPromoteTrajectory: (
    node: AgentTimelineNode,
    draft: TrajectoryPromotionDraft,
  ) => void;
  onCitation: (citation: NoteCitation) => void;
  onOpenLongTurn: (turnId: string) => void;
  onAdopt: () => void;
  copied: boolean;
}) {
  const [more, setMore] = useState(false);
  const [editingQuestion, setEditingQuestion] = useState(false);
  const [questionDraft, setQuestionDraft] = useState("");
  const terminal = turn.agentRun?.terminal;
  const resumableBudgetExit =
    terminal?.result === "partial" &&
    [
      "rounds_exhausted",
      "calls_exhausted",
      "wall_exhausted",
      "tokens_exhausted",
    ].includes(terminal.reason);
  const resumableInterruption =
    Boolean(turn.agentRun) &&
    !terminal &&
    (turn.status === "stopped" || turn.status === "interrupted");

  if (turn.role === "user") {
    return (
      <div className="turn-user" id={`turn-${turn.id}`}>
        {editingQuestion ? (
          <div className="question-editor">
            <textarea
              value={questionDraft}
              onChange={(event) => setQuestionDraft(event.target.value)}
              autoFocus
              aria-label="编辑旧问题并改道"
            />
            <div className="question-editor-actions">
              <button
                className="tt-btn"
                onClick={() => setEditingQuestion(false)}
              >
                取消
              </button>
              <button
                className="tt-btn c-branch"
                disabled={!questionDraft.trim()}
                onClick={() => {
                  onEditQuestion(questionDraft);
                  setEditingQuestion(false);
                }}
              >
                <GitBranch size={13} />
                保存并改道
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="bubble">{turn.content}</div>
            <button
              className="user-edit-btn"
              title="保留原问题，修改后从这里改道"
              onClick={() => {
                setQuestionDraft(turn.content);
                setEditingQuestion(true);
              }}
            >
              <Edit3 size={12} />
              编辑并改道
            </button>
          </>
        )}
      </div>
    );
  }

  return (
    <div
      className={`turn turn-ai${isBranchPoint ? " flash" : ""}${selectionActive ? " selection-active" : ""}`}
      id={`turn-${turn.id}`}
    >
      <div
        className={`turn-toolbar${IS_DESKTOP_BUILD ? " desktop-hidden" : ""}`}
        role="toolbar"
        aria-label={`第 ${index} 轮操作`}
      >
        <button
          className="tt-btn c-child"
          onClick={onChild}
          title="从此轮创建深挖卡片"
        >
          <ArrowDownRight size={13} />
          深挖
        </button>
        <button
          className="tt-btn c-div"
          onClick={onDivergent}
          title="从此轮创建发散卡片"
        >
          <Split size={13} />
          发散
        </button>
        <button
          className="tt-btn c-branch"
          onClick={onBranch}
          title={`从第 ${index} 轮改道，另开一条路径`}
        >
          <GitBranch size={13} />
          从此改道
        </button>
        <span className="tt-sep" />
        <button className="tt-btn" onClick={onQuote} title="把本轮加入引用">
          <Quote size={13} />
          引用
        </button>
        <button className="tt-btn" onClick={onCopy} title="复制本轮 Markdown">
          {copied ? <Check size={13} /> : <Copy size={13} />}
          复制
        </button>
        <div style={{ position: "relative" }}>
          <button
            className="tt-btn"
            onClick={() => setMore((v) => !v)}
            title="更多"
          >
            <MoreHorizontal size={13} />
          </button>
          {more && (
            <>
              <div
                style={{ position: "fixed", inset: 0, zIndex: 55 }}
                onClick={() => setMore(false)}
              />
              <div className="menu" style={{ top: 30, right: 0 }}>
                <button
                  className="menu-item"
                  disabled={!isGoldEligible(turn)}
                  onClick={() => {
                    onAdopt();
                    setMore(false);
                  }}
                >
                  <Star
                    size={14}
                    fill={turn.favorite ? "currentColor" : "none"}
                  />
                  采纳本轮
                </button>
                <button
                  className="menu-item"
                  onClick={() => {
                    onCopy();
                    setMore(false);
                  }}
                >
                  <Copy size={14} />
                  复制为纯文本
                </button>
                <div className="menu-note">
                  第 {index} 轮 · 已保存在本地浏览器
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {__PAPERTABLE_TARGET__ !== "desktop" && (
        <AgentTimeline
          turnId={turn.id}
          streaming={streaming}
          onPromote={onPromoteTrajectory}
        />
      )}

      {streaming && turn.content.length === 0 && (
        <div className="thinking" role="status" aria-live="polite">
          <span className="dot-pulse" />
          {turn.agentPhase === "searching"
            ? "正在检索笔记…"
            : turn.agentPhase === "reading"
              ? "正在阅读来源…"
              : "正在组织回答…"}
        </div>
      )}

      {turn.status === "error" && (
        <div
          className="thinking"
          style={{ color: "var(--danger)", alignItems: "center" }}
        >
          {turn.error ?? "生成失败。"}
          <button
            className="chip-btn"
            onClick={onRetry}
            style={{ marginLeft: 8 }}
          >
            重试
          </button>
        </div>
      )}

      {turn.status === "stopped" && (
        <div className="thinking" style={{ color: "var(--ink-2)" }}>
          {turn.content.trim()
            ? "已停止，已保留生成内容。"
            : "已停止，未产生可显示的最终文本。"}
        </div>
      )}

      {streaming && turn.agentRun && (
        <div className="thinking" role="status" aria-live="polite">
          <span className="dot-pulse" />
          {IS_DESKTOP_BUILD ? "正在继续完成本轮…" : "正在继续深挖同一轮…"}
        </div>
      )}

      {(resumableBudgetExit || resumableInterruption) && !streaming && (
        <div
          className="thinking"
          role="status"
          data-testid={`agent-resume-${turn.id}`}
          style={{ color: "var(--ink-2)", alignItems: "center" }}
        >
          {resumableBudgetExit
            ? IS_DESKTOP_BUILD
              ? "这轮回答尚未完成，当前进度已保存。"
              : "本轮达到预算边界，完整历史已保存。"
            : "本轮在完整步骤边界中断，检查点已保存。"}
          <button
            className="chip-btn"
            onClick={onContinue}
            style={{ marginLeft: 8 }}
          >
            {IS_DESKTOP_BUILD ? "继续完成" : "继续深挖"}
          </button>
        </div>
      )}

      <div className="md" data-turn-ai={turn.id}>
        <Markdown
          content={
            unicodeLength(turn.content) > TURN_PREVIEW_LIMIT
              ? `${unicodeSlice(turn.content, TURN_PREVIEW_LIMIT)}\n\n…`
              : turn.content
          }
          concepts={card.concepts}
          onConcept={onConcept}
        />
        {streaming && turn.content.length > 0 && <span className="caret" />}
      </div>
      {unicodeLength(turn.content) > TURN_PREVIEW_LIMIT && (
        <div className="long-turn-preview">
          <span>
            为保证阅读流畅，仅显示前 {TURN_PREVIEW_LIMIT.toLocaleString()} 字。
          </span>
          <button className="chip-btn" onClick={() => onOpenLongTurn(turn.id)}>
            查看完整内容 · {unicodeLength(turn.content).toLocaleString()} 字
          </button>
        </div>
      )}
      {turn.citations && turn.citations.length > 0 && (
        <div className="note-citation-row" aria-label="笔记引用">
          {turn.citations.map((citation) => (
            <button
              className="note-citation-chip"
              key={citation.chunkId}
              onClick={() => onCitation(citation)}
              title={`查看只读来源：${citation.relativePath}`}
            >
              <Quote size={11} />
              {citation.title}
            </button>
          ))}
        </div>
      )}
      {turn.verdictTrace && (
        <details
          className="verdict-trace"
          data-testid={`verdict-trace-${turn.id}`}
        >
          <summary>
            判决审计 ·{" "}
            {turn.verdictTrace.availability === "unavailable"
              ? "MemOS 不可用"
              : turn.verdictTrace.injectionEnabled
                ? `注入 ${turn.verdictTrace.verdicts.length} 条`
                : `A/B 关闭（命中 ${turn.verdictTrace.verdicts.length} 条）`}
          </summary>
          <div>Prompt：{turn.verdictTrace.promptVersion}</div>
          <div>检索词：{turn.verdictTrace.query || "（空）"}</div>
          {turn.verdictTrace.verdicts.map((verdict) => (
            <div key={verdict.id}>
              {verdict.verdictType === "gold" ? "金子" : "墓碑"} · {verdict.id}{" "}
              · {verdict.snapshot}
            </div>
          ))}
        </details>
      )}
    </div>
  );
}

/**
 * Long model output stays out of the ordinary card DOM after its preview
 * limit. The viewer is deliberately local UI state: it neither creates a
 * Card nor changes the context for a later model call.
 */
function LongTurnViewer({
  turn,
  index,
  onClose,
  onCopy,
  copied,
}: {
  turn: Turn;
  index: number;
  onClose: () => void;
  onCopy: () => void;
  copied: boolean;
}) {
  const pages = useMemo(() => splitLongTurn(turn.content), [turn.content]);
  const [page, setPage] = useState(0);
  const closeRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    setPage(0);
  }, [turn.id]);

  useEffect(() => {
    restoreFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const frame = window.requestAnimationFrame(() => closeRef.current?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === "ArrowLeft")
        setPage((current) => Math.max(0, current - 1));
      if (event.key === "ArrowRight")
        setPage((current) => Math.min(pages.length - 1, current + 1));
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("keydown", onKeyDown);
      if (restoreFocusRef.current?.isConnected) restoreFocusRef.current.focus();
    };
  }, [onClose, pages.length]);

  const atFirstPage = page === 0;
  const atLastPage = page === pages.length - 1;
  return (
    <div className="long-turn-overlay" onClick={onClose} role="presentation">
      <section
        className="long-turn-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`完整回答，第 ${index} 轮`}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="long-turn-head">
          <div>
            <b>完整回答</b>
            <span>
              第 {index} 轮 · 共 {unicodeLength(turn.content).toLocaleString()}{" "}
              字
            </span>
          </div>
          <button
            className="icon-btn"
            ref={closeRef}
            onClick={onClose}
            aria-label="关闭完整回答"
          >
            <X size={16} />
          </button>
        </header>
        <div className="long-turn-body scroll-y">
          <Markdown content={pages[page] ?? ""} />
        </div>
        <footer className="long-turn-foot">
          <span aria-live="polite">
            第 {page + 1} / {pages.length} 页 · 每页最多{" "}
            {TURN_PAGE_LIMIT.toLocaleString()} 字
          </span>
          <div className="long-turn-actions">
            <button className="btn" onClick={onCopy}>
              {copied ? <Check size={14} /> : <Copy size={14} />}
              {copied ? "已复制完整内容" : "复制完整内容"}
            </button>
            <button
              className="icon-btn"
              disabled={atFirstPage}
              onClick={() => setPage((current) => Math.max(0, current - 1))}
              aria-label="上一页"
            >
              <ChevronLeft size={16} />
            </button>
            <button
              className="icon-btn"
              disabled={atLastPage}
              onClick={() =>
                setPage((current) => Math.min(pages.length - 1, current + 1))
              }
              aria-label="下一页"
            >
              <ChevronRight size={16} />
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}
