import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { AlertTriangle, Menu, Sparkles } from "lucide-react";
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
import type { VaultConflict } from "./types";
import { incomingEdge, layoutGraph, pathToRoot } from "./lib/graph";
import { scopeProject } from "./lib/projectScope";
import { ProposalExplorer } from "./components/ProposalExplorer";

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
    vaultConflicts,
    resolveVaultConflict,
    activeProposals,
    morningPrompt,
    proposalTrayOpen,
    setProposalTrayOpen,
    dismissMorningPrompt,
    hydrated,
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
      // Opening a modal from the drawer closes the drawer in the same render.
      // Let the dialog keep focus instead of pulling it back to the menu button.
      if (drawerWasOpen.current && modal === null) {
        drawerTriggerRef.current?.focus();
      }
    }
    drawerWasOpen.current = drawer;
  }, [drawer, modal]);

  const openModal = (next: "import" | "export" | "settings") => {
    // A modal is a new foreground layer. Keeping the mobile drawer beneath it
    // leaves an off-canvas, focusable action surface behind the dialog.
    setDrawer(false);
    setModal(next);
  };

  const orderedNodes = useMemo(
    () =>
      [...nodes.values()]
        .filter((n) => !hidden.has(n.id))
        .sort((a, b) => a.depth - b.depth || a.x - b.x)
        .map((n) => cards.find((c) => c.id === n.id)!)
        .filter(Boolean),
    [nodes, hidden, cards],
  );

  // `seed` 只是第一帧的安全占位，不是可操作的工作区。若在 IndexedDB 恢复前
  // 允许新建项目，后到的水合快照会覆盖这次内存操作，用户刷新后就像「项目丢了」。
  // 把整个工作台延后到恢复完成再开放，既避免竞争，也让「本地恢复中」有明确反馈。
  if (!hydrated) {
    return (
      <main className="workspace-bootstrap" role="status" aria-live="polite">
        <strong>正在恢复本地工作区…</strong>
        <span>不会覆盖已有项目</span>
      </main>
    );
  }

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
        onImport={() => openModal("import")}
        onExport={() => openModal("export")}
        onSettings={() => openModal("settings")}
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
          <ProposalExplorer mobile onClose={() => setProposalTrayOpen(false)} />
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

      {/*
        冲突横幅是常驻的，不是 toast：它需要用户做一次二选一，在此之前那张卡片的
        同步一直挂起。用会自动消失的提示来承载一个待决决定，等于把它丢掉。
      */}
      {vaultConflicts.length > 0 && (
        <aside className="vault-conflicts" aria-label="知识库同步冲突">
          <div className="vault-conflict-head">
            <AlertTriangle size={15} color="var(--danger)" />
            <strong>
              有 {vaultConflicts.length} 篇笔记你在 Obsidian 里改过
            </strong>
          </div>
          <p>
            Papertable 没有覆盖它们，新内容另存为{" "}
            <code>.papertable-conflict.md</code>
            。这些卡片的同步已暂停。
          </p>
          {vaultConflicts.map((conflict: VaultConflict) => (
            <div className="vault-conflict-row" key={conflict.cardId}>
              <code>{conflict.path}</code>
              <button
                className="chip-btn"
                onClick={() =>
                  void resolveVaultConflict(conflict.cardId, "papertable")
                }
                title="下次同步用 Papertable 的内容覆盖那篇笔记"
              >
                以 Papertable 为准
              </button>
              <button
                className="chip-btn"
                onClick={() =>
                  void resolveVaultConflict(conflict.cardId, "note")
                }
                title="保留你的笔记，这张卡片此后不再同步"
              >
                保留笔记
              </button>
            </div>
          ))}
        </aside>
      )}

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
