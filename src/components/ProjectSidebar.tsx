import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  ChevronsLeft,
  ChevronsRight,
  Download,
  Edit3,
  FolderPlus,
  LoaderCircle,
  MoreHorizontal,
  Pin,
  Search,
  Settings,
  Star,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useStore } from "../store";
import { normalizeProjectName, PROJECT_NAME_LIMIT } from "../lib/desktopUi";
import { Logo } from "./Logo";

interface Props {
  collapsed: boolean;
  onToggle: () => void;
  drawerOpen: boolean;
  onCloseDrawer: () => void;
  onImport: () => void;
  onExport: () => void;
  onSettings: () => void;
}

export function ProjectSidebar({
  collapsed,
  onToggle,
  drawerOpen,
  onCloseDrawer,
  onImport,
  onExport,
  onSettings,
}: Props) {
  const {
    projects,
    cards,
    activeProjectId,
    streamingCardIds,
    setActiveProject,
    renameProject,
    togglePinProject,
    createProject,
    deleteProject,
  } = useStore();
  const [query, setQuery] = useState("");
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [nameDialog, setNameDialog] = useState<{
    mode: "create" | "rename";
    projectId?: string;
    value: string;
  } | null>(null);
  const desktopBuild = __PAPERTABLE_TARGET__ === "desktop";

  useEffect(() => {
    const closeMenu = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenuFor(null);
        setNameDialog(null);
      }
    };
    window.addEventListener("keydown", closeMenu);
    return () => window.removeEventListener("keydown", closeMenu);
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? projects.filter((p) => p.name.toLowerCase().includes(q))
      : projects;
    return [...list].sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt,
    );
  }, [projects, query]);

  const rail = collapsed && !drawerOpen;
  const generatingProjectIds = useMemo(
    () =>
      new Set(
        cards
          .filter((card) => streamingCardIds.has(card.id))
          .map((card) => card.projectId),
      ),
    [cards, streamingCardIds],
  );

  return (
    <aside
      className={`sidebar${collapsed ? " collapsed" : ""}${drawerOpen ? " drawer-open" : ""}`}
      aria-label="项目栏"
      role={drawerOpen ? "dialog" : undefined}
      aria-modal={drawerOpen || undefined}
    >
      <div className="sb-head">
        {!rail && (
          <div className="brand">
            <Logo />
            <div style={{ minWidth: 0 }}>
              <div className="brand-name">纸桌 Papertable</div>
              <div className="brand-sub">本地图结构知识探索</div>
            </div>
          </div>
        )}
        <button
          className="icon-btn mobile-hide"
          onClick={onToggle}
          title={collapsed ? "展开侧栏" : "收起侧栏"}
          aria-label={collapsed ? "展开侧栏" : "收起侧栏"}
        >
          {collapsed ? <ChevronsRight size={16} /> : <ChevronsLeft size={16} />}
        </button>
        <button
          className="icon-btn mobile-only"
          onClick={onCloseDrawer}
          aria-label="关闭抽屉"
        >
          <X size={16} />
        </button>
      </div>

      <div className="sb-actions">
        <button
          className="sb-item"
          onClick={() =>
            desktopBuild
              ? setNameDialog({ mode: "create", value: "" })
              : createProject()
          }
          title="新建项目"
        >
          <FolderPlus size={15} />
          {!rail && <span>新建项目</span>}
        </button>
        <button className="sb-item" onClick={onImport} title="导入笔记">
          <Upload size={15} />
          {!rail && <span>导入笔记</span>}
        </button>
        <button className="sb-item" onClick={onExport} title="导出项目">
          <Download size={15} />
          {!rail && <span>导出项目</span>}
        </button>
      </div>

      {!rail && (
        <div className="sb-search">
          <Search size={13} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索项目"
            aria-label="搜索项目"
          />
        </div>
      )}

      {rail ? (
        <div className="sb-actions" style={{ marginTop: 4 }}>
          <button className="sb-item" onClick={onToggle} title="搜索项目">
            <Search size={15} />
          </button>
        </div>
      ) : (
        <div className="sb-label">最近项目</div>
      )}

      <div className="proj-list scroll-y" role="list">
        {!rail &&
          filtered.map((p) => (
            <div
              key={p.id}
              className={`proj-row${p.id === activeProjectId ? " active" : ""}`}
              role="listitem"
            >
              <button
                className="proj-main"
                onClick={() => setActiveProject(p.id)}
                aria-current={p.id === activeProjectId ? "page" : undefined}
              >
                <Pin
                  size={12}
                  className={p.pinned ? "pin-on" : ""}
                  style={{ opacity: p.pinned ? 1 : 0.25, flexShrink: 0 }}
                />
                <span className="proj-name">{p.name}</span>
                {generatingProjectIds.has(p.id) && (
                  <LoaderCircle
                    size={12}
                    className="generation-spinner"
                    aria-label={`${p.name}正在后台生成`}
                  />
                )}
              </button>
              <button
                className="icon-btn"
                title="项目菜单"
                aria-label={`${p.name} 的菜单`}
                onClick={(e) => {
                  e.stopPropagation();
                  setMenuFor(menuFor === p.id ? null : p.id);
                }}
              >
                <MoreHorizontal size={14} />
              </button>
              {menuFor === p.id && (
                <>
                  <div
                    style={{ position: "fixed", inset: 0, zIndex: 55 }}
                    onClick={() => {
                      setMenuFor(null);
                    }}
                  />
                  <div
                    className="menu"
                    style={{ top: 30, right: 4 }}
                    onClick={(e) => e.stopPropagation()}
                  >
                    {desktopBuild && (
                      <button
                        className="menu-item"
                        onClick={() => {
                          setNameDialog({
                            mode: "rename",
                            projectId: p.id,
                            value: p.name,
                          });
                          setMenuFor(null);
                        }}
                      >
                        <Edit3 size={14} />
                        重命名项目
                      </button>
                    )}
                    <button
                      className="menu-item"
                      onClick={() => {
                        togglePinProject(p.id);
                        setMenuFor(null);
                      }}
                    >
                      <Star size={14} />
                      {p.pinned ? "取消置顶" : "置顶项目"}
                    </button>
                    <button
                      className="menu-item"
                      onClick={() => {
                        onExport();
                        setMenuFor(null);
                      }}
                    >
                      <Download size={14} />
                      导出为开放格式
                    </button>
                    <div className="menu-sep" />
                    <button
                      className="menu-item danger"
                      onClick={() => {
                        deleteProject(p.id);
                        setMenuFor(null);
                      }}
                    >
                      <Trash2 size={14} />
                      移入回收站
                    </button>
                    <div className="menu-note">删除可在 6 秒内撤销</div>
                  </div>
                </>
              )}
            </div>
          ))}
        {!rail && filtered.length === 0 && (
          <div
            style={{
              padding: "18px 10px",
              fontSize: 12,
              color: "var(--ink-3)",
              lineHeight: 1.7,
            }}
          >
            没有匹配的项目。
            <br />
            可以新建一个，或导入已有笔记。
          </div>
        )}
      </div>

      <div className="sb-foot">
        <button className="sb-item" onClick={onSettings} title="设置">
          <Settings size={15} />
          {!rail && <span>设置</span>}
        </button>
      </div>
      {desktopBuild &&
        nameDialog &&
        createPortal(
          <div
            className="overlay"
            role="presentation"
            onClick={() => setNameDialog(null)}
          >
            <form
              className="modal"
              role="dialog"
              aria-modal="true"
              aria-label={
                nameDialog.mode === "create" ? "新建项目" : "重命名项目"
              }
              onClick={(event) => event.stopPropagation()}
              onSubmit={(event) => {
                event.preventDefault();
                const name = normalizeProjectName(nameDialog.value);
                if (!name || [...name].length > PROJECT_NAME_LIMIT) return;
                if (nameDialog.mode === "create") createProject(name);
                else if (nameDialog.projectId)
                  renameProject(nameDialog.projectId, name);
                setNameDialog(null);
              }}
            >
              <div className="modal-head">
                <FolderPlus size={17} />
                <h3>
                  {nameDialog.mode === "create" ? "新建项目" : "重命名项目"}
                </h3>
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => setNameDialog(null)}
                  aria-label="关闭"
                >
                  <X size={16} />
                </button>
              </div>
              <div className="modal-body">
                <label className="settings-field" style={{ marginTop: 0 }}>
                  项目名称
                  <input
                    autoFocus
                    value={nameDialog.value}
                    maxLength={PROJECT_NAME_LIMIT}
                    placeholder="例如：小红书起号"
                    onChange={(event) =>
                      setNameDialog((current) =>
                        current
                          ? { ...current, value: event.target.value }
                          : current,
                      )
                    }
                  />
                </label>
              </div>
              <div className="modal-foot">
                <button
                  type="button"
                  className="btn"
                  onClick={() => setNameDialog(null)}
                >
                  取消
                </button>
                <button
                  type="submit"
                  className="btn primary"
                  disabled={!normalizeProjectName(nameDialog.value)}
                >
                  {nameDialog.mode === "create" ? "创建项目" : "保存名称"}
                </button>
              </div>
            </form>
          </div>,
          document.body,
        )}
    </aside>
  );
}
