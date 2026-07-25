import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Menu, Sparkles, X } from "lucide-react";
import { useStore } from "./store";
import { ProjectSidebar } from "./components/ProjectSidebar";
import { CardStage } from "./components/CardStage";
import { GraphNavigator } from "./components/GraphNavigator";
import { Composer } from "./components/Composer";
import {
  ExportDialog,
  ImportDialog,
  SettingsDialog,
} from "./components/Dialogs";
import { EDGE_META } from "./types";
import { incomingEdge, layoutGraph, pathToRoot } from "./lib/graph";
import { scopeProject } from "./lib/projectScope";
import { proposalEvidenceLabel } from "./lib/attention";

export function App() {
  const {
    cards,
    edges,
    activeProjectId,
    currentCardId,
    setCurrentCard,
    collapsed,
    toast,
    dismissToast,
    activeProposals,
    morningPrompt,
    proposalTrayOpen,
    setProposalTrayOpen,
    dismissMorningPrompt,
    openProposal,
    dismissProposal,
  } = useStore();
  const [sbCollapsed, setSbCollapsed] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [modal, setModal] = useState<null | "import" | "export" | "settings">(
    null,
  );
  const workspaceRef = useRef<HTMLElement>(null);
  const drawerTriggerRef = useRef<HTMLButtonElement>(null);
  const drawerWasOpen = useRef(false);

  const projectGraph = useMemo(
    () => scopeProject(cards, edges, activeProjectId),
    [cards, edges, activeProjectId],
  );
  const projectCards = projectGraph.cards;
  const projectEdges = projectGraph.edges;
  const path = useMemo(
    () => pathToRoot(projectEdges, currentCardId),
    [projectEdges, currentCardId],
  );
  const { nodes, hidden } = useMemo(
    () => layoutGraph(projectCards, projectEdges, collapsed),
    [projectCards, projectEdges, collapsed],
  );

  const locate = (cardId: string, turnId?: string) => {
    setCurrentCard(cardId);
    if (turnId) {
      window.setTimeout(() => {
        const el = document.getElementById(`turn-${turnId}`);
        el?.scrollIntoView({ block: "center", behavior: "smooth" });
        el?.classList.add("flash");
        window.setTimeout(() => el?.classList.remove("flash"), 1800);
      }, 120);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setDrawer(false);
        setModal(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace) return;
    if (drawer) {
      workspace.setAttribute("inert", "");
      workspace.setAttribute("aria-hidden", "true");
      window.setTimeout(
        () =>
          document
            .querySelector<HTMLElement>('[aria-label="关闭抽屉"]')
            ?.focus(),
        0,
      );
    } else {
      workspace.removeAttribute("inert");
      workspace.removeAttribute("aria-hidden");
      if (drawerWasOpen.current) drawerTriggerRef.current?.focus();
    }
    drawerWasOpen.current = drawer;
  }, [drawer]);

  const orderedNodes = useMemo(
    () =>
      [...nodes.values()]
        .filter((n) => !hidden.has(n.id))
        .sort((a, b) => a.depth - b.depth || a.x - b.x)
        .map((n) => cards.find((c) => c.id === n.id)!)
        .filter(Boolean),
    [nodes, hidden, cards],
  );

  return (
    <div className="app">
      {drawer && (
        <div
          className="drawer-scrim"
          onClick={() => setDrawer(false)}
          aria-hidden="true"
        />
      )}
      <ProjectSidebar
        collapsed={sbCollapsed}
        onToggle={() => setSbCollapsed((v) => !v)}
        drawerOpen={drawer}
        onCloseDrawer={() => setDrawer(false)}
        onImport={() => setModal("import")}
        onExport={() => setModal("export")}
        onSettings={() => setModal("settings")}
      />

      <main className="workspace" ref={workspaceRef}>
        {/* 移动端顶部横向迷你关系导航 */}
        <div className="mini-nav">
          <button
            className="icon-btn"
            onClick={() => setDrawer(true)}
            aria-label="打开项目抽屉"
            ref={drawerTriggerRef}
          >
            <Menu size={17} />
          </button>
          <div className="mini-track">
            {orderedNodes.map((c) => {
              const e = incomingEdge(projectEdges, c.id);
              const cur = c.id === currentCardId;
              const color = e ? EDGE_META[e.type].color : "var(--ink)";
              return (
                <button
                  key={c.id}
                  className={`mini-node${cur ? " cur" : ""}`}
                  onClick={() => setCurrentCard(c.id)}
                  style={
                    path.includes(c.id) && !cur
                      ? { borderColor: color }
                      : undefined
                  }
                >
                  <span
                    className="mn-dot"
                    style={{
                      background: cur ? "#f6f1e9" : color,
                      opacity: c.unread ? 1 : 0.75,
                    }}
                  />
                  {c.title.length > 9 ? c.title.slice(0, 9) + "…" : c.title}
                </button>
              );
            })}
          </div>
          <button
            className={`icon-btn${activeProposals.length ? " active" : ""}`}
            onClick={() => setProposalTrayOpen(true)}
            aria-label={`查看幽灵分支，共 ${activeProposals.length} 条`}
            title="查看幽灵分支"
          >
            <Sparkles size={16} />
            {activeProposals.length > 0 && (
              <span className="proposal-count">{activeProposals.length}</span>
            )}
          </button>
        </div>

        <CardStage />
        <Composer onLocate={locate} />
      </main>

      <GraphNavigator />

      {proposalTrayOpen && (
        <div
          className="mobile-proposal-sheet"
          role="dialog"
          aria-label="幽灵分支"
        >
          <div className="mobile-proposal-sheet-head">
            <div>
              <b>幽灵分支</b>
              <span>点击后才会创建正式卡片</span>
            </div>
            <button
              className="icon-btn"
              onClick={() => setProposalTrayOpen(false)}
              aria-label="关闭幽灵分支"
            >
              <X size={16} />
            </button>
          </div>
          <div className="mobile-proposal-list scroll-y">
            {activeProposals.length === 0 ? (
              <p>当前没有可展开的幽灵分支。</p>
            ) : (
              activeProposals.map((proposal) => (
                <article className="proposal-item" key={proposal.id}>
                  <b>{proposal.title}</b>
                  <p>{proposal.explorationQuestion}</p>
                  <small>
                    {proposalEvidenceLabel(proposal.evidence)} ·{" "}
                    {proposal.reason}
                  </small>
                  <div className="proposal-actions">
                    <button
                      className="btn primary"
                      onClick={() => openProposal(proposal.id)}
                    >
                      开始探索
                    </button>
                    <button
                      className="btn"
                      onClick={() => dismissProposal(proposal.id)}
                    >
                      忽略
                    </button>
                  </div>
                </article>
              ))
            )}
          </div>
        </div>
      )}

      {modal === "import" && <ImportDialog onClose={() => setModal(null)} />}
      {modal === "export" && <ExportDialog onClose={() => setModal(null)} />}
      {modal === "settings" && (
        <SettingsDialog onClose={() => setModal(null)} />
      )}

      <AnimatePresence>
        {morningPrompt && (
          <motion.aside
            className="attention-prompt"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.22 }}
            aria-label="次日探索提示"
          >
            <Sparkles size={15} />
            <span>
              昨晚有 {morningPrompt.count} 个方向可能值得继续 · 先看一眼再决定
            </span>
            <button
              onClick={() => {
                setProposalTrayOpen(true);
                dismissMorningPrompt();
              }}
            >
              查看幽灵分支
            </button>
            <button onClick={dismissMorningPrompt}>今天忽略</button>
          </motion.aside>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {toast && (
          <motion.div
            className="toast"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.2, ease: [0.22, 0.8, 0.28, 1] }}
            role="status"
          >
            <span>{toast.text}</span>
            {toast.actionLabel && (
              <button onClick={toast.onAction}>{toast.actionLabel}</button>
            )}
            {!toast.actionLabel && (
              <button onClick={dismissToast} aria-label="关闭提示">
                知道了
              </button>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
