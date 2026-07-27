import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowUp,
  GripHorizontal,
  Layers,
  Maximize2,
  Minimize2,
  Quote,
  X,
} from "lucide-react";
import { Markdown } from "../lib/markdown";
import { SENTINEL_INSTRUCTION, createAnswerGate } from "../lib/modelOutput";
import { streamModel } from "../lib/provider";
import type { SourceAnchor, Turn } from "../types";

export interface TempCard {
  id: string;
  term: string;
  anchor: SourceAnchor;
  pos: { x: number; y: number };
  z: number;
  minimized: boolean;
  createdAt: number;
}

export type TempReferenceIntent = "quote" | "background";

interface Props {
  card: TempCard;
  sourceTitle: string;
  cachedText?: string;
  mode: "window" | "sheet";
  hidden?: boolean;
  flash?: boolean;
  shake?: boolean;
  mobileTabs?: ReactNode;
  onCache: (content: string) => void;
  onFocus: () => void;
  onMove: (pos: TempCard["pos"]) => void;
  onMinimize: () => void;
  onClose: () => void;
  onReference: (intent: TempReferenceIntent, text: string) => void;
  onPromote: (term: string, seedTurns: Turn[]) => void;
}

function uid(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function composerHeight() {
  const value = getComputedStyle(document.documentElement).getPropertyValue(
    "--composer-live-height",
  );
  return Number.parseFloat(value) || 96;
}

function clampPosition(
  pos: TempCard["pos"],
  element?: HTMLElement | null,
): TempCard["pos"] {
  const width = element?.offsetWidth || 420;
  const height = element?.offsetHeight || 360;
  return {
    x: Math.max(8, Math.min(window.innerWidth - width - 8, pos.x)),
    y: Math.max(
      8,
      Math.min(window.innerHeight - composerHeight() - height - 8, pos.y),
    ),
  };
}

export function ConceptPreview({
  card,
  sourceTitle,
  cachedText,
  mode,
  hidden = false,
  flash = false,
  shake = false,
  mobileTabs,
  onCache,
  onFocus,
  onMove,
  onMinimize,
  onClose,
  onReference,
  onPromote,
}: Props) {
  const [text, setText] = useState(cachedText ?? "");
  const [status, setStatus] = useState<"streaming" | "done" | "error">(
    cachedText ? "done" : "streaming",
  );
  const [error, setError] = useState("");
  const [followups, setFollowups] = useState<Turn[]>([]);
  const [followupDraft, setFollowupDraft] = useState("");
  const [followupBusy, setFollowupBusy] = useState(false);
  const [followupError, setFollowupError] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{
    pointerX: number;
    pointerY: number;
    startX: number;
    startY: number;
  } | null>(null);
  const initialController = useRef<AbortController | null>(null);
  const followupController = useRef<AbortController | null>(null);
  const onCacheRef = useRef(onCache);

  useEffect(() => {
    onCacheRef.current = onCache;
  }, [onCache]);

  useEffect(() => {
    const controller = new AbortController();
    initialController.current = controller;
    setText(cachedText ?? "");
    setStatus(cachedText ? "done" : "streaming");
    setError("");
    if (cachedText) return () => controller.abort();

    void (async () => {
      const gate = createAnswerGate();
      try {
        const messages = [
          {
            role: "system" as const,
            content: `你是知识概念解释助手。用简洁 Markdown 解释指定概念，结合来源句。回答约 180–360 个中文字符。\n${SENTINEL_INSTRUCTION}`,
          },
          {
            role: "user" as const,
            content: `来源卡片：${sourceTitle}\n概念：${card.term}\n来源句：${card.anchor.blockText ?? ""}\n\n请解释这个概念，并给出一个值得继续追问的方向。`,
          },
        ];
        for await (const event of streamModel({
          task: "concept-preview",
          messages,
          signal: controller.signal,
        })) {
          if (event.type !== "token") continue;
          gate.push(event.text, event.channel);
          setText(gate.visible());
        }
        if (!controller.signal.aborted) {
          const final = gate.finish();
          setText(final);
          if (!final.trim()) {
            setStatus("error");
            setError("模型没有返回可显示的最终文本，请重试。");
            return;
          }
          onCacheRef.current(final);
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
    sourceTitle,
    card.anchor.blockText,
    card.anchor.cardId,
    card.anchor.turnId,
    card.term,
  ]);

  useEffect(
    () => () => {
      initialController.current?.abort();
      followupController.current?.abort();
    },
    [],
  );

  useEffect(() => {
    if (mode !== "window") return;
    const onResize = () => {
      const next = clampPosition(card.pos, rootRef.current);
      if (next.x !== card.pos.x || next.y !== card.pos.y) onMove(next);
    };
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [card.pos, mode, onMove]);

  const latestAnswer = useMemo(
    () =>
      [...followups]
        .reverse()
        .find((turn) => turn.role === "ai" && turn.content.trim())?.content ??
      text,
    [followups, text],
  );

  const promotableTurns = useMemo(() => {
    if (!text.trim()) return [];
    const turns: Turn[] = [
      {
        id: uid("temp-seed-user"),
        role: "user",
        content: `深挖概念：${card.term}`,
        createdAt: card.createdAt,
      },
      {
        id: uid("temp-seed-ai"),
        role: "ai",
        content: text,
        createdAt: card.createdAt + 1,
        status: "complete",
      },
    ];
    for (let index = 0; index < followups.length; index += 2) {
      const user = followups[index];
      const answer = followups[index + 1];
      if (
        user?.role === "user" &&
        answer?.role === "ai" &&
        answer.content.trim() &&
        answer.status !== "error"
      ) {
        turns.push(
          { ...user, streaming: false, status: "complete" },
          { ...answer, streaming: false, status: "complete", error: undefined },
        );
      }
    }
    return turns;
  }, [card.createdAt, card.term, followups, text]);

  const submitFollowup = async () => {
    const question = followupDraft.trim();
    if (!question || followupBusy || status !== "done") return;

    const userTurn: Turn = {
      id: uid("temp-user"),
      role: "user",
      content: question,
      createdAt: Date.now(),
      status: "complete",
    };
    const answerId = uid("temp-ai");
    const answerTurn: Turn = {
      id: answerId,
      role: "ai",
      content: "",
      createdAt: Date.now() + 1,
      streaming: true,
      status: "streaming",
    };
    const history = [...followups, userTurn];
    setFollowups([...history, answerTurn]);
    setFollowupDraft("");
    setFollowupBusy(true);
    setFollowupError("");

    const controller = new AbortController();
    followupController.current = controller;
    const gate = createAnswerGate();
    try {
      const messages = [
        {
          role: "system" as const,
          content: `你正在一张不会进入主会话的临时概念卡片里回答追问。只围绕概念与来源句继续解释，回答简洁。\n${SENTINEL_INSTRUCTION}`,
        },
        {
          role: "user" as const,
          content: `来源卡片：${sourceTitle}\n概念：${card.term}\n来源句：${card.anchor.blockText ?? ""}\n\n先前解释请求。`,
        },
        { role: "assistant" as const, content: text },
        ...history.map((turn) => ({
          role: turn.role === "ai" ? ("assistant" as const) : ("user" as const),
          content: turn.content,
        })),
      ];
      for await (const event of streamModel({
        task: "concept-preview",
        messages,
        signal: controller.signal,
      })) {
        if (event.type !== "token") continue;
        gate.push(event.text, event.channel);
        const visible = gate.visible();
        setFollowups((current) =>
          current.map((turn) =>
            turn.id === answerId ? { ...turn, content: visible } : turn,
          ),
        );
      }
      if (!controller.signal.aborted) {
        const final = gate.finish();
        setFollowups((current) =>
          current.map((turn) =>
            turn.id === answerId
              ? {
                  ...turn,
                  content: final,
                  streaming: false,
                  status: final.trim() ? "complete" : "error",
                  error: final.trim()
                    ? undefined
                    : "模型没有返回可显示的最终文本。",
                }
              : turn,
          ),
        );
        if (!final.trim()) setFollowupError("模型没有返回可显示的最终文本。");
      }
    } catch (cause) {
      if (!controller.signal.aborted) {
        const message =
          cause instanceof Error ? cause.message : "临时追问生成失败。";
        setFollowupError(message);
        setFollowups((current) =>
          current.map((turn) =>
            turn.id === answerId
              ? {
                  ...turn,
                  streaming: false,
                  status: "error",
                  error: message,
                }
              : turn,
          ),
        );
      }
    } finally {
      if (!controller.signal.aborted) setFollowupBusy(false);
    }
  };

  const onDown = (event: React.PointerEvent) => {
    onFocus();
    if (
      mode !== "window" ||
      (event.target as HTMLElement).closest("button, input, textarea")
    )
      return;
    drag.current = {
      pointerX: event.clientX,
      pointerY: event.clientY,
      startX: card.pos.x,
      startY: card.pos.y,
    };
    (event.currentTarget as Element).setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: React.PointerEvent) => {
    if (!drag.current) return;
    onMove(
      clampPosition(
        {
          x: drag.current.startX + event.clientX - drag.current.pointerX,
          y: drag.current.startY + event.clientY - drag.current.pointerY,
        },
        rootRef.current,
      ),
    );
  };

  return (
    <div
      ref={rootRef}
      className={`concept-pop temp-card ${mode === "sheet" ? "temp-sheet" : "temp-window"}${flash ? " temp-flash" : ""}${shake ? " temp-shake" : ""}`}
      style={{
        left: mode === "window" ? card.pos.x : undefined,
        top: mode === "window" ? card.pos.y : undefined,
        zIndex: card.z,
        display: hidden ? "none" : undefined,
      }}
      role="dialog"
      aria-label={`概念解释：${card.term}（临时卡片）`}
      aria-modal="false"
      onPointerDown={onFocus}
    >
      {mobileTabs}
      <div
        className="cp-head"
        onPointerDown={onDown}
        onPointerMove={onPointerMove}
        onPointerUp={() => {
          drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
      >
        <GripHorizontal size={14} color="var(--ink-3)" />
        <span className="temp-badge">临时</span>
        <div className="cp-title">{card.term}</div>
        <span className="temp-discipline">不会进入主会话</span>
        <span
          className={`temp-status ${status}`}
          aria-live="polite"
          aria-label={
            status === "done"
              ? "生成完成"
              : status === "error"
                ? "生成失败"
                : "生成中"
          }
        >
          {status === "done" ? "完成" : status === "error" ? "失败" : "生成中"}
        </span>
        <button
          className="icon-btn"
          onClick={onMinimize}
          aria-label={mode === "sheet" ? "收起临时卡片" : "最小化临时卡片"}
          title={mode === "sheet" ? "收起" : "最小化"}
        >
          <Minimize2 size={14} />
        </button>
        <button
          className="icon-btn"
          onClick={onClose}
          aria-label="关闭临时卡片"
          title="关闭"
        >
          <X size={15} />
        </button>
      </div>

      <div className="cp-body scroll-y">
        <div className="md">
          {status === "error" ? (
            <p style={{ color: "var(--danger)" }}>{error}</p>
          ) : (
            <Markdown content={text} />
          )}
          {status === "streaming" && <span className="caret" />}
        </div>
        {followups.length > 0 && (
          <div className="temp-thread" aria-label="临时追问记录">
            {followups.map((turn) =>
              turn.role === "user" ? (
                <div className="temp-question" key={turn.id}>
                  {turn.content}
                </div>
              ) : (
                <div className="temp-answer md" key={turn.id}>
                  {turn.status === "error" ? (
                    <span className="temp-error">{turn.error}</span>
                  ) : (
                    <Markdown content={turn.content} />
                  )}
                  {turn.streaming && <span className="caret" />}
                </div>
              ),
            )}
          </div>
        )}
      </div>

      <div className="cp-source">
        来源句：
        {(card.anchor.blockText ?? card.term)
          .replace(/[#*`>]/g, "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 92)}
        …
      </div>

      <form
        className="temp-followup"
        onSubmit={(event) => {
          event.preventDefault();
          void submitFollowup();
        }}
      >
        <input
          value={followupDraft}
          onChange={(event) => setFollowupDraft(event.target.value)}
          placeholder="继续追问这个概念…"
          aria-label={`追问概念：${card.term}`}
          disabled={status !== "done" || followupBusy}
        />
        <button
          className="icon-btn"
          type="submit"
          disabled={!followupDraft.trim() || followupBusy}
          aria-label="发送临时追问"
          title="只在这张临时卡片内追问"
        >
          <ArrowUp size={15} />
        </button>
      </form>
      {followupError && (
        <div className="temp-followup-error">{followupError}</div>
      )}

      <div className="cp-foot">
        <button
          className="chip-btn"
          disabled={!latestAnswer.trim()}
          onClick={() => onReference("quote", latestAnswer)}
        >
          <Quote size={13} />
          引用
        </button>
        <button
          className="chip-btn temp-bring"
          disabled={!latestAnswer.trim()}
          onClick={() =>
            onReference(
              "background",
              [
                text,
                ...followups
                  .filter((turn) => turn.role === "ai")
                  .map((t) => t.content),
              ]
                .filter(Boolean)
                .join("\n\n"),
            )
          }
        >
          <Layers size={13} />
          带入当前探索
        </button>
        <button
          className="chip-btn temp-promote"
          disabled={
            status !== "done" || followupBusy || promotableTurns.length < 2
          }
          onClick={() => onPromote(card.term, promotableTurns)}
          title={`把临时卡片升级为正式卡片，来源保留为「${sourceTitle}」`}
        >
          <Maximize2 size={13} />
          展开为卡片
        </button>
      </div>
    </div>
  );
}
