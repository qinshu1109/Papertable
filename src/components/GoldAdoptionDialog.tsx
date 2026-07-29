import { useEffect, useRef, useState } from "react";
import { Star, X } from "lucide-react";
import { useStore } from "../store";
import type { Card, Turn } from "../types";

export function GoldAdoptionDialog({
  card,
  turn,
  onClose,
}: {
  card: Card;
  turn: Turn;
  onClose: () => void;
}) {
  const { draftGold, confirmGold, showToast } = useStore();
  const [conclusion, setConclusion] = useState("");
  const [conceptHandle, setConceptHandle] = useState("");
  const [drafting, setDrafting] = useState(true);
  const [draftReady, setDraftReady] = useState(false);
  const [writing, setWriting] = useState(false);
  const [error, setError] = useState("");
  const request = useRef(0);

  const loadDraft = () => {
    const id = ++request.current;
    setDrafting(true);
    setDraftReady(false);
    setError("");
    void draftGold(card.id, turn.id).then(
      (value) => {
        if (request.current !== id) return;
        setConclusion(value);
        setDraftReady(true);
        setDrafting(false);
      },
      (caught) => {
        if (request.current !== id) return;
        setError(
          caught instanceof Error ? caught.message : "金子结论起草失败。",
        );
        setDrafting(false);
      },
    );
  };

  useEffect(() => {
    loadDraft();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !writing) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      request.current += 1;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  const submit = async () => {
    if (!draftReady || writing || !conclusion.trim() || !conceptHandle.trim())
      return;
    setWriting(true);
    setError("");
    try {
      await confirmGold(card.id, turn.id, conclusion, conceptHandle);
      showToast({
        text: turn.verdictId ? "采纳已新增修订版本。" : "本轮已采纳为金子。",
      });
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "写入失败，请重试。");
      setWriting(false);
    }
  };

  return (
    <div
      className="overlay"
      role="presentation"
      onClick={() => !writing && onClose()}
    >
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="gold-adoption-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <Star size={17} fill="currentColor" />
          <h3 id="gold-adoption-title">
            {turn.verdictId ? "修订本轮采纳" : "采纳本轮"}
          </h3>
          <button
            className="icon-btn"
            onClick={onClose}
            aria-label="取消采纳"
            disabled={writing}
          >
            <X size={16} />
          </button>
        </div>
        <div className="modal-body gold-adoption-fields">
          {drafting ? (
            <p aria-live="polite">正在从本轮回答起草一行结论…</p>
          ) : (
            <>
              <label>
                一行结论
                <input
                  value={conclusion}
                  onChange={(event) => setConclusion(event.target.value)}
                  maxLength={500}
                  disabled={!draftReady || writing}
                  aria-label="一行结论"
                />
              </label>
              <label>
                概念把手（必须由你填写）
                <input
                  value={conceptHandle}
                  onChange={(event) => setConceptHandle(event.target.value)}
                  maxLength={80}
                  disabled={!draftReady || writing}
                  autoFocus={draftReady}
                  aria-label="概念把手"
                  placeholder="例如：证据纪律"
                />
              </label>
            </>
          )}
          {error && (
            <p className="gold-adoption-error" role="alert">
              {error}
            </p>
          )}
        </div>
        <div className="modal-foot">
          {!draftReady && !drafting && (
            <button className="btn" onClick={loadDraft}>
              重试起草
            </button>
          )}
          <button className="btn" onClick={onClose} disabled={writing}>
            取消
          </button>
          <button
            className="btn primary"
            onClick={() => void submit()}
            disabled={
              !draftReady ||
              drafting ||
              writing ||
              !conclusion.trim() ||
              !conceptHandle.trim()
            }
          >
            {writing ? "正在写入…" : "确认采纳"}
          </button>
        </div>
      </div>
    </div>
  );
}
