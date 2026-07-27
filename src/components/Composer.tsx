import { useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  ChevronDown,
  Compass,
  Cpu,
  Layers,
  LoaderCircle,
  MoreHorizontal,
  Paperclip,
  Quote,
  RotateCcw,
  Square,
  X,
  XCircle,
} from "lucide-react";
import { useStore } from "../store";

export function Composer({
  onLocate,
}: {
  onLocate: (cardId: string, turnId?: string) => void;
}) {
  const {
    activeProjectId,
    references,
    draft: storedDraft,
    setDraft,
    removeReference,
    clearReferences,
    send,
    stopStream,
    retryLast,
    streamingTurnId,
    backgroundGenerationCount,
    contextForCurrent,
    currentCardId,
    hasCurrentCard,
    cardById,
    setCardAnswerMode,
    provider,
    refreshProvider,
    showToast,
    agentMode,
    noteLibraries,
    boundNoteLibraryIds,
  } = useStore();
  const [modelOpen, setModelOpen] = useState(false);
  const [ctxOpen, setCtxOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [localDraft, setLocalDraft] = useState(storedDraft);
  const draftsByCardId = useRef<Record<string, string>>({
    [currentCardId]: storedDraft,
  });
  const previousProject = useRef(activeProjectId);
  const ta = useRef<HTMLTextAreaElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const modelTriggerRef = useRef<HTMLButtonElement>(null);
  const contextTriggerRef = useRef<HTMLButtonElement>(null);
  const moreTriggerRef = useRef<HTMLButtonElement>(null);
  const modelMenuRef = useRef<HTMLDivElement>(null);
  const contextPanelRef = useRef<HTMLDivElement>(null);
  const moreMenuRef = useRef<HTMLDivElement>(null);
  // Debounce only the same card's send button. A user can deliberately move
  // to another project while the first card is streaming; that second card
  // must be allowed to start its own independent background generation.
  const lastSubmitAtByCard = useRef<Record<string, number>>({});
  // Desktop hydration can briefly expose a saved provider.json to Settings
  // before the shared store has refreshed providerStatus.  A submit must
  // verify once rather than falsely telling the user that a configured model
  // is missing.  The ref also keeps a double click from launching two checks.
  const providerCheckInFlight = useRef(false);
  const built = contextForCurrent();
  const boundLibraries = noteLibraries.filter((library) =>
    boundNoteLibraryIds.includes(library.id),
  );
  const availableBoundLibraries = boundLibraries.filter(
    (library) =>
      library.availability === undefined || library.availability === "ready",
  );
  const latestAgentRun = [...(cardById(currentCardId)?.turns ?? [])]
    .reverse()
    .find((turn) => turn.role === "ai" && turn.agentRun)?.agentRun;

  useEffect(() => {
    const projectChanged = previousProject.current !== activeProjectId;
    previousProject.current = activeProjectId;
    const next =
      draftsByCardId.current[currentCardId] ??
      (projectChanged ? storedDraft : "");
    draftsByCardId.current[currentCardId] = next;
    setLocalDraft(next);
    setDraft(next);
  }, [activeProjectId, currentCardId]);

  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    const resize = () => {
      const mobile = window.matchMedia("(max-width: 860px)").matches;
      const maxHeight = Math.min(24 * 10 + 12, window.innerHeight * 0.32);
      const mobileMaxHeight = window.innerHeight * 0.24;
      const limit = mobile ? mobileMaxHeight : maxHeight;
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, limit)}px`;
      el.style.overflowY = el.scrollHeight > limit ? "auto" : "hidden";
    };
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [localDraft]);

  useEffect(() => {
    const element = wrapRef.current;
    if (!element) return;
    const publishHeight = () => {
      document.documentElement.style.setProperty(
        "--composer-live-height",
        `${Math.ceil(element.getBoundingClientRect().height)}px`,
      );
    };
    const observer = new ResizeObserver(publishHeight);
    observer.observe(element);
    publishHeight();
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (hasCurrentCard) return;
    setCtxOpen(false);
    setMoreOpen(false);
  }, [hasCurrentCard]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (ctxOpen) {
        event.preventDefault();
        closeContextPanel();
      } else if (modelOpen) {
        event.preventDefault();
        closeModelMenu();
      } else if (moreOpen) {
        event.preventDefault();
        closeMoreMenu();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [ctxOpen, modelOpen, moreOpen]);

  useEffect(() => {
    if (!ctxOpen) return;
    const frame = window.requestAnimationFrame(() =>
      contextPanelRef.current?.focus(),
    );
    return () => window.cancelAnimationFrame(frame);
  }, [ctxOpen]);

  useEffect(() => {
    if (!modelOpen) return;
    const frame = window.requestAnimationFrame(() =>
      modelMenuRef.current?.focus(),
    );
    return () => window.cancelAnimationFrame(frame);
  }, [modelOpen]);

  useEffect(() => {
    if (!moreOpen) return;
    const frame = window.requestAnimationFrame(() =>
      moreMenuRef.current?.focus(),
    );
    return () => window.cancelAnimationFrame(frame);
  }, [moreOpen]);

  const updateDraft = (value: string) => {
    if (!hasCurrentCard) return;
    draftsByCardId.current[currentCardId] = value;
    setLocalDraft(value);
    setDraft(value);
  };

  const restoreFocus = (target: React.RefObject<HTMLButtonElement>) => {
    window.requestAnimationFrame(() => target.current?.focus());
  };

  const closeContextPanel = () => {
    setCtxOpen(false);
    restoreFocus(contextTriggerRef);
  };

  const closeModelMenu = () => {
    setModelOpen(false);
    restoreFocus(modelTriggerRef);
  };

  const closeMoreMenu = () => {
    setMoreOpen(false);
    restoreFocus(moreTriggerRef);
  };

  const toggleContextPanel = () => {
    if (!hasCurrentCard) return;
    if (ctxOpen) return closeContextPanel();
    setModelOpen(false);
    setMoreOpen(false);
    setCtxOpen(true);
  };

  const toggleModelMenu = () => {
    if (modelOpen) return closeModelMenu();
    setCtxOpen(false);
    setMoreOpen(false);
    setModelOpen(true);
  };

  const toggleMoreMenu = () => {
    if (!hasCurrentCard) return;
    if (moreOpen) return closeMoreMenu();
    setCtxOpen(false);
    setModelOpen(false);
    setMoreOpen(true);
  };

  const submit = async () => {
    if (!hasCurrentCard) {
      showToast({ text: "请先新建一张根卡片，再开始提问。" });
      return;
    }
    if (!localDraft.trim() || streamingTurnId) return;
    if (!provider?.configured) {
      if (providerCheckInFlight.current) return;
      providerCheckInFlight.current = true;
      let health;
      try {
        health = await refreshProvider();
      } finally {
        providerCheckInFlight.current = false;
      }
      if (!health?.configured) {
        showToast({
          text: "模型尚未配置。请在设置中填写接口地址、模型和 API 密钥。",
        });
        return;
      }
      // The current closure still contains the old status, but the model
      // provider itself has just confirmed the configuration. Continue with
      // this user action instead of forcing a redundant second click.
    }
    const now = Date.now();
    if (now - (lastSubmitAtByCard.current[currentCardId] ?? 0) < 500) return;
    lastSubmitAtByCard.current[currentCardId] = now;
    send(localDraft);
    draftsByCardId.current[currentCardId] = "";
    setLocalDraft("");
    setDraft("");
    window.requestAnimationFrame(() => ta.current?.focus());
  };

  const tokens = built.estimatedTokens;
  const pct = Math.min(100, Math.round((tokens / 8_000) * 100));
  const answerModeLabel =
    built.answerMode === "sources-only" ? "仅依据材料" : "通用探索";
  const answerModeDetail =
    built.answerMode === "sources-only"
      ? "只依据上面明确列出的上下文；证据不足时会直接说明。"
      : "优先依据上面明确列出的上下文；材料不足时可补充通用知识，并会区分材料、通用知识和推断。";
  const toggleAnswerMode = () => {
    if (!hasCurrentCard) return;
    setCardAnswerMode(
      currentCardId,
      built.answerMode === "general" ? "sources-only" : "general",
    );
  };

  return (
    <div className="composer-wrap" ref={wrapRef}>
      <div className="composer">
        {references.length > 0 && (
          <div className="ref-strip">
            {references.map((reference) => (
              <span className="ref-chip" key={reference.id}>
                <Quote size={11} style={{ flexShrink: 0 }} />
                <span className="rc-src">{reference.sourceTitle}</span>
                <button
                  className="rc-goto"
                  onClick={() =>
                    onLocate(reference.anchor.cardId, reference.anchor.turnId)
                  }
                  title="定位回来源段落"
                >
                  {reference.excerpt.length > 34
                    ? `${reference.excerpt.slice(0, 34)}…`
                    : reference.excerpt}
                </button>
                <button
                  onClick={() => removeReference(reference.id)}
                  aria-label="移除引用"
                >
                  <X size={12} />
                </button>
              </span>
            ))}
            <button
              className="ref-chip"
              style={{ background: "transparent" }}
              onClick={clearReferences}
            >
              <XCircle size={11} />
              清空
            </button>
          </div>
        )}

        {ctxOpen && (
          <>
            <div
              style={{ position: "fixed", inset: 0, zIndex: 35 }}
              onClick={closeContextPanel}
            />
            <div
              className="ctx-panel"
              id="composer-context-panel"
              ref={contextPanelRef}
              role="dialog"
              aria-label="本次上下文"
              aria-modal="false"
              tabIndex={-1}
            >
              <h4>本次上下文</h4>
              <p className="ctx-sub">
                这是即将发给模型的真实上下文。关系和引用决定它带入什么，而不是界面上的猜测。
              </p>
              <div className="ctx-answer-mode">
                <div className="ctx-group-t">回答依据</div>
                <p>
                  <b>{answerModeLabel}</b> · {answerModeDetail}
                </p>
              </div>
              <div className="ctx-group">
                <div className="ctx-group-t">会带入</div>
                {built.provenance.map((item, index) => (
                  <div
                    className="ctx-line"
                    key={`${item.kind}-${item.cardId ?? index}-${index}`}
                  >
                    {item.kind === "reference" ? (
                      <Quote size={13} color="var(--ctx)" />
                    ) : (
                      <Layers size={13} color="var(--ctx)" />
                    )}
                    <span>
                      <b>{item.label}</b>：{item.detail}
                    </span>
                  </div>
                ))}
              </div>
              <div className="ctx-group">
                <div className="ctx-group-t">不会带入</div>
                {built.excluded.map((item, index) => (
                  <div
                    className="ctx-line excluded"
                    key={`${item.kind}-${item.cardId ?? index}-${index}`}
                  >
                    <XCircle size={13} />
                    <span>{item.detail}</span>
                  </div>
                ))}
              </div>
              <div className="ctx-group">
                <div className="ctx-group-t">本轮检索</div>
                <div className="ctx-line">
                  <Layers size={13} color="var(--ctx)" />
                  <span>
                    {boundNoteLibraryIds.length
                      ? availableBoundLibraries.length
                        ? `已绑定 ${boundNoteLibraryIds.length} 个只读资料库 · 当前可用 ${availableBoundLibraries.length} 个 · ${agentMode === "native-tools" ? "原生工具" : "双阶段检索"}`
                        : `已绑定 ${boundNoteLibraryIds.length} 个只读资料库，但当前均不可用；本轮不会检索笔记。`
                      : "当前项目未绑定资料库；本轮不会检索笔记。"}
                  </span>
                </div>
                {latestAgentRun && (
                  <div className="ctx-line">
                    <Layers size={13} color="var(--branch)" />
                    <span>
                      上次实际读取 {latestAgentRun.readChunkIds.length}{" "}
                      个片段、命中 {latestAgentRun.hitCount} 项
                      {latestAgentRun.retrievalUnavailable
                        ? " · 检索不可用"
                        : ""}
                    </span>
                  </div>
                )}
              </div>
              <div className="ctx-foot">
                <span>约 {tokens.toLocaleString()} tokens · 预算 8,000</span>
                <span className="meter" aria-label={`上下文占用 ${pct}%`}>
                  <i style={{ width: `${Math.max(4, pct)}%` }} />
                </span>
              </div>
            </div>
          </>
        )}

        <div className="composer-box composer-v2">
          <textarea
            ref={ta}
            rows={1}
            value={localDraft}
            onChange={(event) => updateDraft(event.target.value)}
            placeholder={
              hasCurrentCard
                ? "继续追问，或选中正文建立引用…"
                : "请先在上方新建根卡片，再开始提问"
            }
            disabled={!hasCurrentCard}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void submit();
              }
            }}
            aria-label="提问输入框"
          />

          <div className="composer-control-row">
            <div className="composer-controls-left">
              <div className="composer-pop-anchor">
                <button
                  className="chip-btn model-chip"
                  ref={modelTriggerRef}
                  onClick={toggleModelMenu}
                  title="模型与连接状态"
                  aria-label={`模型与连接状态：CozAI · ${provider?.model ?? "Claude Opus 5"}`}
                  aria-expanded={modelOpen}
                  aria-controls="composer-model-menu"
                >
                  <Cpu size={13} />
                  <span className="desktop-model">
                    CozAI · {provider?.model ?? "Claude Opus 5"}
                  </span>
                  <span className="mobile-model">Opus 5</span>
                  <ChevronDown size={12} className="model-chevron" />
                </button>
                {modelOpen && (
                  <>
                    <div
                      style={{ position: "fixed", inset: 0, zIndex: 55 }}
                      onClick={closeModelMenu}
                    />
                    <div
                      className="menu composer-menu composer-model-menu"
                      id="composer-model-menu"
                      ref={modelMenuRef}
                      role="dialog"
                      aria-label="模型与连接状态"
                      tabIndex={-1}
                    >
                      <div className="menu-note">
                        <b style={{ color: "var(--ink-2)" }}>
                          CozAI · {provider?.model ?? "claude-opus-5"}
                        </b>
                        <br />
                        {provider?.configured
                          ? "本机代理已配置，密钥不会进入浏览器。"
                          : (provider?.message ?? "尚未配置模型")}
                        <br />
                        Harness：
                        {agentMode === "native-tools"
                          ? "原生工具"
                          : "双阶段检索"}
                      </div>
                      <button
                        className="menu-item"
                        onClick={() => void refreshProvider()}
                      >
                        <RotateCcw size={14} />
                        测试连接
                      </button>
                    </div>
                  </>
                )}
              </div>

              <button
                className={`chip-btn${ctxOpen ? " on" : ""}`}
                ref={contextTriggerRef}
                onClick={toggleContextPanel}
                disabled={!hasCurrentCard}
                title="查看本次提问会带入什么上下文"
                aria-label={`本次上下文，共 ${built.provenance.length} 项`}
                aria-expanded={ctxOpen}
                aria-controls="composer-context-panel"
              >
                <Layers size={13} />
                <span className="desktop-context-label">本次上下文</span>
                <span className="mobile-context-label">上下文</span>
                <span className="ctx-count">{built.provenance.length}</span>
              </button>

              <button
                className={`chip-btn answer-mode answer-mode-direct ${built.answerMode}`}
                onClick={toggleAnswerMode}
                disabled={!hasCurrentCard}
                title={`回答依据：${answerModeLabel}；点击切换`}
                aria-label={`回答依据：${answerModeLabel}；点击切换`}
              >
                <Compass size={13} />
                <span>{answerModeLabel}</span>
              </button>

              {backgroundGenerationCount > 0 && (
                <span
                  className="background-generation-chip"
                  role="status"
                  aria-label={`另有 ${backgroundGenerationCount} 张卡片正在后台生成`}
                  title="切换卡片或项目不会停止这些回答"
                >
                  <LoaderCircle size={13} />
                  <span className="desktop-background-label">
                    后台生成 {backgroundGenerationCount}
                  </span>
                  <span className="mobile-background-label">
                    {backgroundGenerationCount}
                  </span>
                </span>
              )}

              <div className="composer-pop-anchor composer-more">
                <button
                  className="icon-btn"
                  ref={moreTriggerRef}
                  onClick={toggleMoreMenu}
                  disabled={!hasCurrentCard}
                  aria-label="更多输入设置"
                  title="更多输入设置"
                  aria-expanded={moreOpen}
                  aria-controls="composer-more-menu"
                >
                  <MoreHorizontal size={16} />
                </button>
                {moreOpen && (
                  <>
                    <div
                      style={{ position: "fixed", inset: 0, zIndex: 55 }}
                      onClick={closeMoreMenu}
                    />
                    <div
                      className="menu composer-menu composer-more-menu"
                      id="composer-more-menu"
                      ref={moreMenuRef}
                      role="dialog"
                      aria-label="更多输入设置"
                      tabIndex={-1}
                    >
                      <button
                        className="menu-item"
                        onClick={() => {
                          toggleAnswerMode();
                          closeMoreMenu();
                        }}
                        aria-label={`回答依据：${answerModeLabel}；点击切换`}
                      >
                        <Compass size={14} />
                        {answerModeLabel}
                      </button>
                      <div className="menu-note">{answerModeDetail}</div>
                    </div>
                  </>
                )}
              </div>
            </div>

            <div className="composer-controls-right">
              <button
                className="icon-btn"
                title="导入附件"
                disabled={!hasCurrentCard}
                onClick={() =>
                  showToast({
                    text: "本轮可通过左侧「导入笔记」导入 Markdown、Canvas 或项目包。",
                  })
                }
              >
                <Paperclip size={16} />
              </button>
              {!streamingTurnId && (
                <button
                  className="icon-btn"
                  title="重新生成最后一次提问"
                  onClick={retryLast}
                  disabled={!hasCurrentCard}
                >
                  <RotateCcw size={15} />
                </button>
              )}
              {streamingTurnId ? (
                <button
                  className="send-btn stop"
                  onClick={() => stopStream()}
                  title="停止生成"
                  aria-label="停止生成"
                >
                  <Square size={13} fill="currentColor" />
                </button>
              ) : (
                <button
                  className="send-btn"
                  onClick={() => void submit()}
                  disabled={!hasCurrentCard || !localDraft.trim()}
                  title="发送（Enter）；换行请按 Shift+Enter"
                  aria-label="发送"
                >
                  <ArrowUp size={17} />
                </button>
              )}
            </div>
          </div>
        </div>
        {!hasCurrentCard && (
          <p className="composer-empty-notice" role="status">
            当前项目没有可用卡片。请先新建根卡片；在此之前不会发送模型请求。
          </p>
        )}
        <span className="sr-only" aria-live="polite">
          {streamingTurnId ? "正在生成回答，可随时停止" : ""}
        </span>
      </div>
    </div>
  );
}
