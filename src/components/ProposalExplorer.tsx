import { ArrowLeft, Sparkles, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { proposalEvidenceLabel } from "../lib/attention";
import { useStore } from "../store";
import { EDGE_META } from "../types";
import type { Proposal } from "../types";

export function ProposalExplorer({
  mobile = false,
  onClose,
}: {
  mobile?: boolean;
  onClose: () => void;
}) {
  const {
    activeProjectId,
    cards,
    proposals,
    activeProposals,
    selectedProposalId,
    previewProposal,
    materializeProposal,
    clearProposalPreview,
    dismissProposal,
  } = useStore();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [startingId, setStartingId] = useState<string | null>(null);
  const cooled = useMemo(
    () =>
      proposals
        .filter(
          (proposal) =>
            proposal.projectId === activeProjectId &&
            proposal.status === "cooled",
        )
        .sort((a, b) => b.signalScore - a.signalScore),
    [activeProjectId, proposals],
  );
  const selected = activeProposals.find(
    (proposal) => proposal.id === selectedProposalId,
  );

  useEffect(() => {
    if (!selected || drafts[selected.id] !== undefined) return;
    setDrafts((current) => ({
      ...current,
      [selected.id]: selected.explorationQuestion,
    }));
  }, [drafts, selected]);

  const headingClass = mobile
    ? "mobile-proposal-sheet-head"
    : "proposal-panel-head";
  const listClass = mobile
    ? "mobile-proposal-list scroll-y"
    : "proposal-list scroll-y";
  const close = () => {
    clearProposalPreview();
    onClose();
  };

  return (
    <>
      <div className={headingClass}>
        <div className="proposal-heading-copy">
          {selected && (
            <button
              className="icon-btn proposal-back"
              onClick={clearProposalPreview}
              aria-label="返回幽灵分支列表"
              title="返回列表"
            >
              <ArrowLeft size={14} />
            </button>
          )}
          <div>
            <b>{selected ? "提案详情" : "幽灵分支"}</b>
            <span>
              {selected
                ? "编辑问题后，明确确认才会创建正式卡片。"
                : "先看方向，明确开始后才创建正式卡片。"}
            </span>
          </div>
        </div>
        <button className="icon-btn" onClick={close} aria-label="关闭幽灵分支">
          <X size={14} />
        </button>
      </div>

      <div className={listClass}>
        {selected ? (
          <ProposalDetail
            proposal={selected}
            sourceTitle={
              cards.find((card) => card.id === selected.suggestedParentCardId)
                ?.title
            }
            question={drafts[selected.id] ?? selected.explorationQuestion}
            starting={startingId === selected.id}
            onQuestionChange={(question) =>
              setDrafts((current) => ({ ...current, [selected.id]: question }))
            }
            onStart={() => {
              setStartingId(selected.id);
              const cardId = materializeProposal(
                selected.id,
                drafts[selected.id] ?? selected.explorationQuestion,
              );
              if (!cardId) setStartingId(null);
            }}
            onDismiss={() => dismissProposal(selected.id)}
          />
        ) : (
          <>
            {activeProposals.length === 0 && cooled.length === 0 && (
              <p className="proposal-empty">
                当前没有提案。系统只会在次日根据你的真实行为提出方向。
              </p>
            )}
            {activeProposals.map((proposal) => (
              <ProposalItem
                key={proposal.id}
                proposal={proposal}
                onPreview={() => previewProposal(proposal.id)}
                onDismiss={() => dismissProposal(proposal.id)}
              />
            ))}
            {cooled.length > 0 && (
              <>
                <div className="cooled-heading">冷却中 · 不再提醒</div>
                {cooled.map((proposal) => (
                  <div className="proposal-item cooled" key={proposal.id}>
                    <b>{proposal.title}</b>
                    <p>{proposal.explorationQuestion}</p>
                    <small>{proposalEvidenceLabel(proposal.evidence)}</small>
                  </div>
                ))}
              </>
            )}
          </>
        )}
      </div>
    </>
  );
}

function ProposalItem({
  proposal,
  onPreview,
  onDismiss,
}: {
  proposal: Proposal;
  onPreview: () => void;
  onDismiss: () => void;
}) {
  return (
    <article className="proposal-item">
      <div className="proposal-item-top">
        <b>{proposal.title}</b>
        <span className={`proposal-evidence ${proposal.evidence}`}>
          {proposalEvidenceLabel(proposal.evidence)}
        </span>
      </div>
      <p>{proposal.explorationQuestion}</p>
      <small>
        {proposal.reason} · {EDGE_META[proposal.suggestedRelation].label}方向
      </small>
      <div className="proposal-actions">
        <button
          className="btn primary"
          onClick={onPreview}
          aria-label={`查看提案：${proposal.title}`}
        >
          查看
        </button>
        <button className="btn" onClick={onDismiss}>
          忽略
        </button>
      </div>
    </article>
  );
}

function ProposalDetail({
  proposal,
  sourceTitle,
  question,
  starting,
  onQuestionChange,
  onStart,
  onDismiss,
}: {
  proposal: Proposal;
  sourceTitle?: string;
  question: string;
  starting: boolean;
  onQuestionChange: (question: string) => void;
  onStart: () => void;
  onDismiss: () => void;
}) {
  const sourceAvailable = Boolean(sourceTitle);
  return (
    <article className="proposal-detail" aria-label="提案详情">
      <div className="proposal-item-top">
        <b>{proposal.title}</b>
        <span className={`proposal-evidence ${proposal.evidence}`}>
          {proposalEvidenceLabel(proposal.evidence)}
        </span>
      </div>
      <dl className="proposal-facts">
        <div>
          <dt>来源卡片</dt>
          <dd>{sourceTitle ? `《${sourceTitle}》` : "来源卡片已不存在"}</dd>
        </div>
        <div>
          <dt>推荐关系</dt>
          <dd>{EDGE_META[proposal.suggestedRelation].label}</dd>
        </div>
        <div>
          <dt>行为信号</dt>
          <dd>{proposal.reason}</dd>
        </div>
      </dl>
      {proposal.evidence === "ai-wildcard" && (
        <p className="proposal-note">
          <Sparkles size={12} />
          复用已提取概念，未为本提案新增模型调用。
        </p>
      )}
      <label className="proposal-question">
        <span>探索问题</span>
        <textarea
          value={question}
          onChange={(event) => onQuestionChange(event.target.value)}
          rows={4}
          aria-label="探索问题"
        />
      </label>
      {!sourceAvailable && (
        <p className="proposal-source-missing">来源已不可用，不能开始探索。</p>
      )}
      <div className="proposal-actions">
        <button
          className="btn primary"
          disabled={!sourceAvailable || !question.trim() || starting}
          onClick={onStart}
        >
          {starting ? "正在开始…" : "开始探索"}
        </button>
        <button className="btn" onClick={onDismiss} disabled={starting}>
          忽略
        </button>
      </div>
    </article>
  );
}
