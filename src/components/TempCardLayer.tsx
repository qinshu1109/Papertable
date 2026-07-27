import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Layers, X } from "lucide-react";
import { useStore } from "../store";
import type { Turn } from "../types";
import {
  ConceptPreview,
  type TempCard,
  type TempReferenceIntent,
} from "./ConceptPreview";

interface Props {
  cards: TempCard[];
  flashId: string | null;
  shakeId: string | null;
  onFocus: (id: string) => void;
  onMove: (id: string, pos: TempCard["pos"]) => void;
  onMinimize: (id: string) => void;
  onRestore: (id: string) => void;
  onClose: (id: string) => void;
}

function useMobileLayout() {
  const [mobile, setMobile] = useState(
    () => window.matchMedia("(max-width: 860px)").matches,
  );
  useEffect(() => {
    const media = window.matchMedia("(max-width: 860px)");
    const update = () => setMobile(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return mobile;
}

export function TempCardLayer({
  cards,
  flashId,
  shakeId,
  onFocus,
  onMove,
  onMinimize,
  onRestore,
  onClose,
}: Props) {
  const {
    cards: knowledgeCards,
    cacheConceptPreview,
    addReference,
    createCard,
    showToast,
  } = useStore();
  const mobile = useMobileLayout();
  const [activeMobileId, setActiveMobileId] = useState<string | null>(null);
  const [mobileCollapsed, setMobileCollapsed] = useState(false);
  const previousCount = useRef(0);
  const dockWasOpen = useRef(false);
  const swipe = useRef<number | null>(null);
  const openerByCardId = useRef(new Map<string, HTMLElement>());
  const knownCardIds = useRef(new Set<string>());

  const topCard = useMemo(
    () => [...cards].sort((a, b) => b.z - a.z)[0],
    [cards],
  );
  const activeMobile =
    cards.find((card) => card.id === activeMobileId) ?? topCard;

  useEffect(() => {
    if (!cards.length) {
      setActiveMobileId(null);
      setMobileCollapsed(false);
      previousCount.current = 0;
      return;
    }
    if (
      cards.length > previousCount.current ||
      !cards.some((card) => card.id === activeMobileId)
    ) {
      setActiveMobileId(topCard?.id ?? null);
      setMobileCollapsed(false);
    }
    previousCount.current = cards.length;
  }, [activeMobileId, cards, topCard?.id]);

  // A temporary card is a foreground reading layer, not a graph mutation.
  // Remember the concept trigger so Escape/close leaves keyboard users where
  // they started instead of dumping focus onto the document body.
  useEffect(() => {
    const active =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    for (const card of cards) {
      if (!knownCardIds.current.has(card.id) && active)
        openerByCardId.current.set(card.id, active);
    }
    const nextIds = new Set(cards.map((card) => card.id));
    for (const id of openerByCardId.current.keys()) {
      if (!nextIds.has(id)) openerByCardId.current.delete(id);
    }
    knownCardIds.current = nextIds;
  }, [cards]);

  const closeWithFocus = useCallback(
    (id: string) => {
      const opener = openerByCardId.current.get(id);
      onClose(id);
      window.requestAnimationFrame(() => {
        if (opener?.isConnected) opener.focus();
      });
    },
    [onClose],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const top = [...cards]
        .filter((card) => !card.minimized)
        .sort((a, b) => b.z - a.z)[0];
      if (!top) return;
      event.preventDefault();
      closeWithFocus(top.id);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [cards, closeWithFocus]);

  useEffect(() => {
    const dockOpen = !mobile && cards.some((card) => card.minimized);
    if (dockOpen && !dockWasOpen.current) {
      for (const tempCard of cards.filter((card) => !card.minimized)) {
        onMove(tempCard.id, {
          x: tempCard.pos.x,
          y: Math.max(8, tempCard.pos.y - 48),
        });
      }
    }
    dockWasOpen.current = dockOpen;
  }, [cards, mobile, onMove]);

  if (!cards.length) return null;

  const sourceFor = (tempCard: TempCard) =>
    knowledgeCards.find((card) => card.id === tempCard.anchor.cardId);

  const cacheKey = (tempCard: TempCard) =>
    `${tempCard.anchor.turnId ?? "card"}:${tempCard.term}`;

  const cachedText = (tempCard: TempCard) => {
    const entry =
      sourceFor(tempCard)?.conceptPreviewCache?.[cacheKey(tempCard)];
    if (!entry || entry.sourceRevision !== tempCard.anchor.sourceRevision)
      return undefined;
    return entry.content;
  };

  const addTempReference = (
    tempCard: TempCard,
    intent: TempReferenceIntent,
    content: string,
  ) => {
    const source = sourceFor(tempCard);
    if (!source) {
      showToast({ text: "来源卡片已不存在，无法带入主探索。" });
      return;
    }
    const label =
      intent === "background"
        ? `背景 · ${tempCard.term}：${content}`
        : `${tempCard.term}：${content}`;
    addReference(
      {
        ...tempCard.anchor,
        text: label,
        exact: tempCard.anchor.exact ?? tempCard.term,
      },
      source.title,
    );
    showToast({
      text:
        intent === "background"
          ? "已作为背景引用带入当前探索"
          : "已加入输入器引用",
    });
  };

  const promote = (tempCard: TempCard, term: string, seedTurns: Turn[]) => {
    const source = sourceFor(tempCard);
    if (!source) {
      showToast({ text: "来源卡片已不存在，无法展开。" });
      return;
    }
    try {
      createCard({
        type: "child",
        sourceCardId: source.id,
        sourceTurnId: tempCard.anchor.turnId,
        sourceText: term,
        sourceBlockText: tempCard.anchor.blockText,
        title: term,
        origin: "concept-promotion",
        seedTurns,
      });
      onClose(tempCard.id);
    } catch (error) {
      showToast({
        text: error instanceof Error ? error.message : "无法展开临时卡片。",
      });
    }
  };

  const mobileTabs = (
    <div
      className="temp-sheet-tabs"
      onPointerDown={(event) => {
        swipe.current = event.clientY;
      }}
      onPointerUp={(event) => {
        if (swipe.current !== null && event.clientY - swipe.current > 42)
          setMobileCollapsed(true);
        swipe.current = null;
      }}
      onPointerCancel={() => {
        swipe.current = null;
      }}
    >
      <span className="temp-sheet-grip" aria-hidden="true" />
      <div className="temp-tab-row" role="tablist" aria-label="临时卡片">
        {cards.map((tempCard) => (
          <span
            className={`temp-tab${tempCard.id === activeMobile?.id ? " active" : ""}`}
            key={tempCard.id}
          >
            <button
              role="tab"
              aria-selected={tempCard.id === activeMobile?.id}
              onClick={() => {
                setActiveMobileId(tempCard.id);
                onFocus(tempCard.id);
              }}
            >
              {tempCard.term}
            </button>
            <button
              aria-label={`关闭临时卡片：${tempCard.term}`}
              onClick={() => closeWithFocus(tempCard.id)}
            >
              <X size={11} />
            </button>
          </span>
        ))}
      </div>
    </div>
  );

  return (
    <>
      {cards.map((tempCard) => {
        const source = sourceFor(tempCard);
        return (
          <ConceptPreview
            key={tempCard.id}
            card={tempCard}
            sourceTitle={source?.title ?? "来源卡片"}
            cachedText={cachedText(tempCard)}
            mode={mobile ? "sheet" : "window"}
            hidden={
              mobile
                ? mobileCollapsed || tempCard.id !== activeMobile?.id
                : tempCard.minimized
            }
            flash={flashId === tempCard.id}
            shake={shakeId === tempCard.id}
            mobileTabs={
              mobile && tempCard.id === activeMobile?.id
                ? mobileTabs
                : undefined
            }
            onCache={(content) =>
              cacheConceptPreview(tempCard.anchor.cardId, cacheKey(tempCard), {
                sourceRevision:
                  tempCard.anchor.sourceRevision ??
                  `${tempCard.anchor.cardId}:unknown`,
                content,
                createdAt: Date.now(),
              })
            }
            onFocus={() => onFocus(tempCard.id)}
            onMove={(pos) => onMove(tempCard.id, pos)}
            onMinimize={() => {
              if (mobile) setMobileCollapsed(true);
              else onMinimize(tempCard.id);
            }}
            onClose={() => closeWithFocus(tempCard.id)}
            onReference={(intent, content) =>
              addTempReference(tempCard, intent, content)
            }
            onPromote={(term, seedTurns) => promote(tempCard, term, seedTurns)}
          />
        );
      })}

      {!mobile && cards.some((card) => card.minimized) && (
        <div className="temp-dock" aria-label="已最小化的临时卡片">
          <span className="temp-dock-label">
            <Layers size={12} />
            临时卡片
          </span>
          {cards
            .filter((card) => card.minimized)
            .map((tempCard) => (
              <span className="temp-dock-chip" key={tempCard.id}>
                <button
                  onClick={() => onRestore(tempCard.id)}
                  title={`恢复「${tempCard.term}」`}
                >
                  {tempCard.term}
                </button>
                <button
                  onClick={() => closeWithFocus(tempCard.id)}
                  aria-label={`关闭临时卡片：${tempCard.term}`}
                >
                  <X size={11} />
                </button>
              </span>
            ))}
        </div>
      )}

      {mobile && mobileCollapsed && (
        <button
          className="temp-mobile-handle"
          onClick={() => {
            setMobileCollapsed(false);
            if (activeMobile) onFocus(activeMobile.id);
          }}
          onPointerDown={(event) => {
            swipe.current = event.clientY;
          }}
          onPointerUp={(event) => {
            if (swipe.current !== null && swipe.current - event.clientY > 32)
              setMobileCollapsed(false);
            swipe.current = null;
          }}
          aria-label={`展开 ${cards.length} 张临时卡片`}
        >
          <span />
          {cards.length} 张临时卡片
        </button>
      )}
    </>
  );
}
