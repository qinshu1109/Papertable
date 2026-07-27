import { useEffect, useRef, useState } from "react";
import {
  Check,
  BookOpen,
  FileJson,
  FileText,
  FolderTree,
  KeyRound,
  Package,
  RefreshCw,
  Settings2,
  Upload,
  X,
} from "lucide-react";
import {
  getBuildInfo,
  getKeySource,
  getProviderConfig,
  saveProviderConfig,
  type BuildInfo,
  type KeySource,
  type ProviderConfig,
} from "../lib/provider";
import { useStore } from "../store";
import type { ImportInput } from "../types";

const IMPORT_FORMATS = [
  {
    id: "note-library",
    icon: BookOpen,
    name: "建立只读资料库",
    desc: "只建立可检索材料，不导入卡片、不改变关系图；会绑定到当前项目。",
  },
  {
    id: "md-file",
    icon: FileText,
    name: "单个 Markdown 文件",
    desc: "把一篇笔记导入为一个根卡片。",
  },
  {
    id: "md-dir",
    icon: FolderTree,
    name: "Markdown 文件夹",
    desc: "把多篇 Markdown 作为一个项目导入；普通双链只作为引用。",
  },
  {
    id: "canvas",
    icon: FileJson,
    name: "JSON Canvas",
    desc: "读取 .canvas 与对应的 Markdown 文件。",
  },
  {
    id: "bundle",
    icon: Package,
    name: "无损项目包",
    desc: "恢复卡片、关系、快照、引用和阅读位置。",
  },
] as const;

type ImportSelection = ImportInput["format"] | "note-library";

function noteLibraryAvailabilityLabel(
  availability: "ready" | "indexing" | "missing" | "error" | undefined,
) {
  if (!availability || availability === "ready") return "当前可用";
  if (availability === "indexing") return "正在索引";
  return "当前不可用";
}

function noteLibraryIsUsable(
  availability: "ready" | "indexing" | "missing" | "error" | undefined,
) {
  return !availability || availability === "ready";
}

const EXPORT_FORMATS = [
  {
    id: "md-dir",
    icon: FolderTree,
    name: "Markdown 文件夹",
    desc: "每张卡片一份 Markdown，使用标准 frontmatter。",
  },
  {
    id: "canvas",
    icon: FileJson,
    name: "JSON Canvas + Markdown",
    desc: "图结构写入 .canvas，正文保持独立 Markdown。",
  },
  {
    id: "bundle",
    icon: Package,
    name: "无损项目包",
    desc: "可在 Papertable 中完整、无损地重新导入。",
  },
] as const;

function Shell({
  title,
  icon,
  onClose,
  children,
  footer,
}: {
  title: string;
  icon: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
  footer: React.ReactNode;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const frame = window.requestAnimationFrame(() => {
      dialogRef.current?.querySelector<HTMLElement>("button, input")?.focus();
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      onCloseRef.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("keydown", onKeyDown);
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return (
    <div className="overlay" onClick={onClose} role="presentation">
      <div
        className="modal"
        ref={dialogRef}
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-label={title}
        aria-modal="true"
      >
        <div className="modal-head">
          {icon}
          <h3>{title}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="关闭">
            <X size={16} />
          </button>
        </div>
        <div className="modal-body scroll-y">{children}</div>
        <div className="modal-foot">{footer}</div>
      </div>
    </div>
  );
}

export function ImportDialog({ onClose }: { onClose: () => void }) {
  const { importFiles, importNoteLibrary, showToast } = useStore();
  const [selection, setSelection] = useState<ImportSelection>("md-dir");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const selected = IMPORT_FORMATS.find((item) => item.id === selection)!;
  const triggerChooser = () => fileRef.current?.click();
  const triggerFolderChooser = () => folderRef.current?.click();
  const importSelected = async () => {
    if (!files.length) return triggerChooser();
    setBusy(true);
    try {
      if (selection === "note-library") await importNoteLibrary(files);
      else await importFiles(selection, files);
      onClose();
    } catch (error) {
      showToast({
        text:
          error instanceof Error ? error.message : "导入失败，原项目未被修改。",
      });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Shell
      title="导入笔记"
      icon={<Upload size={16} color="var(--ink-2)" />}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button
            className="btn primary"
            disabled={busy}
            onClick={() => void importSelected()}
          >
            {busy
              ? "正在导入…"
              : files.length
                ? `导入 ${files.length} 个文件`
                : "选择来源并导入"}
          </button>
        </>
      }
    >
      <input
        ref={fileRef}
        type="file"
        className="sr-only"
        multiple
        accept={
          selection === "bundle"
            ? ".zip,application/zip"
            : selection === "canvas"
              ? ".canvas,.md,application/json,text/markdown"
              : ".md,.markdown,text/markdown"
        }
        {...(selection === "md-dir"
          ? ({ webkitdirectory: "", directory: "" } as Record<string, string>)
          : {})}
        onChange={(event) => setFiles(Array.from(event.target.files ?? []))}
      />
      {selection === "note-library" && (
        <input
          ref={folderRef}
          type="file"
          className="sr-only"
          multiple
          accept=".md,.markdown,text/markdown"
          {...({ webkitdirectory: "", directory: "" } as Record<
            string,
            string
          >)}
          onChange={(event) => setFiles(Array.from(event.target.files ?? []))}
        />
      )}
      {IMPORT_FORMATS.map((item) => (
        <button
          key={item.id}
          className={`fmt-option${selection === item.id ? " sel" : ""}`}
          onClick={() => {
            setSelection(item.id);
            setFiles([]);
          }}
        >
          <span className="fmt-icon">
            <item.icon size={15} />
          </span>
          <span style={{ minWidth: 0, flex: 1 }}>
            <span className="fmt-name">{item.name}</span>
            <span className="fmt-desc">{item.desc}</span>
          </span>
          {selection === item.id && (
            <Check size={15} color="var(--accent)" style={{ marginTop: 6 }} />
          )}
        </button>
      ))}
      <button
        className="btn"
        style={{ marginTop: 10 }}
        onClick={triggerChooser}
      >
        {files.length
          ? `已选择 ${files.length} 个文件 · 重新选择`
          : `选择${selected.name}`}
      </button>
      {selection === "note-library" && !files.length && (
        <button
          className="btn"
          style={{ marginTop: 8 }}
          onClick={triggerFolderChooser}
        >
          选择资料文件夹
        </button>
      )}
      <p className="note-line">
        全部采用开放格式，兼容 Obsidian 等使用 Markdown 或 JSON Canvas
        的笔记工具。导入会先校验，失败时不会留下半个项目。
      </p>
    </Shell>
  );
}

export function ExportDialog({ onClose }: { onClose: () => void }) {
  const { exportProject, showToast } = useStore();
  const [selection, setSelection] = useState<"md-dir" | "canvas" | "bundle">(
    "canvas",
  );
  const [busy, setBusy] = useState(false);
  const exportNow = async () => {
    setBusy(true);
    try {
      await exportProject(selection);
      onClose();
    } catch (error) {
      showToast({
        text: error instanceof Error ? error.message : "导出失败。",
      });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Shell
      title="导出项目"
      icon={<Package size={16} color="var(--ink-2)" />}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button
            className="btn primary"
            disabled={busy}
            onClick={() => void exportNow()}
          >
            {busy ? "正在打包…" : "导出"}
          </button>
        </>
      }
    >
      {EXPORT_FORMATS.map((item) => (
        <button
          key={item.id}
          className={`fmt-option${selection === item.id ? " sel" : ""}`}
          onClick={() => setSelection(item.id)}
        >
          <span className="fmt-icon">
            <item.icon size={15} />
          </span>
          <span style={{ minWidth: 0, flex: 1 }}>
            <span className="fmt-name">{item.name}</span>
            <span className="fmt-desc">{item.desc}</span>
          </span>
          {selection === item.id && (
            <Check size={15} color="var(--accent)" style={{ marginTop: 6 }} />
          )}
        </button>
      ))}
      <p className="note-line">
        网页会把目录结构打包成 ZIP 下载。Markdown 和 JSON Canvas
        不依赖本工具即可阅读。
      </p>
    </Shell>
  );
}

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const {
    provider,
    agentMode,
    refreshProvider,
    exportAllBackup,
    exportLibraryBackup,
    importLibraryBackup,
    clearLocalData,
    showToast,
    attentionMetrics,
    attentionPaused,
    setAttentionPaused,
    vaultAvailable,
    chooseVaultPath,
    rescanVault,
    vaultIndexed,
    toggleProjectVaultSync,
    vaultPath,
    vaultSyncedProjects,
    projects,
    activeProjectId,
    noteLibraries,
    boundNoteLibraryIds,
    setProjectNoteLibraries,
    removeNoteLibrary,
  } = useStore();
  const [testing, setTesting] = useState(false);
  const [savingConnection, setSavingConnection] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [connection, setConnection] = useState<ProviderConfig | null>(null);
  const [baseUrl, setBaseUrl] = useState(
    provider?.baseUrl ?? "https://cozai.net/v1",
  );
  const [model, setModel] = useState(provider?.model ?? "claude-opus-5");
  const [apiKey, setApiKey] = useState("");
  const [keySource, setKeySource] = useState<KeySource>("none");
  const [build, setBuild] = useState<BuildInfo | null>(null);
  const boundLibraries = noteLibraries.filter((library) =>
    boundNoteLibraryIds.includes(library.id),
  );
  const usableBoundLibraries = boundLibraries.filter((library) =>
    noteLibraryIsUsable(library.availability),
  );
  useEffect(() => {
    void getBuildInfo()
      .then(setBuild)
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    let active = true;
    void getProviderConfig()
      .then((config) => {
        if (!active) return;
        setConnection(config);
        setBaseUrl(config.baseUrl);
        setModel(config.model);
        void getKeySource().then((source) => active && setKeySource(source));
      })
      .catch((error) => {
        if (!active) return;
        showToast({
          text: error instanceof Error ? error.message : "无法读取模型设置。",
        });
      });
    return () => {
      active = false;
    };
  }, [showToast]);
  const test = async () => {
    setTesting(true);
    const result = await refreshProvider();
    setTesting(false);
    showToast({
      text: result?.configured
        ? "CozAI 已配置，可开始真实生成。"
        : (result?.message ?? "模型服务未配置。"),
    });
  };
  const saveConnection = async () => {
    setSavingConnection(true);
    try {
      const saved = await saveProviderConfig({ baseUrl, model, apiKey });
      setConnection(saved);
      setBaseUrl(saved.baseUrl);
      setModel(saved.model);
      setApiKey("");
      setKeySource(await getKeySource());
      const health = await refreshProvider();
      showToast({
        text: health?.configured
          ? "已保存并连接到模型服务。"
          : (health?.message ?? "已保存本机设置，请检查连接。"),
      });
    } catch (error) {
      showToast({
        text: error instanceof Error ? error.message : "无法保存模型设置。",
      });
    } finally {
      setSavingConnection(false);
    }
  };
  return (
    <Shell
      title="设置"
      icon={<Settings2 size={16} color="var(--ink-2)" />}
      onClose={onClose}
      footer={
        <button className="btn primary" onClick={onClose}>
          完成
        </button>
      }
    >
      <div style={{ fontSize: 12.5, color: "var(--ink-2)", lineHeight: 1.8 }}>
        <div className="fmt-name" style={{ marginBottom: 8 }}>
          模型连接
        </div>
        <div className="fmt-option" style={{ cursor: "default" }}>
          <span className="fmt-icon">
            <KeyRound size={15} />
          </span>
          <span style={{ minWidth: 0, flex: 1 }}>
            <span className="fmt-name">
              {provider?.configured ? "连接正常" : "本机模型设置"}
            </span>
            <span className="fmt-desc">
              {provider?.configured
                ? `${provider.model} · ${provider.baseUrl}`
                : (provider?.message ??
                  "填写接口地址、模型和 API 密钥后即可使用")}
            </span>
          </span>
        </div>
        <label className="settings-field">
          <span>接口地址</span>
          <input
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            inputMode="url"
            autoComplete="url"
            spellCheck={false}
            placeholder="https://cozai.net/v1"
            aria-label="接口地址"
          />
        </label>
        <label className="settings-field">
          <span>模型名称</span>
          <input
            value={model}
            onChange={(event) => setModel(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            placeholder="claude-opus-5"
            aria-label="模型名称"
          />
        </label>
        <label className="settings-field">
          <span>API 密钥</span>
          <input
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            autoComplete="new-password"
            spellCheck={false}
            placeholder={
              connection?.hasApiKey
                ? "已保存；留空则保持不变"
                : "粘贴新的 API 密钥"
            }
            aria-label="API 密钥"
          />
        </label>
        {/* 密钥固定落在 owner-only 文件；桌面端不再碰钥匙串，避免每次启动索要密码。 */}
        {keySource !== "none" && (
          <p className="note-line" style={{ marginTop: 6 }}>
            {vaultAvailable
              ? "密钥保存在应用数据目录的 0600 文件里；桌面版不会访问系统钥匙串。"
              : "密钥保存在本机服务的 .env.local（0600，已被 Git 忽略）。"}
          </p>
        )}
        {vaultAvailable && (
          <p className="note-line" style={{ marginTop: 6 }}>
            若你刚从旧版升级，请重新粘贴并保存一次 API
            密钥；旧版留在钥匙串中的条目不会再被读取，因此以后打开应用不会弹系统密码框。
          </p>
        )}
        <button
          className="btn primary"
          style={{ marginTop: 12 }}
          disabled={savingConnection}
          onClick={() => void saveConnection()}
        >
          <KeyRound size={14} />
          {savingConnection ? "正在保存并测试…" : "保存本机配置"}
        </button>
        <button
          className="btn"
          style={{ marginTop: 10, marginLeft: 8 }}
          disabled={testing || savingConnection}
          onClick={() => void test()}
        >
          <RefreshCw size={14} />
          {testing ? "测试中…" : "测试连接"}
        </button>
        {/*
          密钥的落点**只在一处描述**，就是上面那行由 keySource 驱动的话。
          这里曾经写死「保存到未提交的 .env.local」——那是 web 端本机服务的路径，
          桌面版根本不用它，于是同一个页面上出现了两种互相矛盾的说明。
          描述真实状态的字段已经有了，这里就不该再有第二个说法。
        */}
        <p className="note-line">
          密钥不会回显、不进 IndexedDB、不打包进导出文件。接口地址仅接受 HTTPS
          或本机 HTTP。
        </p>
        <div className="fmt-name" style={{ marginTop: 22, marginBottom: 8 }}>
          只读资料库
        </div>
        <p className="note-line" style={{ marginTop: 0 }}>
          当前项目只能检索你在这里明确绑定、且当前可用的资料库。不可用的资料库不会进入本轮检索范围；模型看不到真实
          Vault 根目录，也没有写入权限。当前协议：
          {agentMode === "native-tools" ? "原生工具" : "双阶段检索"}。
        </p>
        {noteLibraries.length === 0 ? (
          <p className="note-line">
            还没有资料库。用左侧“导入笔记”选择“建立只读资料库”。
          </p>
        ) : (
          noteLibraries.map((library) => {
            const bound = boundNoteLibraryIds.includes(library.id);
            const usable = noteLibraryIsUsable(library.availability);
            const availabilityLabel = noteLibraryAvailabilityLabel(
              library.availability,
            );
            return (
              <div
                className="fmt-option"
                key={library.id}
                style={{ cursor: "default" }}
              >
                <span className="fmt-icon">
                  <BookOpen size={15} />
                </span>
                <span style={{ minWidth: 0, flex: 1 }}>
                  <span className="fmt-name">{library.name}</span>
                  <span className="fmt-desc">
                    {library.kind === "vault"
                      ? "桌面 Vault · 只读索引"
                      : "网页导入 · 只读副本"}
                  </span>
                  <span className="note-library-states">
                    <span className={bound ? "bound" : "unbound"}>
                      {bound ? "当前项目已绑定" : "当前项目未绑定"}
                    </span>
                    <span className={usable ? "usable" : "unavailable"}>
                      {availabilityLabel}
                    </span>
                  </span>
                  {!usable && library.availabilityReason && (
                    <span className="fmt-desc note-library-reason">
                      {library.availabilityReason}
                    </span>
                  )}
                </span>
                <button
                  className={`btn${bound ? " primary" : ""}`}
                  style={{ padding: "5px 8px", fontSize: 11 }}
                  onClick={() =>
                    void setProjectNoteLibraries(
                      bound
                        ? boundNoteLibraryIds.filter((id) => id !== library.id)
                        : [...boundNoteLibraryIds, library.id],
                    )
                  }
                  aria-pressed={bound}
                >
                  {bound ? "当前项目已绑定" : "绑定到当前项目"}
                </button>
                {library.kind === "vault" && !usable && (
                  <button
                    className="btn"
                    style={{ padding: "5px 8px", fontSize: 11 }}
                    onClick={() => void chooseVaultPath()}
                    title="选择资料库的新位置并重新建立只读索引"
                  >
                    重新定位目录
                  </button>
                )}
                <button
                  className="icon-btn"
                  onClick={() => void removeNoteLibrary(library.id)}
                  title="移除资料库（不会删除原始笔记或项目卡片）"
                  aria-label={`移除资料库：${library.name}`}
                >
                  <X size={14} />
                </button>
              </div>
            );
          })
        )}
        {activeProjectId && noteLibraries.length > 0 && (
          <p className="note-line">
            当前项目已绑定 {boundLibraries.length} / {noteLibraries.length}{" "}
            个资料库；其中 {usableBoundLibraries.length} 个当前可用
            {boundLibraries.length > usableBoundLibraries.length
              ? `，${boundLibraries.length - usableBoundLibraries.length} 个暂不可检索`
              : ""}
            。
          </p>
        )}
        <div className="fmt-name" style={{ marginTop: 22, marginBottom: 8 }}>
          注意力观察
        </div>
        <div className="attention-settings">
          <div>
            <b>
              {attentionPaused
                ? "观察已暂停"
                : `已观察 ${attentionMetrics.dayIndex} 天`}
            </b>
            <span>
              暂停后不记录行为、不生成提案，也不会补算暂停期间的动作。
            </span>
          </div>
          <button
            className={`btn${attentionPaused ? " primary" : ""}`}
            onClick={() => setAttentionPaused(!attentionPaused)}
          >
            {attentionPaused ? "恢复观察" : "暂停观察"}
          </button>
        </div>
        <div className="attention-metrics" aria-label="注意力观察统计">
          <span>今日强 / 中 / 弱</span>
          <b>
            {attentionMetrics.today.strong} / {attentionMetrics.today.medium} /{" "}
            {attentionMetrics.today.weak}
          </b>
          <span>晨间提示</span>
          <b>{attentionMetrics.promptCount} 次</b>
          <span>主动展开率</span>
          <b>{Math.round(attentionMetrics.openedRate * 100)}%</b>
          <span>二次强信号卡片</span>
          <b>{attentionMetrics.secondaryStrongSignalCount} 张</b>
        </div>
        <p className="note-line">
          这里只统计本机行为；第一阶段不连接 MemOS，也不会为提案额外调用模型。
        </p>
        {/* web 端整块不出现：浏览器里的网页碰不到硬盘，这不是「暂未实现」。 */}
        {vaultAvailable && (
          <>
            <div
              className="fmt-name"
              style={{ marginTop: 22, marginBottom: 8 }}
            >
              知识库同步
            </div>
            <p className="note-line" style={{ marginTop: 0 }}>
              Papertable 只写入 <code>80_AI暂存/Papertable/</code>
              ，绝不碰知识库的 其他位置。正式知识请照常经 knowledge-coach
              发布。你在 Obsidian
              里改过的笔记不会被覆盖——会另存冲突文件并暂停那张卡片的同步。
            </p>
            <button className="btn" onClick={() => void chooseVaultPath()}>
              <FolderTree size={14} />
              {vaultPath ? "更换知识库目录" : "选择知识库目录"}
            </button>
            {vaultPath && (
              <>
                <p className="note-line" style={{ marginTop: 8 }}>
                  当前：<code>{vaultPath}</code>
                  {vaultIndexed > 0 && ` · 已索引 ${vaultIndexed} 篇笔记`}
                </p>
                <button
                  className="btn"
                  onClick={() => void rescanVault()}
                  title="监听器出问题时的手动兜底：重新全量扫描知识库并重新开始监听"
                >
                  <RefreshCw size={14} />
                  重新扫描知识库
                </button>
                <div className="fmt-desc" style={{ margin: "12px 0 6px" }}>
                  按项目开启（默认全部关闭）
                </div>
                {projects.map((project) => {
                  const on = vaultSyncedProjects.includes(project.id);
                  return (
                    <button
                      key={project.id}
                      className={`fmt-option${on ? " sel" : ""}`}
                      onClick={() => void toggleProjectVaultSync(project.id)}
                      aria-pressed={on}
                    >
                      <span className="fmt-icon">
                        <FolderTree size={15} />
                      </span>
                      <span style={{ minWidth: 0, flex: 1 }}>
                        <span className="fmt-name">{project.name}</span>
                        <span className="fmt-desc">
                          {on ? "已同步到知识库" : "未同步"}
                        </span>
                      </span>
                      {on && (
                        <Check
                          size={15}
                          color="var(--accent)"
                          style={{ marginTop: 6 }}
                        />
                      )}
                    </button>
                  );
                })}
              </>
            )}
          </>
        )}

        {/* 构建标识。常规构建与明确隔离的 QA 构建必须如实区分数据范围。 */}
        {build && (
          <>
            <div
              className="fmt-name"
              style={{ marginTop: 22, marginBottom: 8 }}
            >
              这一份构建
            </div>
            {!build.installed && !build.isolated && (
              <p
                className="note-line"
                style={{ marginTop: 0, color: "var(--danger)" }}
              >
                你运行的<strong>不是</strong> /Applications
                里正式安装的那一份，而是构建产物。
                它与正式版共用同一个数据库，改动看起来会像没生效。
              </p>
            )}
            {!build.installed && build.isolated && (
              <p className="note-line" style={{ marginTop: 0 }}>
                这是隔离构建（{build.identifier}），使用独立的本地数据目录；
                不会读取或修改正式版的数据。
              </p>
            )}
            <p className="note-line" style={{ marginTop: 0 }}>
              {build.commit} · 构建于 {build.builtAt}
              <br />
              <code>{build.exe}</code>
            </p>
          </>
        )}

        <div className="fmt-name" style={{ marginTop: 22, marginBottom: 8 }}>
          本地数据
        </div>
        <button className="btn" onClick={() => void exportAllBackup()}>
          <Package size={14} />
          导出全部备份
        </button>
        <button
          className="btn"
          style={{ marginLeft: 8 }}
          onClick={() => void exportLibraryBackup()}
          title="一个 JSON 覆盖全部 12 张表，含视图、设置与注意力实验数据。迁移到桌面版时需要它——浏览器的 IndexedDB 无法被桌面应用直接读取。"
        >
          <Package size={14} />
          导出整库 JSON
        </button>
        <label
          className="btn"
          style={{ marginLeft: 8, cursor: "pointer" }}
          title="用整库 JSON 覆盖当前后端的全部数据。导入后会立刻重新读出来逐表比对，结果显示在提示里。"
        >
          <Package size={14} />
          导入整库 JSON
          <input
            type="file"
            accept="application/json,.json"
            className="sr-only"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (!file) return;
              void file
                .text()
                .then((text) => importLibraryBackup(text))
                .catch((cause: unknown) =>
                  showToast({
                    text: cause instanceof Error ? cause.message : "导入失败。",
                  }),
                );
            }}
          />
        </label>
        {!confirmClear ? (
          <button
            className="btn"
            style={{ marginLeft: 8, color: "var(--danger)" }}
            onClick={() => setConfirmClear(true)}
          >
            清除本地数据
          </button>
        ) : (
          <div
            style={{
              marginTop: 12,
              padding: 10,
              border: "1px solid var(--danger)",
              borderRadius: 10,
            }}
          >
            <b style={{ color: "var(--danger)" }}>确认清除？</b>
            <br />
            会删除此浏览器保存的全部项目；请先导出备份。
            <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
              <button className="btn" onClick={() => setConfirmClear(false)}>
                取消
              </button>
              <button
                className="btn"
                style={{ color: "var(--danger)" }}
                onClick={() => {
                  void clearLocalData();
                  setConfirmClear(false);
                }}
              >
                确认清除
              </button>
            </div>
          </div>
        )}
      </div>
    </Shell>
  );
}
