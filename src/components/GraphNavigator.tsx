import { useEffect, useMemo, useRef, useState } from "react";
import { Crosshair, Minus, Plus } from "lucide-react";
import { useStore } from "../store";
import { EDGE_META } from "../types";
import {
  incomingEdge,
  layoutGraph,
  outgoingEdges,
  pathToRoot,
} from "../lib/graph";
import { scopeProject } from "../lib/projectScope";

const COLORS: Record<string, string> = {
  child: "#b9471e",
  divergent: "#526e59",
  branch: "#58627d",
};

export function GraphNavigator() {
  const {
    cards,
    edges,
    activeProjectId,
    currentCardId,
    setCurrentCard,
    collapsed,
    toggleCollapse,
  } = useStore();
  const wrapRef = useRef<HTMLDivElement>(null);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [hover, setHover] = useState<{
    id: string;
    x: number;
    y: number;
  } | null>(null);
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(
    null,
  );

  const projectGraph = useMemo(
    () => scopeProject(cards, edges, activeProjectId),
    [cards, edges, activeProjectId],
  );
  const projectCards = projectGraph.cards;
  const projectEdges = projectGraph.edges;
  const { nodes, height, hidden } = useMemo(
    () => layoutGraph(projectCards, projectEdges, collapsed),
    [projectCards, projectEdges, collapsed],
  );
  const path = useMemo(
    () => pathToRoot(projectEdges, currentCardId),
    [projectEdges, currentCardId],
  );
  const pathSet = useMemo(() => new Set(path), [path]);

  const recenter = () => {
    const n = nodes.get(currentCardId);
    const box = wrapRef.current?.getBoundingClientRect();
    if (!n || !box) return;
    setZoom(1);
    setPan({ x: -n.x, y: box.height / 2 - 40 - n.y });
  };

  useEffect(() => {
    const n = nodes.get(currentCardId);
    const box = wrapRef.current?.getBoundingClientRect();
    if (!n || !box) return;
    setPan((p) => {
      const screenY = n.y + p.y;
      if (screenY > 34 && screenY < box.height - 34) return p;
      return { x: p.x, y: box.height / 2 - 40 - n.y };
    });
  }, [currentCardId, height]);

  useEffect(() => {
    const box = wrapRef.current?.getBoundingClientRect();
    if (box) setPan({ x: 0, y: Math.max(46, (box.height - height) / 2) });
  }, []);

  const onDown = (e: React.PointerEvent) => {
    drag.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    setPan({
      x: drag.current.px + (e.clientX - drag.current.x),
      y: drag.current.py + (e.clientY - drag.current.y),
    });
  };
  const onUp = () => {
    drag.current = null;
  };

  const cardTitle = (id: string) =>
    projectCards.find((card) => card.id === id)?.title ?? "";
  const relLabel = (id: string) => {
    const e = incomingEdge(projectEdges, id);
    return e ? EDGE_META[e.type].label : "根卡片";
  };

  const showTooltip = (id: string, x: number, y: number) => {
    const box = wrapRef.current?.getBoundingClientRect();
    if (!box) return;
    setHover({
      id,
      x: Math.max(8, Math.min(x, box.width - 142)),
      y: Math.max(8, Math.min(y, box.height - 52)),
    });
  };

  const onNodeKeyDown = (
    event: React.KeyboardEvent<SVGGElement>,
    id: string,
  ) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setCurrentCard(id);
    }
  };

  return (
    <nav className="graph" aria-label="关系导航器">
      <div className="graph-head">
        <span className="graph-title">关系图</span>
        <div style={{ display: "flex", gap: 1 }}>
          <button
            className="icon-btn"
            onClick={() => setZoom((z) => Math.max(0.6, z - 0.15))}
            title="缩小"
          >
            <Minus size={14} />
          </button>
          <button
            className="icon-btn"
            onClick={() => setZoom((z) => Math.min(1.6, z + 0.15))}
            title="放大"
          >
            <Plus size={14} />
          </button>
          <button className="icon-btn" onClick={recenter} title="回到当前节点">
            <Crosshair size={14} />
          </button>
        </div>
      </div>

      <div
        className="graph-canvas"
        ref={wrapRef}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerLeave={() => {
          onUp();
          setHover(null);
        }}
      >
        <svg width="100%" height="100%" style={{ display: "block" }}>
          <g
            transform={`translate(${107 + pan.x * zoom} ${pan.y * zoom}) scale(${zoom})`}
          >
            {projectEdges
              .filter(
                (e) =>
                  nodes.has(e.sourceCardId) &&
                  nodes.has(e.targetCardId) &&
                  !hidden.has(e.targetCardId),
              )
              .map((e) => {
                const a = nodes.get(e.sourceCardId)!;
                const b = nodes.get(e.targetCardId)!;
                const onPath =
                  pathSet.has(e.sourceCardId) && pathSet.has(e.targetCardId);
                const mid = (a.y + b.y) / 2;
                return (
                  <path
                    key={e.id}
                    d={`M ${a.x} ${a.y} C ${a.x} ${mid}, ${b.x} ${mid}, ${b.x} ${b.y}`}
                    fill="none"
                    stroke={COLORS[e.type]}
                    strokeWidth={onPath ? 1.9 : 1.2}
                    strokeOpacity={onPath ? 0.85 : 0.32}
                    strokeDasharray={
                      e.type === "branch"
                        ? "4 3"
                        : e.type === "divergent"
                          ? "1 4"
                          : undefined
                    }
                    strokeLinecap="round"
                  />
                );
              })}

            {[...nodes.values()]
              .filter((n) => !hidden.has(n.id))
              .map((n) => {
                const card = projectCards.find(
                  (candidate) => candidate.id === n.id,
                )!;
                if (!card || card.trashed) return null;
                const isCur = n.id === currentCardId;
                const onPath = pathSet.has(n.id);
                const inEdge = incomingEdge(projectEdges, n.id);
                const color = inEdge ? COLORS[inEdge.type] : "#342b26";
                const kids = outgoingEdges(projectEdges, n.id).length > 0;
                return (
                  <g key={n.id}>
                    <g
                      className="gnode-hit"
                      role="button"
                      tabIndex={0}
                      aria-label={`打开${card.title}，${relLabel(n.id)}`}
                      aria-current={isCur ? "page" : undefined}
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={() => setCurrentCard(n.id)}
                      onKeyDown={(event) => onNodeKeyDown(event, n.id)}
                      onPointerEnter={(event) => {
                        const box = wrapRef.current?.getBoundingClientRect();
                        if (box)
                          showTooltip(
                            n.id,
                            event.clientX - box.left + 12,
                            event.clientY - box.top + 14,
                          );
                      }}
                      onPointerLeave={() => setHover(null)}
                      onFocus={() => showTooltip(n.id, 18, n.y + pan.y + 18)}
                      onBlur={() => setHover(null)}
                    >
                      <circle
                        cx={n.x}
                        cy={n.y}
                        r={16}
                        fill="transparent"
                        pointerEvents="all"
                      />
                      {isCur && (
                        <circle
                          cx={n.x}
                          cy={n.y}
                          r={11.5}
                          fill="none"
                          stroke={color}
                          strokeOpacity={0.3}
                          strokeWidth={1.2}
                        />
                      )}
                      <circle
                        cx={n.x}
                        cy={n.y}
                        r={isCur ? 7 : onPath ? 5.4 : 4.4}
                        fill={isCur ? "#342b26" : onPath ? color : "#fbf8f2"}
                        stroke={color}
                        strokeWidth={1.6}
                        strokeOpacity={isCur ? 1 : onPath ? 1 : 0.5}
                        pointerEvents="none"
                      />
                      {card.unread && !isCur && (
                        <circle
                          cx={n.x + 6.5}
                          cy={n.y - 6.5}
                          r={2.6}
                          fill="var(--accent)"
                          pointerEvents="none"
                        />
                      )}
                    </g>
                    {kids && (
                      <g
                        className="gnode-collapse"
                        role="button"
                        tabIndex={0}
                        aria-label={`${collapsed.has(n.id) ? "展开" : "折叠"}${card.title}的下级卡片`}
                        aria-expanded={!collapsed.has(n.id)}
                        onClick={(ev) => {
                          ev.stopPropagation();
                          toggleCollapse(n.id);
                        }}
                        onPointerDown={(event) => event.stopPropagation()}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            toggleCollapse(n.id);
                          }
                        }}
                        style={{ cursor: "pointer" }}
                      >
                        <circle
                          cx={n.x + 12}
                          cy={n.y + 10}
                          r={6}
                          fill="#fbf8f2"
                          stroke="var(--line)"
                          strokeWidth={1}
                        />
                        <path
                          d={
                            collapsed.has(n.id)
                              ? `M ${n.x + 9.4} ${n.y + 10} h 5.2 M ${n.x + 12} ${n.y + 7.4} v 5.2`
                              : `M ${n.x + 9.4} ${n.y + 10} h 5.2`
                          }
                          stroke="var(--ink-2)"
                          strokeWidth={1.3}
                          strokeLinecap="round"
                        />
                      </g>
                    )}
                  </g>
                );
              })}
          </g>
        </svg>

        {hover && (
          <div
            className="graph-tip"
            style={{ left: hover.x, top: hover.y }}
            role="tooltip"
          >
            <b>{cardTitle(hover.id)}</b>
            <i>{relLabel(hover.id)}</i>
          </div>
        )}
      </div>

      <div className="graph-legend">
        {(["child", "divergent", "branch"] as const).map((t) => (
          <div className="legend-row" key={t}>
            <span
              className="legend-dash"
              style={{
                background:
                  t === "child"
                    ? COLORS.child
                    : `repeating-linear-gradient(90deg, ${COLORS[t]} 0 ${t === "branch" ? 4 : 1.5}px, transparent ${t === "branch" ? 4 : 1.5}px ${t === "branch" ? 7 : 4}px)`,
              }}
            />
            {EDGE_META[t].label}
            <span style={{ color: "var(--ink-3)", fontSize: 10.5 }}>
              {t === "child"
                ? "继承主题与片段"
                : t === "divergent"
                  ? "仅相关主题"
                  : "继承到分支点"}
            </span>
          </div>
        ))}
      </div>
    </nav>
  );
}
