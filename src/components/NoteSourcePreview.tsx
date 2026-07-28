import { useEffect, useRef, useState } from "react";
import { ExternalLink, FileText, LoaderCircle, X } from "lucide-react";
import { resolveProjectNoteCitation } from "../lib/notes/scoped";
import { Markdown } from "../lib/markdown";
import type { NoteCitation } from "../types";
import type {
  NoteCitationLookup,
  NoteCitationResolution,
} from "../lib/notes/types";

/**
 * UI-level resolver seam. A citation is resolved by its stable document
 * identity, not only its historical chunk id: re-indexing can legitimately
 * create new chunk ids. Keeping this injectable means a later host cache or
 * desktop resolver can be wired here without turning a temporary source card
 * into a Store concern.
 */
export type NoteCitationResolver = (input: {
  projectId: string;
  citation: NoteCitationLookup;
}) => Promise<NoteCitationResolution>;

const scopedNoteCitationResolver: NoteCitationResolver =
  resolveProjectNoteCitation;

/**
 * An in-memory source card.  It is intentionally not a Card/Turn: opening a
 * citation must not alter graph history, buildContext(), references, or the
 * indexed source library.  A missing or changed source still exposes the
 * frozen evidence snapshot that supported the original answer.
 */
export function NoteSourcePreview({
  citation,
  projectId,
  onClose,
  resolveCitation = scopedNoteCitationResolver,
}: {
  citation: NoteCitation;
  projectId: string;
  onClose: () => void;
  resolveCitation?: NoteCitationResolver;
}) {
  const isAttachment = citation.libraryId.startsWith("attachment:");
  const [content, setContent] = useState(citation.excerpt);
  const [state, setState] = useState<
    | "loading"
    | "current"
    | "updated"
    | "missing"
    | "library-unavailable"
    | "error"
  >("loading");
  const [reason, setReason] = useState("");
  const closeRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    restoreFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const frame = window.requestAnimationFrame(() => closeRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(frame);
      const restore = restoreFocusRef.current;
      if (restore?.isConnected) restore.focus();
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    setContent(citation.excerpt);
    setState("loading");
    setReason("");
    void resolveCitation({
      projectId,
      citation,
    })
      .then((resolution) => {
        if (cancelled) return;
        setState(resolution.state);
        setReason(resolution.reason ?? "");
        if (resolution.chunk) setContent(resolution.chunk.text);
      })
      .catch(() => {
        if (cancelled) return;
        setState("error");
        setReason("暂时无法验证当前资料；保留当时引用快照。");
      });
    return () => {
      cancelled = true;
    };
  }, [citation, projectId, resolveCitation]);

  const showsUpdatedSource = state === "updated";
  const sourceState =
    state === "loading"
      ? "正在验证来源…"
      : state === "current"
        ? "来源未变更"
        : state === "updated"
          ? "来源已更新；保留当时引用并展示当前版本"
          : state === "missing"
            ? reason ||
              (isAttachment
                ? "原来源已移除"
                : "原笔记已删除或不再位于该资料库。")
            : state === "library-unavailable"
              ? reason || "资料库当前不可用或未绑定到此项目。"
              : reason || "暂时无法验证当前资料。";

  return (
    <aside
      className="note-source-preview"
      role="dialog"
      aria-label={`笔记来源：${citation.title}`}
      aria-modal="false"
    >
      <div className="note-source-head">
        <FileText size={15} />
        <span className="temp-badge">
          {isAttachment ? "附件来源快照" : "临时来源卡"}
        </span>
        <b>{citation.title}</b>
        <button
          className="icon-btn"
          ref={closeRef}
          onClick={onClose}
          aria-label="关闭来源卡"
        >
          <X size={15} />
        </button>
      </div>
      <div className="note-source-meta">
        <ExternalLink size={12} /> {citation.relativePath}
        {state === "loading" && (
          <span>
            <LoaderCircle size={11} /> 正在验证来源…
          </span>
        )}
        {state === "current" && <span>来源未变更</span>}
        {state === "updated" && <span className="warn">来源已更新</span>}
        {state === "missing" && (
          <span className="warn">
            {isAttachment ? "原来源已移除" : "原笔记已删除"}
          </span>
        )}
        {state === "library-unavailable" && (
          <span className="warn">资料库当前不可用</span>
        )}
        {state === "error" && <span className="warn">暂时无法验证来源</span>}
      </div>
      <div className="note-source-discipline">
        不会进入主会话，不会自动成为引用
      </div>
      <div className="note-source-body scroll-y">
        {showsUpdatedSource ? (
          <>
            <section className="note-source-section frozen">
              <h4>当时引用</h4>
              <Markdown content={citation.excerpt} />
            </section>
            <section className="note-source-section">
              <h4>当前版本</h4>
              <Markdown content={content} />
            </section>
          </>
        ) : (
          <>
            {state !== "current" && state !== "loading" && (
              <p className="note-source-status">{sourceState}</p>
            )}
            <section className="note-source-section frozen">
              <h4>{state === "current" ? "来源片段" : "当时引用快照"}</h4>
              <Markdown content={content} />
            </section>
          </>
        )}
      </div>
    </aside>
  );
}
