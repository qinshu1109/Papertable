import { useEffect, useState } from "react";
import { ExternalLink, FileText, LoaderCircle, X } from "lucide-react";
import { readProjectNotes } from "../lib/notes/scoped";
import { Markdown } from "../lib/markdown";
import type { NoteCitation } from "../types";

/**
 * An in-memory source card.  It is intentionally not a Card/Turn: opening a
 * citation must not alter graph history, buildContext(), references, or the
 * indexed source library.  A missing or changed source still exposes the
 * frozen evidence snapshot that supported the original answer.
 */
export function NoteSourcePreview({
  citation,
  projectId,
  libraryIds,
  onClose,
}: {
  citation: NoteCitation;
  projectId: string;
  libraryIds: string[];
  onClose: () => void;
}) {
  const [content, setContent] = useState(citation.excerpt);
  const [state, setState] = useState<
    "loading" | "current" | "stale" | "missing"
  >("loading");

  useEffect(() => {
    const controller = new AbortController();
    void readProjectNotes({
      projectId,
      libraryIds,
      chunkIds: [citation.chunkId],
    })
      .then((chunks) => {
        if (controller.signal.aborted) return;
        const current = chunks[0];
        if (!current) {
          setState("missing");
          return;
        }
        setContent(current.text);
        setState(
          current.documentVersionHash === citation.documentHash
            ? "current"
            : "stale",
        );
      })
      .catch(() => !controller.signal.aborted && setState("missing"));
    return () => controller.abort();
  }, [citation, libraryIds, projectId]);

  return (
    <aside
      className="note-source-preview"
      role="dialog"
      aria-label={`笔记来源：${citation.title}`}
    >
      <div className="note-source-head">
        <FileText size={15} />
        <span className="temp-badge">临时来源卡</span>
        <b>{citation.title}</b>
        <button className="icon-btn" onClick={onClose} aria-label="关闭来源卡">
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
        {state === "stale" && (
          <span className="warn">来源已更新；下面是当前版本</span>
        )}
        {state === "missing" && (
          <span className="warn">原片段不可用；保留当时引用快照</span>
        )}
      </div>
      <div className="note-source-discipline">
        不会进入主会话，不会自动成为引用
      </div>
      <div className="note-source-body scroll-y">
        <Markdown content={content} />
      </div>
    </aside>
  );
}
