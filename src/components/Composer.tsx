import { useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  ChevronDown,
  Cpu,
  Layers,
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
    references,
    draft,
    setDraft,
    removeReference,
    clearReferences,
    send,
    stopStream,
    retryLast,
    streamingTurnId,
    contextForCurrent,
    provider,
    refreshProvider,
    showToast,
  } = useStore();
  const [modelOpen, setModelOpen] = useState(false);
  const [ctxOpen, setCtxOpen] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);
  const built = contextForCurrent();

  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
  }, [draft]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setCtxOpen(false);
      setModelOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const submit = () => {
    if (!draft.trim() || streamingTurnId) return;
    if (!provider?.configured) {
      showToast({
        text: "模型尚未配置。请在项目根目录填写 .env.local 后重启本地服务。",
      });
      return;
    }
    send(draft);
  };
  const tokens = built.estimatedTokens;
  const pct = Math.min(100, Math.round((tokens / 8_000) * 100));

  return (
    <div className="composer-wrap">
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

        <div className="composer-box">
          <div style={{ position: "relative", flexShrink: 0 }}>
            <button
              className="chip-btn"
              onClick={() => setModelOpen((value) => !value)}
              title="模型与连接状态"
            >
              <Cpu size={13} />
              <span className="desktop-model">
                CozAI · {provider?.model ?? "Claude Opus 5"}
              </span>
              <span className="mobile-model">Opus 5</span>
              <ChevronDown size={12} />
            </button>
            {modelOpen && (
              <>
                <div
                  style={{ position: "fixed", inset: 0, zIndex: 55 }}
                  onClick={() => setModelOpen(false)}
                />
                <div
                  className="menu"
                  style={{ bottom: 38, left: 0, minWidth: 250 }}
                >
                  <div className="menu-note">
                    <b style={{ color: "var(--ink-2)" }}>
                      CozAI · {provider?.model ?? "claude-opus-5"}
                    </b>
                    <br />
                    {provider?.configured
                      ? "本机代理已配置，密钥不会进入浏览器。"
                      : (provider?.message ?? "未配置 .env.local")}
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
          >
            <Layers size={13} />
            <span className="desktop-context-label">本次上下文</span>
            <span className="mobile-context-label">上下文</span>
            <span className="ctx-count">{built.provenance.length}</span>
          </button>
          <textarea
            ref={ta}
            rows={1}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="继续追问，或选中上面的文字建立精确引用…"
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
            aria-label="提问输入框"
          />
          <button
            className="icon-btn"
            title="附件导入尚未实现"
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
              onClick={stopStream}
              title="停止生成"
              aria-label="停止生成"
            >
              <Square size={13} fill="currentColor" />
            </button>
          ) : (
            <button
              className="send-btn"
              onClick={submit}
              disabled={!draft.trim()}
              title="发送"
              aria-label="发送"
            >
              <ArrowUp size={17} />
            </button>
          )}
        </div>
        <span className="sr-only" aria-live="polite">
          {streamingTurnId ? "正在生成回答，可随时停止" : ""}
        </span>
      </div>
    </div>
  );
}
