/**
 * 只读笔记资料库的宿主无关契约。
 *
 * 这里刻意不依赖 Workspace 的 StorageAdapter：项目、卡片和资料库有完全不同的
 * 生命周期。资料库可以来自浏览器导入或桌面 Vault，且永远不会被模型直接指定路径。
 */

export type NoteLibraryKind = "web-import" | "vault";

/** Runtime availability, not a persisted promise that an old Vault still exists. */
export type NoteLibraryAvailability =
  "ready" | "indexing" | "missing" | "error";

export interface NoteLibrary {
  id: string;
  /** 用户看得到的名称，例如「产品研究资料」。 */
  name: string;
  kind: NoteLibraryKind;
  /** Vault 才有的根目录提示；Web 导入不保存本机绝对路径。 */
  rootLabel?: string;
  /** Desktop host revalidates this before every search/read; no absolute path. */
  availability?: NoteLibraryAvailability;
  availabilityReason?: string;
  createdAt: number;
  updatedAt: number;
}

export interface NoteDocument {
  id: string;
  libraryId: string;
  /** 库内相对路径，统一使用 `/`。 */
  relativePath: string;
  title: string;
  tags: string[];
  /** 归一化文本的稳定哈希；用于判断引用是否已过期。 */
  versionHash: string;
  charCount: number;
  updatedAt: number;
}

export interface NoteChunk {
  id: string;
  libraryId: string;
  documentId: string;
  documentVersionHash: string;
  relativePath: string;
  /** Markdown 标题层级；空文档也至少有一个文档标题。 */
  titlePath: string[];
  tags: string[];
  /** 同一文档内的稳定阅读顺序，从 0 开始。 */
  ordinal: number;
  /** 在原始 Markdown 中的 UTF-16 字符区间，`end` 为开区间。 */
  start: number;
  end: number;
  /** 原文切片，不经过模型或 Markdown 渲染改写。 */
  text: string;
}

export interface NoteImportFile {
  relativePath: string;
  content: string;
  modifiedAt?: number;
}

export interface NoteImportInput {
  library: NoteLibrary;
  files: NoteImportFile[];
}

export interface IndexReport {
  libraryId: string;
  documents: number;
  chunks: number;
  skipped: number;
  /** Safe, relative-path-only feedback for files that were not indexed. */
  issues?: IndexIssue[];
  updatedAt: number;
}

export interface IndexIssue {
  relativePath: string;
  code: "too-large" | string;
  message: string;
}

/**
 * 这些输入由宿主在一轮 Agent 开始时冻结。模型工具没有 libraryId、文件路径或
 * scope 参数，避免模型通过参数扩大读取范围。
 */
export interface BoundNoteSearch {
  libraryIds: string[];
  query: string;
  limit: number;
}

export interface BoundNoteRead {
  libraryIds: string[];
  chunkIds: string[];
}

export interface NoteHit {
  chunk: NoteChunk;
  score: number;
  /** 搜索实现可给 UI 的简短命中片段；没有时为原文前段。 */
  snippet: string;
}

/** Structural input so source previews do not need to import the Card domain. */
export interface NoteCitationLookup {
  libraryId: string;
  documentId: string;
  relativePath: string;
  documentHash: string;
  chunkId?: string;
  excerpt?: string;
}

export type NoteCitationResolutionState =
  "current" | "updated" | "missing" | "library-unavailable";

/**
 * Resolving a historical citation is deliberately separate from `read()`:
 * a document update changes chunk IDs, but must not be misreported as a
 * missing source. The optional chunk is always current and scope-validated.
 */
export interface NoteCitationResolution {
  state: NoteCitationResolutionState;
  chunk?: NoteChunk;
  reason?: string;
}

export interface ResolvedNoteScope {
  availableLibraryIds: string[];
  unavailableLibraries: Array<{
    id: string;
    name: string;
    availability: Exclude<NoteLibraryAvailability, "ready" | "indexing">;
    reason: string;
  }>;
}

/**
 * 独立于 Workspace StorageAdapter 的资料库接口。
 *
 * Web 实现会用 Dexie + Worker 索引；桌面实现由 Rust 的 FTS5 提供。两者都必须
 * 保持这份语义，避免检索范围在不同宿主悄悄变化。
 */
export interface NoteLibraryAdapter {
  listLibraries(): Promise<NoteLibrary[]>;
  importFiles(input: NoteImportInput): Promise<IndexReport>;
  search(input: BoundNoteSearch): Promise<NoteHit[]>;
  read(input: BoundNoteRead): Promise<NoteChunk[]>;
  removeLibrary(id: string): Promise<void>;
  rebuild(id: string): Promise<IndexReport>;
}

export interface ChunkMarkdownInput {
  libraryId: string;
  relativePath: string;
  content: string;
  /** 由宿主提供时优先于 frontmatter / H1。 */
  title?: string;
  tags?: string[];
  documentId?: string;
  updatedAt?: number;
}

export interface ChunkedNoteDocument {
  document: NoteDocument;
  chunks: NoteChunk[];
}
