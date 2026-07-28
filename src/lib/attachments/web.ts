import { db } from "../storage/dexie";
import { chunkMarkdown } from "../notes/chunk";
import { rankNoteChunks } from "../notes/search";
import type { NoteChunk } from "../notes/types";
import {
  ATTACHMENT_BYTE_LIMIT,
  ATTACHMENT_COUNT_LIMIT,
  ATTACHMENT_HARD_BYTE_LIMIT,
  ATTACHMENT_HARD_COUNT_LIMIT,
  attachmentScope,
  type Attachment,
  type AttachmentHost,
  type AttachmentImportResult,
  type AttachmentPreflight,
  type AttachmentProgress,
} from "./types";

export interface WebAttachmentRecord extends Attachment {
  /** Immutable application-owned snapshot. Never a source File handle/path. */
  bytes: ArrayBuffer;
}

const textExtensions = new Set([
  "md",
  "markdown",
  "txt",
  "json",
  "jsonl",
  "csv",
  "tsv",
  "yaml",
  "yml",
  "html",
  "css",
  "js",
  "jsx",
  "ts",
  "tsx",
  "rs",
  "py",
  "toml",
  "xml",
]);

function safeRelativePath(file: File): string {
  const raw =
    (file as File & { webkitRelativePath?: string }).webkitRelativePath ||
    file.name;
  const normalized = raw.replace(/\\/g, "/").replace(/^(\.\/)+/, "");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    /^[a-z]:\//i.test(normalized) ||
    normalized.split("/").some((part) => !part || part === "..")
  )
    return file.name.replace(/[\\/]/g, "_") || "attachment";
  return normalized;
}

function publicAttachment(record: WebAttachmentRecord): Attachment {
  return {
    id: record.id,
    cardId: record.cardId,
    scope: record.scope,
    name: record.name,
    relativePath: record.relativePath,
    mimeType: record.mimeType,
    byteSize: record.byteSize,
    sha256: record.sha256,
    indexed: record.indexed,
    createdAt: record.createdAt,
    ...(record.promotedLibraryId
      ? { promotedLibraryId: record.promotedLibraryId }
      : {}),
    ...(record.promotedDocumentId
      ? { promotedDocumentId: record.promotedDocumentId }
      : {}),
  };
}

function makeJobId() {
  return `attachment-job-${crypto.randomUUID()}`;
}

function preflight(cardId: string, files: File[]): AttachmentPreflight {
  const items = files.map((file, index) => ({
    key: `${index}:${file.name}:${file.size}:${file.lastModified}`,
    name: file.name || "attachment",
    relativePath: safeRelativePath(file),
    byteSize: file.size,
  }));
  const totalBytes = items.reduce((total, item) => total + item.byteSize, 0);
  if (!items.length) throw new Error("没有可导入的附件。");
  if (
    items.length > ATTACHMENT_HARD_COUNT_LIMIT ||
    totalBytes > ATTACHMENT_HARD_BYTE_LIMIT
  )
    throw new Error("附件超过安全硬上限（500 项或 512 MiB），已拒绝导入。");
  return {
    schemaVersion: 1,
    jobId: makeJobId(),
    cardId,
    items,
    totalCount: items.length,
    totalBytes,
    countLimit: ATTACHMENT_COUNT_LIMIT,
    byteLimit: ATTACHMENT_BYTE_LIMIT,
    requiresConfirmation:
      items.length > ATTACHMENT_COUNT_LIMIT ||
      totalBytes > ATTACHMENT_BYTE_LIMIT,
    issues: [],
  };
}

function assertPreflight(value: AttachmentPreflight, confirmed: boolean): void {
  if (!value.items.length) throw new Error("没有可导入的附件。");
  if (
    value.totalCount > ATTACHMENT_HARD_COUNT_LIMIT ||
    value.totalBytes > ATTACHMENT_HARD_BYTE_LIMIT
  )
    throw new Error("附件超过安全硬上限（500 项或 512 MiB），已拒绝导入。");
  if (value.requiresConfirmation && !confirmed)
    throw new Error("附件数量或体积超过默认限制，必须先在应用内确认。");
}

function progress(
  value: Omit<AttachmentProgress, "schemaVersion">,
): AttachmentProgress {
  return { schemaVersion: 1, ...value };
}

async function digest(bytes: ArrayBuffer): Promise<string> {
  const value = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(value))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function snapshotFile(
  file: File,
  signal: AbortSignal,
  onBytes: (copied: number) => void,
): Promise<ArrayBuffer> {
  const snapshot = new Uint8Array(file.size);
  const reader = file.stream().getReader();
  let offset = 0;
  try {
    while (true) {
      if (signal.aborted) throw new Error("附件导入已取消。");
      const { done, value } = await reader.read();
      if (done) break;
      if (offset + value.byteLength > snapshot.byteLength)
        throw new Error("附件读取长度发生变化。");
      snapshot.set(value, offset);
      offset += value.byteLength;
      onBytes(offset);
    }
  } finally {
    if (signal.aborted) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  if (offset !== snapshot.byteLength) throw new Error("附件读取长度发生变化。");
  return snapshot.buffer;
}

function textOf(name: string, mimeType: string, bytes: ArrayBuffer) {
  const extension = name.split(".").pop()?.toLocaleLowerCase() ?? "";
  if (!mimeType.startsWith("text/") && !textExtensions.has(extension))
    return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export const webAttachmentHost: AttachmentHost = {
  async list(cardId) {
    const rows = await db.attachments.where("cardId").equals(cardId).toArray();
    return rows
      .sort((left, right) => left.createdAt - right.createdAt)
      .map(publicAttachment);
  },

  async preflightFiles(cardId, files) {
    const card = await db.cards.get(cardId);
    if (!card || card.trashed)
      throw new Error("当前卡片不存在或已进入回收站。");
    return preflight(cardId, files);
  },

  async preflightPaths() {
    throw new Error("Web 版不读取桌面文件路径；请使用附件文件选择器。");
  },

  async importFiles(input) {
    assertPreflight(input.preflight, input.confirmed);
    if (input.files.length !== input.preflight.items.length)
      throw new Error("附件预检结果与当前选择不一致，请重新选择。");
    input.files.forEach((file, index) => {
      const candidate = input.preflight.items[index];
      if (
        candidate.name !== (file.name || "attachment") ||
        candidate.byteSize !== file.size ||
        candidate.relativePath !== safeRelativePath(file)
      )
        throw new Error("附件预检结果与当前选择不一致，请重新选择。");
    });
    const rows: WebAttachmentRecord[] = [];
    const chunks: NoteChunk[] = [];
    let completedBytes = 0;
    for (const [index, file] of input.files.entries()) {
      if (input.signal.aborted) throw new Error("附件导入已取消。");
      const candidate = input.preflight.items[index];
      input.onProgress(
        progress({
          jobId: input.preflight.jobId,
          phase: "copying",
          completedCount: index,
          totalCount: input.preflight.totalCount,
          completedBytes,
          totalBytes: input.preflight.totalBytes,
          currentItem: candidate.relativePath,
        }),
      );
      const bytes = await snapshotFile(file, input.signal, (copied) =>
        input.onProgress(
          progress({
            jobId: input.preflight.jobId,
            phase: "copying",
            completedCount: index,
            totalCount: input.preflight.totalCount,
            completedBytes: completedBytes + copied,
            totalBytes: input.preflight.totalBytes,
            currentItem: candidate.relativePath,
          }),
        ),
      );
      if (bytes.byteLength !== candidate.byteSize)
        throw new Error(`附件读取长度发生变化：${candidate.relativePath}`);
      const id = `attachment-${crypto.randomUUID()}`;
      const content =
        bytes.byteLength <= 20 * 1024 * 1024
          ? textOf(candidate.name, file.type, bytes)
          : null;
      const record: WebAttachmentRecord = {
        id,
        cardId: input.preflight.cardId,
        scope: attachmentScope(input.preflight.cardId),
        name: candidate.name,
        relativePath: candidate.relativePath,
        mimeType: file.type || "application/octet-stream",
        byteSize: bytes.byteLength,
        sha256: await digest(bytes),
        indexed: content !== null,
        createdAt: Date.now() + index,
        bytes: bytes.slice(0),
      };
      rows.push(record);
      if (content !== null) {
        input.onProgress(
          progress({
            jobId: input.preflight.jobId,
            phase: "indexing",
            completedCount: index,
            totalCount: input.preflight.totalCount,
            completedBytes,
            totalBytes: input.preflight.totalBytes,
            currentItem: candidate.relativePath,
            itemId: id,
          }),
        );
        chunks.push(
          ...chunkMarkdown({
            libraryId: record.scope,
            documentId: record.id,
            relativePath: record.relativePath,
            content,
            title: record.name,
            updatedAt: record.createdAt,
          }).chunks,
        );
      }
      completedBytes += bytes.byteLength;
      input.onProgress(
        progress({
          jobId: input.preflight.jobId,
          phase: "copying",
          completedCount: index + 1,
          totalCount: input.preflight.totalCount,
          completedBytes,
          totalBytes: input.preflight.totalBytes,
          currentItem: candidate.relativePath,
          itemId: id,
        }),
      );
    }
    if (input.signal.aborted) throw new Error("附件导入已取消。");
    await db.transaction(
      "rw",
      db.attachments,
      db.attachmentChunks,
      async () => {
        await db.attachments.bulkAdd(rows);
        await db.attachmentChunks.bulkAdd(chunks);
      },
    );
    input.onProgress(
      progress({
        jobId: input.preflight.jobId,
        phase: "complete",
        completedCount: rows.length,
        totalCount: rows.length,
        completedBytes,
        totalBytes: completedBytes,
      }),
    );
    return {
      schemaVersion: 1,
      jobId: input.preflight.jobId,
      attachments: rows.map(publicAttachment),
      totalBytes: completedBytes,
    } satisfies AttachmentImportResult;
  },

  async importPaths() {
    throw new Error("Web 版不读取桌面文件路径；请使用附件文件选择器。");
  },

  async cancel() {
    // Web cancellation is owned by the AbortController passed to importFiles.
  },

  async remove(id) {
    await db.transaction(
      "rw",
      db.attachments,
      db.attachmentChunks,
      async () => {
        const chunks = await db.attachmentChunks
          .where("documentId")
          .equals(id)
          .toArray();
        await db.attachmentChunks.bulkDelete(chunks.map((chunk) => chunk.id));
        await db.attachments.delete(id);
      },
    );
  },

  async promote({ projectId, attachmentId }) {
    const record = await db.attachments.get(attachmentId);
    if (!record) throw new Error("附件不存在或已删除。");
    const content = textOf(record.name, record.mimeType, record.bytes);
    if (content === null)
      throw new Error("只有可读取的文本附件可以提升为项目资料。");
    const libraryId = `project-attachments-${projectId}`;
    const documentId = `promoted-${record.id}`;
    const relativePath = `附件提升/${record.id.slice(-8)}-${record.name}.md`;
    const chunked = chunkMarkdown({
      libraryId,
      documentId,
      relativePath,
      content,
      title: record.name,
      updatedAt: Date.now(),
    });
    const now = Date.now();
    await db.transaction(
      "rw",
      [
        db.noteLibraries,
        db.noteDocuments,
        db.noteChunks,
        db.projectNoteLibraries,
        db.attachments,
      ],
      async () => {
        await db.noteLibraries.put({
          id: libraryId,
          name: "项目附件资料库",
          kind: "web-import",
          createdAt: now,
          updatedAt: now,
        });
        const old = await db.noteChunks
          .where("documentId")
          .equals(documentId)
          .toArray();
        await db.noteChunks.bulkDelete(old.map((chunk) => chunk.id));
        await db.noteDocuments.put({
          ...chunked.document,
          content,
        });
        await db.noteChunks.bulkPut(chunked.chunks);
        await db.projectNoteLibraries.put({ projectId, libraryId });
        await db.attachments.put({
          ...record,
          promotedLibraryId: libraryId,
          promotedDocumentId: documentId,
        });
      },
    );
    return publicAttachment({
      ...record,
      promotedLibraryId: libraryId,
      promotedDocumentId: documentId,
    });
  },

  async search(input) {
    const scope = attachmentScope(input.cardId);
    const chunks = await db.attachmentChunks
      .where("libraryId")
      .equals(scope)
      .toArray();
    if (input.query.trim() === "*") {
      const first = new Map<string, NoteChunk>();
      for (const chunk of chunks)
        if (!first.has(chunk.documentId)) first.set(chunk.documentId, chunk);
      return [...first.values()]
        .sort((left, right) =>
          left.relativePath.localeCompare(right.relativePath, "zh-CN"),
        )
        .slice(0, Math.max(1, Math.min(8, input.limit)))
        .map((chunk) => ({
          chunk,
          score: 0,
          snippet: chunk.text.slice(0, 180).replace(/\s+/g, " ").trim(),
        }));
    }
    return rankNoteChunks(chunks, input.query, input.limit);
  },

  async read(input) {
    const scope = attachmentScope(input.cardId);
    const ids = [...new Set(input.chunkIds)].slice(0, 4);
    const rows = await db.attachmentChunks.bulkGet(ids);
    const byId = new Map(
      rows
        .filter((chunk): chunk is NoteChunk => Boolean(chunk))
        .filter((chunk) => chunk.libraryId === scope)
        .map((chunk) => [chunk.id, chunk]),
    );
    return ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
  },

  async resolveCitation({ projectId, citation }) {
    const cardId = citation.libraryId.replace(/^attachment:/, "");
    const card = await db.cards.get(cardId);
    if (!card || card.projectId !== projectId)
      return { state: "missing", reason: "原来源已移除" };
    const record = await db.attachments.get(citation.documentId);
    if (!record || record.cardId !== cardId)
      return { state: "missing", reason: "原来源已移除" };
    const chunks = await db.attachmentChunks
      .where("documentId")
      .equals(record.id)
      .sortBy("ordinal");
    return {
      state: "current",
      chunk: chunks.find((chunk) => chunk.id === citation.chunkId) ?? chunks[0],
    };
  },
};
