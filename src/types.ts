/**
 * 最小数据模型。
 * 三种卡片关系统一用 CardEdge 表达，UI 不硬编码关系语义。
 */

export type EdgeType = "child" | "divergent" | "branch";

/** 上下文继承策略：决定 buildContext 未来如何拼装 */
export type ContextPolicy =
  | "topic-and-selection" // 深挖：来源主题 + 选中片段
  | "topic-only" // 发散：仅来源主题作为相关背景
  | "history-through-turn"; // 改道：继承到指定轮次为止的完整历史

export type TurnRole = "user" | "ai";
export type TurnStatus = "complete" | "streaming" | "stopped" | "error";

/** 精确来源锚点：定位到卡片 / 轮次 / 文本片段 */
export interface SourceAnchor {
  id?: string;
  cardId: string;
  turnId?: string;
  /** 选中的文本片段 */
  text?: string;
  /** 选区所在的整段文本，用于回溯定位 */
  blockText?: string;
  exact?: string;
  prefix?: string;
  suffix?: string;
  sourceRevision?: string;
}

export interface ContextSnapshot {
  id: string;
  edgeId: string;
  createdAt: number;
  sourceTitle: string;
  sourceText?: string;
  sourceBlockText?: string;
  sourceTurns?: Turn[];
}

export interface ContextProvenance {
  kind:
    | "current-card"
    | "source-topic"
    | "source-selection"
    | "branch-history"
    | "reference";
  label: string;
  detail: string;
  cardId?: string;
  turnId?: string;
}

export interface LlmMessage {
  role: "system" | TurnRole;
  content: string;
}

export interface BuiltContext {
  system: string[];
  messages: LlmMessage[];
  provenance: ContextProvenance[];
  excluded: ContextProvenance[];
  estimatedTokens: number;
}

export interface Turn {
  id: string;
  role: TurnRole;
  /** Markdown 正文 */
  content: string;
  createdAt: number;
  /** 生成中的临时状态 */
  streaming?: boolean;
  status?: TurnStatus;
  error?: string;
  model?: string;
  favorite?: boolean;
}

export interface ConceptPreviewCacheEntry {
  sourceRevision: string;
  content: string;
  createdAt: number;
}

export interface Card {
  id: string;
  projectId: string;
  title: string;
  turns: Turn[];
  favorite: boolean;
  unread: boolean;
  /** 可点击概念词，由后台功能模型提取；旧 demo 可保留已有词表。 */
  concepts: string[];
  /** 概念解释按概念 + 来源版本缓存，避免重复消耗模型调用。 */
  conceptPreviewCache?: Record<string, ConceptPreviewCacheEntry>;
  /** 软删除：进入回收站 */
  trashed?: boolean;
  createdAt: number;
}

export interface CardEdge {
  id: string;
  type: EdgeType;
  sourceCardId: string;
  targetCardId: string;
  /** branch / 从轮次创建时的精确锚点 */
  sourceTurnId?: string;
  sourceText?: string;
  sourceBlockText?: string;
  sourceAnchorId?: string;
  contextSnapshotId?: string;
  contextPolicy: ContextPolicy;
}

export interface Project {
  id: string;
  name: string;
  pinned: boolean;
  updatedAt: number;
}

export interface ReferenceChip {
  id: string;
  projectId: string;
  anchor: SourceAnchor;
  /** 展示用的来源卡片标题 */
  sourceTitle: string;
  /** 截断后的引用文本 */
  excerpt: string;
}

export interface ViewState {
  id: string;
  activeProjectId: string;
  currentCardId: string;
  drafts: Record<string, string>;
  lastCardByProject: Record<string, string>;
  collapsed: string[];
  scrollPositions: Record<string, number>;
}

export interface AppSettings {
  id: "app";
  seededAt?: number;
  providerStatus?: "unknown" | "ready" | "missing" | "error";
  providerMessage?: string;
  /** 安全的公开配置；API 密钥只保存在本机服务的 .env.local。 */
  providerBaseUrl?: string;
  model: string;
}

export interface PortableProject {
  version: 1;
  project: Project;
  cards: Card[];
  edges: CardEdge[];
  anchors: SourceAnchor[];
  snapshots: ContextSnapshot[];
  references: ReferenceChip[];
  viewState?: Partial<ViewState>;
}

export interface ImportInput {
  files: File[];
  format: "md-file" | "md-dir" | "canvas" | "bundle";
}

export interface ExportArtifact {
  filename: string;
  blob: Blob;
}

export interface FormatAdapter {
  id: ImportInput["format"] | "md-dir" | "canvas" | "bundle";
  canImport(input: ImportInput): Promise<boolean>;
  import(input: ImportInput): Promise<PortableProject>;
  export(project: PortableProject): Promise<ExportArtifact[]>;
}

export interface TrashEntry {
  cards: Card[];
  edges: CardEdge[];
  label: string;
}

export const EDGE_META: Record<
  EdgeType,
  {
    label: string;
    verb: string;
    policy: ContextPolicy;
    policyLabel: string;
    color: string;
    /** 新卡片进入方向 */
    enterFrom: { x: number; y: number; rotate: number };
  }
> = {
  child: {
    label: "深挖",
    verb: "深挖自",
    policy: "topic-and-selection",
    policyLabel: "继承来源主题与选中片段，不复制完整历史",
    color: "var(--accent)",
    enterFrom: { x: 0, y: 56, rotate: 0 },
  },
  divergent: {
    label: "发散",
    verb: "发散自",
    policy: "topic-only",
    policyLabel: "仅把来源标题当作相关主题，隔离度最高",
    color: "var(--ctx)",
    enterFrom: { x: 120, y: 12, rotate: 2.5 },
  },
  branch: {
    label: "改道",
    verb: "改道自",
    policy: "history-through-turn",
    policyLabel: "继承分支点之前的对话历史，分支点之后不带入",
    color: "var(--branch)",
    enterFrom: { x: -120, y: 12, rotate: -2.5 },
  },
};
