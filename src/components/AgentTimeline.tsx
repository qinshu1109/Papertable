import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  GitBranchPlus,
  ShieldCheck,
} from "lucide-react";
import { loadAgentAudit } from "../lib/storage";
import {
  projectAgentTimeline,
  trajectoryPromotionDraft,
  type AgentTimelineNode,
  type TrajectoryPromotionDraft,
} from "../lib/agentTimeline";
import type { AgentAudit } from "../lib/agentEvents";

export function AgentTimeline({
  turnId,
  streaming,
  onPromote,
}: {
  turnId: string;
  streaming: boolean;
  onPromote: (node: AgentTimelineNode, draft: TrajectoryPromotionDraft) => void;
}) {
  const [audit, setAudit] = useState<AgentAudit | null>(null);
  const [open, setOpen] = useState(true);
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(
    () => new Set(),
  );
  const mounted = useRef(true);
  const cursor = useRef({ sequence: -1, updatedAt: -1, kind: "" });

  const refresh = useCallback(async () => {
    const next = await loadAgentAudit(turnId);
    if (!mounted.current) return;
    const nextCursor =
      next?.kind === "event-sourced"
        ? {
            sequence: next.run.lastSequence,
            updatedAt: next.run.updatedAt,
            kind: next.kind,
          }
        : {
            sequence: 0,
            updatedAt: 0,
            kind: next?.kind ?? "missing",
          };
    if (
      nextCursor.sequence < cursor.current.sequence ||
      (nextCursor.sequence === cursor.current.sequence &&
        nextCursor.updatedAt === cursor.current.updatedAt &&
        nextCursor.kind === cursor.current.kind)
    )
      return;
    cursor.current = nextCursor;
    setAudit(next);
  }, [turnId]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const delayed = [180, 620].map((delay) =>
      window.setTimeout(() => void refresh(), delay),
    );
    const interval = streaming
      ? window.setInterval(() => void refresh(), 140)
      : undefined;
    return () => {
      mounted.current = false;
      delayed.forEach((id) => window.clearTimeout(id));
      if (interval !== undefined) window.clearInterval(interval);
    };
  }, [refresh, streaming]);

  const projection = useMemo(() => projectAgentTimeline(audit), [audit]);
  if (!projection.presentation || !projection.nodes.length) return null;
  const { presentation, nodes } = projection;
  const runId = audit?.kind === "event-sourced" ? audit.run.id : "";
  const tone =
    presentation.state === "running"
      ? "running"
      : presentation.state === "interrupted"
        ? "interrupted"
        : (presentation.terminal?.result ?? "completed");

  return (
    <section
      className="agent-presentation"
      data-testid={`agent-presentation-${turnId}`}
      aria-label="Agent 探索过程"
    >
      <div className={`agent-terminal-banner ${tone}`}>
        <div className="agent-terminal-axis">
          <span>结果</span>
          <b>{presentation.resultLabel}</b>
        </div>
        <div className="agent-terminal-axis">
          <span>原因</span>
          <b>{presentation.reasonLabel}</b>
        </div>
        <p>{presentation.message}</p>
        <div className="agent-terminal-flags" aria-label="运行特征">
          {presentation.truncated && <span>过程已截断</span>}
          {presentation.protocolRepairCount > 0 && (
            <span>协议修复 {presentation.protocolRepairCount} 次</span>
          )}
          {presentation.retryCount > 0 && (
            <span>重试 {presentation.retryCount} 次</span>
          )}
        </div>
      </div>

      {presentation.budget.length > 0 && (
        <div
          className="agent-budget-grid"
          data-testid={`agent-budget-${turnId}`}
          aria-label="本轮预算状态"
        >
          <span className="agent-budget-heading">预算</span>
          <span>上限</span>
          <span>已用</span>
          <span>剩余</span>
          {presentation.budget.map((row) => (
            <div className="agent-budget-row" key={row.dimension}>
              <b>{row.label}</b>
              <span>{row.limit}</span>
              <span>{row.used}</span>
              <span>{row.remaining}</span>
            </div>
          ))}
        </div>
      )}

      <div className="agent-timeline-head">
        <button
          type="button"
          className="agent-timeline-toggle"
          onClick={() => setOpen((current) => !current)}
          aria-expanded={open}
        >
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          探索时间线 · {nodes.length} 个持久化步骤
        </button>
        <span>
          <ShieldCheck size={12} />
          轨迹不具引用资格
        </span>
      </div>

      {open && (
        <ol className="agent-timeline-list">
          {nodes.map((node) => {
            const expanded = expandedNodes.has(node.id);
            return (
              <li
                className={`agent-timeline-node ${node.kind}`}
                key={node.id}
                data-testid={`agent-event-${node.sequence}`}
              >
                <span className="agent-timeline-marker" aria-hidden="true" />
                <div className="agent-timeline-node-main">
                  <div className="agent-timeline-node-row">
                    <button
                      type="button"
                      className="agent-timeline-node-toggle"
                      onClick={() =>
                        setExpandedNodes((current) => {
                          const next = new Set(current);
                          if (next.has(node.id)) next.delete(node.id);
                          else next.add(node.id);
                          return next;
                        })
                      }
                      aria-expanded={expanded}
                    >
                      {expanded ? (
                        <ChevronDown size={13} />
                      ) : (
                        <ChevronRight size={13} />
                      )}
                      <span>
                        <b>{node.title}</b>
                        <small>{node.summary}</small>
                      </span>
                    </button>
                    <button
                      type="button"
                      className="agent-timeline-promote"
                      onClick={() =>
                        onPromote(node, trajectoryPromotionDraft(runId, node))
                      }
                      title="通过现有继承关系创建真实卡片；不会复制来源或授予引用资格"
                    >
                      <GitBranchPlus size={12} />
                      提升为卡片
                    </button>
                  </div>
                  {expanded && (
                    <div className="agent-timeline-detail">
                      {node.repairMode && (
                        <span
                          className={`agent-repair-mode ${node.repairMode}`}
                        >
                          {node.repairMode === "deterministic"
                            ? "确定性动作"
                            : "非确定性：模型重发"}
                        </span>
                      )}
                      {node.details.map((detail) => (
                        <p key={detail}>{detail}</p>
                      ))}
                      {node.sources.length > 0 && (
                        <div
                          className="agent-read-sources"
                          aria-label="已读取来源详情"
                        >
                          {node.sources.map((source) => (
                            <article key={source.key}>
                              <b>{source.title}</b>
                              <span>{source.relativePath}</span>
                              <p>{source.excerpt}</p>
                            </article>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
