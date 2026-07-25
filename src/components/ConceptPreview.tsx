import { useEffect, useRef, useState } from "react";
import { GripHorizontal, Maximize2, Quote, X } from "lucide-react";
import { Markdown } from "../lib/markdown";
import { streamModel } from "../lib/provider";

export interface ConceptState {
  term: string;
  blockText: string;
  cardId: string;
  turnId?: string;
  sourceRevision: string;
  x: number;
  y: number;
}

interface Props {
  state: ConceptState;
  sourceTitle: string;
  cachedText?: string;
  onCache: (content: string) => void;
  onClose: () => void;
  onQuote: (text: string) => void;
  onPromote: (term: string, body: string) => void;
}

export function ConceptPreview({
  state,
  sourceTitle,
  cachedText,
  onCache,
  onClose,
  onQuote,
  onPromote,
}: Props) {
  const [pos, setPos] = useState({ x: state.x, y: state.y });
  const [text, setText] = useState("");
  const [status, setStatus] = useState<"streaming" | "done" | "error">(
    "streaming",
  );
  const [error, setError] = useState("");
  const drag = useRef<{ dx: number; dy: number } | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setPos({ x: state.x, y: state.y });
  }, [state.x, state.y]);

  useEffect(() => {
    const controller = new AbortController();
    setText(cachedText ?? "");
    setStatus(cachedText ? "done" : "streaming");
    setError("");
    if (cachedText) return () => controller.abort();
    void (async () => {
      let answer = "";
      try {
        const messages = [
          {
            role: "system" as const,
            content:
              "你是知识概念解释助手。用简洁 Markdown 解释指定概念，结合来源句；不输出隐藏推理。回答约 180–360 个中文字符。",
          },
          {
            role: "user" as const,
            content: `来源卡片：${sourceTitle}\n概念：${state.term}\n来源句：${state.blockText}\n\n请解释这个概念，并给出一个值得继续追问的方向。`,
          },
        ];
        for await (const event of streamModel({
          task: "concept-preview",
          messages,
          signal: controller.signal,
        })) {
          if (event.type !== "token") continue;
          answer += event.text;
          setText(answer);
        }
        if (!controller.signal.aborted) {
          onCache(answer);
          setStatus("done");
        }
      } catch (cause) {
        if (!controller.signal.aborted) {
          setStatus("error");
          setError(
            cause instanceof Error ? cause.message : "概念解释生成失败。",
          );
        }
      }
    })();
    return () => controller.abort();
  }, [
    cachedText,
    onCache,
    sourceTitle,
    state.blockText,
    state.cardId,
    state.term,
    state.turnId,
  ]);

  useEffect(() => {
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, state.cardId, state.term]);

  const onDown = (event: React.PointerEvent) => {
    if ((event.target as HTMLElement).closest("button")) return;
    drag.current = { dx: event.clientX - pos.x, dy: event.clientY - pos.y };
    (event.currentTarget as Element).setPointerCapture(event.pointerId);
  };
  const onMove = (event: React.PointerEvent) => {
    if (!drag.current) return;
    setPos({
      x: Math.max(
        8,
        Math.min(window.innerWidth - 200, event.clientX - drag.current.dx),
      ),
      y: Math.max(
        8,
        Math.min(window.innerHeight - 120, event.clientY - drag.current.dy),
      ),
    });
  };

  return (
    <div
      className="concept-pop"
      style={{ left: pos.x, top: pos.y }}
      role="dialog"
      aria-label={`概念解释：${state.term}`}
      aria-modal="false"
    >
      <div
        className="cp-head"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={() => {
          drag.current = null;
        }}
      >
        <GripHorizontal size={14} color="var(--ink-3)" />
        <div className="cp-title">{state.term}</div>
        <span
          style={{
            fontSize: 10.5,
            color: status === "error" ? "var(--danger)" : "var(--ink-3)",
            border: "1px solid var(--line)",
            borderRadius: 99,
            padding: "2px 7px",
          }}
        >
          {status === "done"
            ? "生成完成"
            : status === "error"
              ? "生成失败"
              : "生成中"}
        </span>
        <button
          className="icon-btn"
          onClick={onClose}
          aria-label="关闭概念预览"
          ref={closeRef}
        >
          <X size={15} />
        </button>
      </div>
      <div className="cp-body scroll-y md">
        {status === "error" ? (
          <p style={{ color: "var(--danger)" }}>{error}</p>
        ) : (
          <Markdown content={text} />
        )}
        {status === "streaming" && <span className="caret" />}
      </div>
      <div className="cp-source">
        来源句：
        {state.blockText
          .replace(/[#*`>]/g, "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 92)}
        …
      </div>
      <div className="cp-foot">
        <button
          className="chip-btn"
          disabled={!text.trim()}
          onClick={() => onQuote(`${state.term}：${text.slice(0, 180)}`)}
        >
          <Quote size={13} />
          引用
        </button>
        <button
          className="chip-btn"
          style={{ marginLeft: "auto" }}
          disabled={status !== "done" || !text.trim()}
          onClick={() => onPromote(state.term, text)}
          title={`把预览升级为正式卡片，来源保留为「${sourceTitle}」`}
        >
          <Maximize2 size={13} />
          展开为卡片
        </button>
      </div>
    </div>
  );
}
