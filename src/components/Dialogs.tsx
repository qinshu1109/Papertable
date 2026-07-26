import { useEffect, useRef, useState } from "react";
import {
  Check,
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
  getKeySource,
  getProviderConfig,
  saveProviderConfig,
  type KeySource,
  type ProviderConfig,
} from "../lib/provider";
import { useStore } from "../store";
import type { ImportInput } from "../types";

const IMPORT_FORMATS = [
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
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current?.querySelector<HTMLElement>("button, input")?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      previous?.focus();
    };
  }, [onClose]);
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
  const { importFiles, showToast } = useStore();
  const [selection, setSelection] = useState<ImportInput["format"]>("md-dir");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const selected = IMPORT_FORMATS.find((item) => item.id === selection)!;
  const triggerChooser = () => fileRef.current?.click();
  const importSelected = async () => {
    if (!files.length) return triggerChooser();
    setBusy(true);
    try {
      await importFiles(selection, files);
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
        {/*
          如实展示密钥到底存在哪。钥匙串取不到时会回落到 0600 文件——把回落显示成
          「已进钥匙串」，会让人以为磁盘上没有明文密钥。
        */}
        {keySource !== "none" && (
          <p className="note-line" style={{ marginTop: 6 }}>
            {keySource === "keychain"
              ? "密钥保存在系统钥匙串。"
              : "密钥保存在应用数据目录的 0600 文件里（系统钥匙串不可用时的回落）。"}
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
        <p className="note-line">
          密钥只提交给 127.0.0.1 的本机服务，页面不会回显、保存到 IndexedDB
          或打包进导出文件。保存后会写入未提交的 .env.local；接口地址仅接受
          HTTPS 或本机 HTTP。
        </p>
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
