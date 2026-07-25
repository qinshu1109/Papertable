import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowDownRight,
  ArrowUpLeft,
  Check,
  Copy,
  CornerDownRight,
  GitBranch,
  MoreHorizontal,
  Quote,
  Split,
  Star,
  Trash2,
} from "lucide-react";
import { useStore } from "../store";
import { EDGE_META } from "../types";
import type { Card, Turn } from "../types";
import { incomingEdge, pathToRoot } from "../lib/graph";
import { Markdown } from "../lib/markdown";
import { ConceptPreview, type ConceptState } from "./ConceptPreview";

const spring = {
  type: "spring" as const,
  stiffness: 260,
  damping: 30,
  mass: 0.9,
};

interface SelState {
  x: number;
  y: number;
  text: string;
  blockText: string;
  turnId: string;
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
    cards,
    edges,
    currentCardId,
    setCurrentCard,
    createCard,
    deleteCard,
    toggleFavoriteCard,
    addReference,
    cacheConceptPreview,
    rememberCardScroll,
    cardScroll,
    retryLast,
    lastCreated,
    streamingTurnId,
    showToast,
  } = useStore();

  const card = cards.find((c) => c.id === currentCardId);
  const path = useMemo(
    () => pathToRoot(edges, currentCardId),
    [edges, currentCardId],
  );
  const ancestors = path.slice(0, -1).slice(-3).reverse();

  const bodyRef = useRef<HTMLDivElement>(null);
  const [sel, setSel] = useState<SelState | null>(null);
  const [concept, setConcept] = useState<ConceptState | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [spawn, setSpawn] = useState<
    null | { kind: "divergent" } | { kind: "branch" }
  >(null);
  const [spawnText, setSpawnText] = useState("");
  const [flashTurn, setFlashTurn] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const prevCard = useRef(currentCardId);

  /* ---------- 每张卡片独立滚动位置 ---------- */
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    if (prevCard.current !== currentCardId) prevCard.current = currentCardId;
    el.scrollTop = cardScroll(currentCardId);
  }, [cardScroll, currentCardId]);

  const rememberScroll = () => {
    if (bodyRef.current)
      rememberCardScroll(currentCardId, bodyRef.current.scrollTop);
  };

  const goCard = useCallback(
    (id: string) => {
      rememberScroll();
      setSel(null);
      setConcept(null);
      setCurrentCard(id);
    },
    [currentCardId, setCurrentCard],
  );

  /* ---------- 流式时自动滚到底 ---------- */
  useEffect(() => {
    if (!streamingTurnId || !bodyRef.current) return;
    bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [streamingTurnId, cards]);

  /* ---------- 真实浏览器文本选择 ---------- */
  useEffect(() => {
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

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setSel(null);
      setConcept(null);
      setSpawn(null);
      setMenuOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  if (!card) return <div className="stage" />;

  const inEdge = incomingEdge(edges, card.id);
  const sourceCard = inEdge
    ? cards.find((c) => c.id === inEdge.sourceCardId)
    : undefined;
  const meta = inEdge ? EDGE_META[inEdge.type] : null;

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
    window.getSelection()?.removeAllRanges();
    return id;
  };

  const spawnDivergent = (topic: string) => {
    rememberScroll();
    createCard({
      type: "divergent",
      sourceCardId: card.id,
      title: topic.slice(0, 26),
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
    rememberScroll();
    createCard({
      type: "branch",
      sourceCardId: card.id,
      sourceTurnId: turnId,
      title: `${card.title} · 另一条路径`,
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
  const aiTurns = card.turns.filter((t) => t.role === "ai");

  return (
    <div className="stage">
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
                <h1 className="card-title">{card.title}</h1>
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
                        {inEdge?.type === "branch" && inEdge.sourceTurnId
                          ? `从第 ${
                              cards
                                .find((c) => c.id === inEdge.sourceCardId)!
                                .turns.filter((t) => t.role === "ai")
                                .findIndex(
                                  (t) => t.id === inEdge.sourceTurnId,
                                ) + 1
                            } 轮改道：${sourceCard.title}`
                          : `${meta.verb}：${sourceCard.title}`}
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
                <button
                  className="deep-btn"
                  onClick={() => spawnChild()}
                  title="以当前卡片为来源创建深挖卡片"
                >
                  <ArrowDownRight size={14} />
                  深挖
                </button>
              </div>
            </header>

            <div
              className="card-body scroll-y"
              ref={bodyRef}
              onScroll={rememberScroll}
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
                {card.turns.map((turn) => (
                  <TurnBlock
                    key={turn.id}
                    turn={turn}
                    card={card}
                    index={aiTurns.findIndex((t) => t.id === turn.id) + 1}
                    isBranchPoint={flashTurn === turn.id}
                    streaming={streamingTurnId === turn.id}
                    selectionActive={sel?.turnId === turn.id}
                    onConcept={(term, blockText, el) => {
                      const r = el.getBoundingClientRect();
                      setConcept({
                        term,
                        blockText,
                        cardId: card.id,
                        turnId: turn.id,
                        sourceRevision: sourceRevision(turn),
                        x: Math.min(r.left, window.innerWidth - 440),
                        y: Math.min(r.bottom + 10, window.innerHeight - 340),
                      });
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
                    onRetry={retryLast}
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

      {/* 文本选择工具栏 */}
      {sel && (
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

      {/* 概念预览 */}
      {concept && (
        <ConceptPreview
          state={concept}
          sourceTitle={card.title}
          cachedText={(() => {
            const entry =
              card.conceptPreviewCache?.[
                `${concept.turnId ?? "card"}:${concept.term}`
              ];
            return entry?.sourceRevision === concept.sourceRevision
              ? entry.content
              : undefined;
          })()}
          onCache={(content) =>
            cacheConceptPreview(
              card.id,
              `${concept.turnId ?? "card"}:${concept.term}`,
              {
                sourceRevision: concept.sourceRevision,
                content,
                createdAt: Date.now(),
              },
            )
          }
          onClose={() => setConcept(null)}
          onQuote={(text) => {
            addReference(
              {
                cardId: card.id,
                turnId: concept.turnId,
                text,
                blockText: concept.blockText,
              },
              card.title,
            );
            setConcept(null);
          }}
          onPromote={(term, body) => {
            rememberScroll();
            createCard({
              type: "child",
              sourceCardId: card.id,
              sourceTurnId: concept.turnId,
              sourceText: term,
              sourceBlockText: concept.blockText,
              title: term,
              seedTurns: [
                {
                  id: `t-${Date.now()}-u`,
                  role: "user",
                  content: `深挖概念：${term}`,
                  createdAt: Date.now(),
                },
                {
                  id: `t-${Date.now()}-a`,
                  role: "ai",
                  content: body,
                  createdAt: Date.now(),
                },
              ],
            });
            setConcept(null);
          }}
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
  onRetry,
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
  onRetry: () => void;
  copied: boolean;
}) {
  const [more, setMore] = useState(false);

  if (turn.role === "user") {
    return (
      <div className="turn-user" id={`turn-${turn.id}`}>
        <div className="bubble">{turn.content}</div>
      </div>
    );
  }

  return (
    <div
      className={`turn turn-ai${isBranchPoint ? " flash" : ""}${selectionActive ? " selection-active" : ""}`}
      id={`turn-${turn.id}`}
    >
      <div
        className="turn-toolbar"
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
                <button className="menu-item" onClick={() => setMore(false)}>
                  <Star size={14} />
                  收藏本轮
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

      {streaming && turn.content.length === 0 && (
        <div className="thinking" role="status" aria-live="polite">
          <span className="dot-pulse" />
          正在生成回答…
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
          已停止，已保留生成内容。
        </div>
      )}

      <div className="md" data-turn-ai={turn.id}>
        <Markdown
          content={turn.content}
          concepts={card.concepts}
          onConcept={onConcept}
        />
        {streaming && turn.content.length > 0 && <span className="caret" />}
      </div>
    </div>
  );
}
