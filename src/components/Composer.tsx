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
    setCardAnswerMode,
    provider,
    refreshProvider,
    showToast,
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
  const built = contextForCurrent();

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
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setCtxOpen(false);
      setModelOpen(false);
      setMoreOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const updateDraft = (value: string) => {
    draftsByCardId.current[currentCardId] = value;
    setLocalDraft(value);
    setDraft(value);
  };

  const submit = () => {
    if (!localDraft.trim() || streamingTurnId) return;
    if (!provider?.configured) {
      showToast({
        text: "模型尚未配置。请在设置中填写接口地址、模型和 API 密钥。",
      });
      return;
    }
    send(localDraft);
    draftsByCardId.current[currentCardId] = "";
    setLocalDraft("");
    setDraft("");
  };

  const tokens = built.estimatedTokens;
  const pct = Math.min(100, Math.round((tokens / 8_000) * 100));
  const answerModeLabel =
    built.answerMode === "sources-only" ? "仅依据材料" : "通用探索";
  const answerModeDetail =
    built.answerMode === "sources-only"
      ? "只依据上面明确列出的上下文；证据不足时会直接说明。"
      : "优先依据上面明确列出的上下文；材料不足时可补充通用知识，并会区分材料、通用知识和推断。";
  const toggleAnswerMode = () =>
    setCardAnswerMode(
      currentCardId,
      built.answerMode === "general" ? "sources-only" : "general",
    );

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
              onClick={() => setCtxOpen(false)}
            />
            <div
              className="ctx-panel"
              role="dialog"
              aria-label="本次上下文"
              aria-modal="false"
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
            placeholder="继续追问，或选中正文建立引用…"
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
            aria-label="提问输入框"
          />

          <div className="composer-control-row">
            <div className="composer-controls-left">
              <div className="composer-pop-anchor">
                <button
                  className="chip-btn model-chip"
                  onClick={() => setModelOpen((value) => !value)}
                  title="模型与连接状态"
                  aria-label={`模型与连接状态：CozAI · ${provider?.model ?? "Claude Opus 5"}`}
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
                      onClick={() => setModelOpen(false)}
                    />
                    <div
                      className="menu composer-menu"
                      style={{ bottom: 38, left: 0, minWidth: 250 }}
                    >
                      <div className="menu-note">
                        <b style={{ color: "var(--ink-2)" }}>
                          CozAI · {provider?.model ?? "claude-opus-5"}
                        </b>
                        <br />
                        {provider?.configured
                          ? "本机代理已配置，密钥不会进入浏览器。"
                          : (provider?.message ?? "尚未配置模型")}
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
                onClick={() => setCtxOpen((value) => !value)}
                title="查看本次提问会带入什么上下文"
                aria-label={`本次上下文，共 ${built.provenance.length} 项`}
              >
                <Layers size={13} />
                <span className="desktop-context-label">本次上下文</span>
                <span className="mobile-context-label">上下文</span>
                <span className="ctx-count">{built.provenance.length}</span>
              </button>

              <button
                className={`chip-btn answer-mode answer-mode-direct ${built.answerMode}`}
                onClick={toggleAnswerMode}
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
                  onClick={() => setMoreOpen((value) => !value)}
                  aria-label="更多输入设置"
                  title="更多输入设置"
                >
                  <MoreHorizontal size={16} />
                </button>
                {moreOpen && (
                  <>
                    <div
                      style={{ position: "fixed", inset: 0, zIndex: 55 }}
                      onClick={() => setMoreOpen(false)}
                    />
                    <div className="menu composer-menu" style={{ bottom: 38 }}>
                      <button
                        className="menu-item"
                        onClick={() => {
                          toggleAnswerMode();
                          setMoreOpen(false);
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
                  onClick={submit}
                  disabled={!localDraft.trim()}
                  title="发送（Enter）；换行请按 Shift+Enter"
                  aria-label="发送"
                >
                  <ArrowUp size={17} />
                </button>
              )}
            </div>
          </div>
        </div>
        <span className="sr-only" aria-live="polite">
          {streamingTurnId ? "正在生成回答，可随时停止" : ""}
        </span>
      </div>
    </div>
  );
}
