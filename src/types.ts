/**
 * 最小数据模型。
 * 三种卡片关系统一用 CardEdge 表达，UI 不硬编码关系语义。
 */

import type { AgentTerminalState } from "./lib/agentTerminal";

export type EdgeType = "child" | "divergent" | "branch";

/** 上下文继承策略：决定 buildContext 未来如何拼装 */
export type ContextPolicy =
  | "topic-and-selection" // 深挖：来源主题 + 选中片段
  | "topic-only" // 发散：仅来源主题作为相关背景
  | "history-through-turn"; // 改道：继承到指定轮次为止的完整历史

/** 卡片下一次回答可使用的知识边界。 */
export type AnswerMode = "general" | "sources-only";

export type TurnRole = "user" | "ai";
/**
 * `interrupted` means the app was closed or killed while a response was
 * streaming.  Its visible partial text is retained for the user, but it is
 * never treated as a completed assistant message in a later model request.
 */
export type TurnStatus =
  "complete" | "streaming" | "stopped" | "interrupted" | "error";

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
    | "reference"
    /** Historical tool provenance only; it is explicitly not current evidence. */
    | "historical-retrieval";
  label: string;
  detail: string;
  cardId?: string;
  turnId?: string;
}

export interface LlmMessage {
  /** OpenAI-compatible wire role. UI 内部仍使用 `ai` 表示助手轮次。 */
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * OpenAI-compatible tool request.  It deliberately contains no host path,
 * library id, project id, or scope.  Those are frozen by Papertable before a
 * model turn starts and can never be widened by model output.
 */
export interface ToolCall {
  id: string;
  name: "search_notes" | "read_notes" | "papertable_probe";
  arguments: string;
}

/**
 * Provider-wire message used by the Harness.  `LlmMessage` remains the
 * compact, text-only context contract returned by buildContext(); this union
 * only exists at the provider boundary once an agent loop has begun.
 */
export type ProviderMessage =
  | LlmMessage
  | {
      role: "assistant";
      content: string | null;
      toolCalls: ToolCall[];
    }
  | {
      role: "tool";
      toolCallId: string;
      content: string;
    };

export type OutputChannel = "unknown" | "final";

/**
 * Host-neutral error vocabulary shared by web SSE and the Tauri provider.
 * User-facing layers map these codes to Chinese copy; raw transport details
 * never need to cross the provider boundary.
 */
export type ProviderErrorCode =
  | "unauthorized"
  | "rate-limited"
  | "upstream"
  | "timeout"
  | "disconnected"
  | "empty-response"
  | "invalid-response"
  | "service-unavailable";

export type ProviderStreamEvent =
  | { type: "token"; text: string; channel: OutputChannel }
  | {
      type: "tool-call-delta";
      index: number;
      id?: string;
      name?: string;
      arguments?: string;
    }
  | { type: "done"; finishReason?: string }
  | { type: "error"; message: string; code?: ProviderErrorCode };

export type AgentExecutionMode = "native-tools" | "two-stage";

/** Safe capability cache key is base URL + model; never contains a secret. */
export interface ProviderCapability {
  baseUrl: string;
  model: string;
  mode: AgentExecutionMode;
  streamingToolCalls: boolean;
  toolResultAccepted: boolean;
  testedAt: number;
}

export interface NoteCitation {
  /** Stable internal chunk id.  The renderer only accepts ids actually read. */
  chunkId: string;
  libraryId: string;
  documentId: string;
  title: string;
  relativePath: string;
  /** Frozen evidence lets an old answer remain inspectable after source edits. */
  documentHash: string;
  excerpt: string;
}

/**
 * A bounded audit record for a completed historical tool-assisted answer.
 * It deliberately carries only a query and a vault-relative source label:
 * it proves that an earlier answer used a real read-only tool, but is not a
 * reusable current-round source, scope grant, or citation.
 */
export interface HistoricalRetrievalEvidence {
  query: string;
  relativePath: string;
  title: string;
  hitType: "read" | "search-hit";
}

export interface AgentRunTrace {
  mode: AgentExecutionMode;
  startedAt: number;
  finishedAt: number;
  searchQueries: string[];
  hitCount: number;
  readChunkIds: string[];
  /** True when tool/call budgets cut a run short. */
  truncated?: boolean;
  /** Validated result × stop-reason terminal for this run. */
  terminal?: AgentTerminalState;
  errors?: string[];
  /** Explicitly records a strict source-only refusal instead of hiding it. */
  retrievalUnavailable?: boolean;
  /** At most eight safe historical tool audit records, populated on success. */
  retrievalEvidence?: HistoricalRetrievalEvidence[];
}

export interface BuiltContext {
  /** 当前请求的回答依据；由当前卡片决定。 */
  answerMode: AnswerMode;
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
  /** Harness operational trace.  Never contains hidden reasoning. */
  agentRun?: AgentRunTrace;
  /** Only chunks actually read in this run can appear here. */
  citations?: NoteCitation[];
  /** Transient, user-visible Harness phase; persisted only to survive refresh. */
  agentPhase?: "searching" | "reading" | "answering";
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
  /**
   * 未设置时兼容旧数据，按 `general` 处理。该设置只影响后续模型请求，
   * 不会改写已有回答。
   */
  answerMode?: AnswerMode;
  /** 可点击概念词，由后台功能模型提取；旧 demo 可保留已有词表。 */
  concepts: string[];
  /** 概念解释按概念 + 来源版本缓存，避免重复消耗模型调用。 */
  conceptPreviewCache?: Record<string, ConceptPreviewCacheEntry>;
  /** 软删除：进入回收站 */
  trashed?: boolean;
  /** 创建来源只用于审计与实验统计，不参与上下文拼装。 */
  origin?:
    | "manual"
    | "selection"
    | "concept-promotion"
    | "proposal"
    | "question-reroute";
  /** 提案物化后的回溯关系；Proposal 本身绝不进入卡片上下文。 */
  proposalId?: string;
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
  /** 仅用于“编辑并改道”的审计；sourceTurnId 仍指向用户看到的来源轮次。 */
  contextCutoffTurnId?: string | null;
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
  /** 注意力实验只影响事件与提案；不影响普通卡片和模型对话。 */
  attentionPaused?: boolean;
  attentionExperimentStartedAt?: number;
  /** 每个项目每天只出现一次晨间提示。 */
  attentionPromptedDates?: Record<string, string>;
  /** 实验期间的提示计数历史；与每日去重表分开，避免多天被覆盖。 */
  attentionPromptHistory?: string[];
  /**
   * Obsidian vault 根目录。仅桌面版；未设置时同步整体关闭。
   * Papertable 只写它下面的 `80_AI暂存/Papertable/`，见 docs/VAULT_SYNC.md。
   */
  vaultPath?: string;
  /**
   * 开启了 vault 同步的项目 id。**按项目 opt-in**，不是全局——不该有人某天醒来
   * 发现整个工作区被镜像进了知识库。
   */
  vaultSyncedProjects?: string[];
  /**
   * Papertable 在知识库里拥有的子树，相对于 `vaultPath`。未设置时用默认值。
   *
   * 可配置的是**落点**，不是要不要检查：Rust 侧仍然只有一个容纳根、仍然逐次断言，
   * 并且拒绝绝对路径、`..` 和以 `.` 开头的分量。
   */
  vaultSubtree?: string;
  /** Safe, local capability cache. It is invalidated whenever endpoint/model changes. */
  providerCapabilities?: ProviderCapability[];
}

/**
 * 行为事件是 append-only 的实验原始数据；不进入导出、搜索或模型上下文。
 * targetCardId 用于聚合，sourceCardId/sourceAnchorId 用于找到值得继续探索的来源。
 */
export type InteractionEventType =
  | "favorite-set"
  | "reference-sent"
  | "card-created"
  | "concept-promoted"
  | "title-edited"
  | "question-rerouted"
  | "card-reopened"
  | "concept-preview-opened"
  | "card-dwell";

export interface InteractionEvent {
  id: string;
  projectId: string;
  sessionId: string;
  type: InteractionEventType;
  createdAt: number;
  targetCardId?: string;
  sourceCardId?: string;
  targetTurnId?: string;
  sourceAnchorId?: string;
  relation?: EdgeType;
  concept?: string;
  /** favorite-set 用；false 表示取消收藏，会抵消同一会话、同一目标的收藏。 */
  active?: boolean;
}

export type SessionEndReason =
  | "project-switch"
  | "idle"
  | "hidden-idle"
  | "pagehide"
  | "date-change"
  | "startup-recovery";

/** 一条记录就是一个项目内会话，包含开始、活动检查点、结束和处理状态。 */
export interface SessionBoundary {
  id: string;
  projectId: string;
  localDate: string;
  startedAt: number;
  lastActiveAt: number;
  endedAt?: number;
  endReason?: SessionEndReason;
  processedAt?: number;
}

export type ProposalStatus =
  "queued" | "opened" | "accepted" | "dismissed" | "cooled";

export type ProposalEvidence = "human-signals" | "ai-wildcard";

/**
 * 幽灵分支：独立于 Card，不能进入 buildContext、搜索或任何正常项目导出。
 */
export interface Proposal {
  id: string;
  projectId: string;
  sessionId: string;
  title: string;
  explorationQuestion: string;
  reason: string;
  sourceAnchorIds: string[];
  suggestedParentCardId: string;
  suggestedRelation: EdgeType;
  evidence: ProposalEvidence;
  status: ProposalStatus;
  candidateKey: string;
  signalScore: number;
  signalEventIds: string[];
  createdAt: number;
  lastSignalAt: number;
  expiresAt: number;
  purgeAt: number;
  acceptedCardId?: string;
  dismissedAt?: number;
}

export interface AttentionMetrics {
  dayIndex: number;
  paused: boolean;
  today: {
    strong: number;
    medium: number;
    weak: number;
  };
  promptCount: number;
  proposalCount: number;
  openedCount: number;
  openedRate: number;
  secondaryStrongSignalCount: number;
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

/** 挂起中的 vault 冲突：用户在 Obsidian 改过这篇笔记，同步已停在这里。 */
export interface VaultConflict {
  cardId: string;
  /** vault 相对路径，用于在横幅上点名文件。 */
  path: string;
}
