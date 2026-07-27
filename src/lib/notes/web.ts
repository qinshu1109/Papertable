import { chunkMarkdown, MAX_NOTE_DOCUMENT_BYTES } from "./chunk";
import { rankNoteChunks } from "./search";
import type {
  BoundNoteRead,
  BoundNoteSearch,
  IndexIssue,
  IndexReport,
  NoteCitationLookup,
  NoteCitationResolution,
  NoteChunk,
  NoteHit,
  NoteImportInput,
  NoteLibrary,
  NoteLibraryAdapter,
} from "./types";
import type { NoteLibraryHost } from "./host";
import {
  db,
  type NoteDocumentRecord,
  type ProjectNoteLibraryRecord,
} from "../storage/dexie";

let worker: Worker | null = null;
let workerRequest = 0;
const pendingWorkers = new Map<
  string,
  { resolve: (hits: NoteHit[]) => void; reject: (cause: Error) => void }
>();

function searchWorker(): Worker | null {
  if (typeof Worker === "undefined") return null;
  if (worker) return worker;
  worker = new Worker(new URL("./search.worker.ts", import.meta.url), {
    type: "module",
  });
  worker.onmessage = (
    event: MessageEvent<{ id: string; hits?: NoteHit[]; error?: string }>,
  ) => {
    const pending = pendingWorkers.get(event.data.id);
    if (!pending) return;
    pendingWorkers.delete(event.data.id);
    if (event.data.error) pending.reject(new Error(event.data.error));
    else pending.resolve(event.data.hits ?? []);
  };
  worker.onerror = () => {
    for (const pending of pendingWorkers.values())
      pending.reject(new Error("资料库索引 Worker 已停止。"));
    pendingWorkers.clear();
    worker?.terminate();
    worker = null;
  };
  return worker;
}

function workerRank(
  chunks: NoteChunk[],
  query: string,
  limit: number,
): Promise<NoteHit[]> {
  const instance = searchWorker();
  if (!instance) return Promise.resolve(rankNoteChunks(chunks, query, limit));
  const id = `note-search-${++workerRequest}`;
  return new Promise<NoteHit[]>((resolve, reject) => {
    pendingWorkers.set(id, { resolve, reject });
    instance.postMessage({ id, chunks, query, limit });
  });
}

let chunkWorker: Worker | null = null;
let chunkWorkerRequest = 0;
const pendingChunkWorkers = new Map<
  string,
  {
    resolve: (documents: ReturnType<typeof chunkMarkdown>[]) => void;
    reject: (cause: Error) => void;
  }
>();

function documentChunkWorker(): Worker | null {
  if (typeof Worker === "undefined") return null;
  if (chunkWorker) return chunkWorker;
  chunkWorker = new Worker(new URL("./chunk.worker.ts", import.meta.url), {
    type: "module",
  });
  chunkWorker.onmessage = (
    event: MessageEvent<{
      id: string;
      documents?: ReturnType<typeof chunkMarkdown>[];
      error?: string;
    }>,
  ) => {
    const pending = pendingChunkWorkers.get(event.data.id);
    if (!pending) return;
    pendingChunkWorkers.delete(event.data.id);
    if (event.data.error) pending.reject(new Error(event.data.error));
    else pending.resolve(event.data.documents ?? []);
  };
  chunkWorker.onerror = () => {
    for (const pending of pendingChunkWorkers.values())
      pending.reject(new Error("资料库切块 Worker 已停止。"));
    pendingChunkWorkers.clear();
    chunkWorker?.terminate();
    chunkWorker = null;
  };
  return chunkWorker;
}

function chunkDocumentsInWorker(
  inputs: Parameters<typeof chunkMarkdown>[0][],
): Promise<ReturnType<typeof chunkMarkdown>[]> {
  const instance = documentChunkWorker();
  if (!instance) return Promise.resolve(inputs.map(chunkMarkdown));
  const id = `note-chunk-${++chunkWorkerRequest}`;
  return new Promise((resolve, reject) => {
    pendingChunkWorkers.set(id, { resolve, reject });
    instance.postMessage({ id, inputs });
  });
}

function safePath(path: string): string | null {
  const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "");
  if (
    !normalized ||
    normalized.split("/").some((part) => !part || part === "..")
  )
    return null;
  return normalized;
}

function report(
  libraryId: string,
  documents: number,
  chunks: number,
  skipped: number,
  issues: IndexIssue[] = [],
): IndexReport {
  return {
    libraryId,
    documents,
    chunks,
    skipped,
    issues,
    updatedAt: Date.now(),
  };
}

export class WebNoteLibraryAdapter implements NoteLibraryAdapter {
  async listLibraries(): Promise<NoteLibrary[]> {
    return db.noteLibraries.orderBy("updatedAt").reverse().toArray();
  }

  async importFiles(input: NoteImportInput): Promise<IndexReport> {
    const issues: IndexIssue[] = [];
    const valid = input.files.flatMap((file) => {
      const relativePath = safePath(file.relativePath);
      if (!relativePath || !/\.md(?:own)?$/i.test(relativePath)) return [];
      if (
        new TextEncoder().encode(file.content).byteLength >
        MAX_NOTE_DOCUMENT_BYTES
      ) {
        issues.push({
          relativePath,
          code: "too-large",
          message: "文件超过 20 MiB，已跳过并移除旧索引。",
        });
        return [];
      }
      return [{ file, relativePath }];
    });
    const skipped = input.files.length - valid.length;
    const chunkedDocuments = await chunkDocumentsInWorker(
      valid.map(({ file, relativePath }) => ({
        libraryId: input.library.id,
        relativePath,
        content: file.content,
        updatedAt: file.modifiedAt ?? Date.now(),
      })),
    );
    const documents: NoteDocumentRecord[] = [];
    const chunks: NoteChunk[] = [];
    for (const [index, chunked] of chunkedDocuments.entries()) {
      const file = valid[index].file;
      documents.push({ ...chunked.document, content: file.content });
      chunks.push(...chunked.chunks);
    }
    const updatedAt = Date.now();
    await db.transaction(
      "rw",
      [db.noteLibraries, db.noteDocuments, db.noteChunks],
      async () => {
        const oldDocs = await db.noteDocuments
          .where("libraryId")
          .equals(input.library.id)
          .toArray();
        const oldChunks = await db.noteChunks
          .where("libraryId")
          .equals(input.library.id)
          .toArray();
        await db.noteChunks.bulkDelete(oldChunks.map((chunk) => chunk.id));
        await db.noteDocuments.bulkDelete(
          oldDocs.map((document) => document.id),
        );
        await db.noteLibraries.put({ ...input.library, updatedAt });
        await db.noteDocuments.bulkPut(documents);
        await db.noteChunks.bulkPut(chunks);
      },
    );
    return report(
      input.library.id,
      documents.length,
      chunks.length,
      skipped,
      issues,
    );
  }

  async search(input: BoundNoteSearch): Promise<NoteHit[]> {
    const libraryIds = [...new Set(input.libraryIds)].filter(Boolean);
    if (!libraryIds.length || !input.query.trim()) return [];
    const chunks = await db.noteChunks
      .where("libraryId")
      .anyOf(libraryIds)
      .toArray();
    if (input.query.trim() === "*") {
      const firstByDocument = new Map<string, NoteChunk>();
      for (const chunk of chunks) {
        const previous = firstByDocument.get(chunk.documentId);
        if (!previous || chunk.ordinal < previous.ordinal)
          firstByDocument.set(chunk.documentId, chunk);
      }
      return [...firstByDocument.values()]
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
    return workerRank(
      chunks,
      input.query,
      Math.max(1, Math.min(8, input.limit)),
    );
  }

  async read(input: BoundNoteRead): Promise<NoteChunk[]> {
    const allowedLibraries = new Set(input.libraryIds);
    const ids = [...new Set(input.chunkIds)].slice(0, 4);
    if (!ids.length || !allowedLibraries.size) return [];
    const rows = await db.noteChunks.bulkGet(ids);
    const byId = new Map(
      rows
        .filter((chunk): chunk is NoteChunk => Boolean(chunk))
        .filter((chunk) => allowedLibraries.has(chunk.libraryId))
        .map((chunk) => [chunk.id, chunk]),
    );
    return ids.flatMap((id) => {
      const chunk = byId.get(id);
      return chunk ? [chunk] : [];
    });
  }

  async removeLibrary(id: string): Promise<void> {
    await db.transaction(
      "rw",
      [
        db.noteLibraries,
        db.noteDocuments,
        db.noteChunks,
        db.projectNoteLibraries,
      ],
      async () => {
        const [documents, chunks, bindings] = await Promise.all([
          db.noteDocuments.where("libraryId").equals(id).toArray(),
          db.noteChunks.where("libraryId").equals(id).toArray(),
          db.projectNoteLibraries.where("libraryId").equals(id).toArray(),
        ]);
        await db.noteChunks.bulkDelete(chunks.map((chunk) => chunk.id));
        await db.noteDocuments.bulkDelete(
          documents.map((document) => document.id),
        );
        await db.projectNoteLibraries.bulkDelete(
          bindings.map((binding) => [binding.projectId, binding.libraryId]),
        );
        await db.noteLibraries.delete(id);
      },
    );
  }

  async rebuild(id: string): Promise<IndexReport> {
    const [library, documents] = await Promise.all([
      db.noteLibraries.get(id),
      db.noteDocuments.where("libraryId").equals(id).toArray(),
    ]);
    if (!library) throw new Error("资料库不存在。\n");
    return this.importFiles({
      library,
      files: documents.map((document) => ({
        relativePath: document.relativePath,
        content: document.content,
        modifiedAt: document.updatedAt,
      })),
    });
  }
}

export const webNoteLibrary = new WebNoteLibraryAdapter();

/** Project bindings are host state, not model-supplied tool input. */
export async function webProjectLibraryIds(
  projectId: string,
): Promise<string[]> {
  const bindings = await db.projectNoteLibraries
    .where("projectId")
    .equals(projectId)
    .toArray();
  return bindings.map((binding) => binding.libraryId);
}

export async function webSetProjectLibraries(
  projectId: string,
  libraryIds: string[],
): Promise<void> {
  const unique = [...new Set(libraryIds)].filter(Boolean);
  await db.transaction("rw", db.projectNoteLibraries, async () => {
    const old = await db.projectNoteLibraries
      .where("projectId")
      .equals(projectId)
      .toArray();
    await db.projectNoteLibraries.bulkDelete(
      old.map((binding) => [binding.projectId, binding.libraryId]),
    );
    const next: ProjectNoteLibraryRecord[] = unique.map((libraryId) => ({
      projectId,
      libraryId,
    }));
    await db.projectNoteLibraries.bulkPut(next);
  });
}

/**
 * Web imports are immutable local copies, but historical citations still need
 * the same four-way answer as desktop: current, updated, missing, or no
 * longer available to this project. Do not use `chunkId` as the sole key:
 * re-indexing changes it whenever the document hash changes.
 */
export async function resolveWebNoteCitation(input: {
  projectId: string;
  citation: NoteCitationLookup;
}): Promise<NoteCitationResolution> {
  const binding = await db.projectNoteLibraries.get([
    input.projectId,
    input.citation.libraryId,
  ]);
  const library = await db.noteLibraries.get(input.citation.libraryId);
  if (!binding || !library) {
    return {
      state: "library-unavailable",
      reason: binding
        ? "这个资料库当前不可用。"
        : "这个资料库未绑定到当前项目。",
    };
  }
  const document = await db.noteDocuments.get(input.citation.documentId);
  if (
    !document ||
    document.libraryId !== input.citation.libraryId ||
    document.relativePath !== input.citation.relativePath
  ) {
    return {
      state: "missing",
      reason: "原笔记已删除或不再位于该资料库。",
    };
  }
  const chunks = await db.noteChunks
    .where("documentId")
    .equals(document.id)
    .sortBy("ordinal");
  const current =
    chunks.find((chunk) => chunk.id === input.citation.chunkId) ??
    chunks.find(
      (chunk) =>
        Boolean(input.citation.excerpt) &&
        chunk.text.includes(input.citation.excerpt ?? ""),
    ) ??
    chunks[0];
  return {
    state:
      document.versionHash === input.citation.documentHash
        ? "current"
        : "updated",
    chunk: current,
  };
}

/** Used by full local backup, not ordinary project exports. */
export async function webExportNoteLibraryData(): Promise<{
  libraries: NoteLibrary[];
  documents: NoteDocumentRecord[];
  chunks: NoteChunk[];
  bindings: ProjectNoteLibraryRecord[];
}> {
  const [libraries, documents, chunks, bindings] = await Promise.all([
    db.noteLibraries.toArray(),
    db.noteDocuments.toArray(),
    db.noteChunks.toArray(),
    db.projectNoteLibraries.toArray(),
  ]);
  return { libraries, documents, chunks, bindings };
}

export async function webImportNoteLibraryData(input: {
  libraries: NoteLibrary[];
  documents: NoteDocumentRecord[];
  chunks: NoteChunk[];
  bindings: ProjectNoteLibraryRecord[];
}): Promise<void> {
  await db.transaction(
    "rw",
    [
      db.noteLibraries,
      db.noteDocuments,
      db.noteChunks,
      db.projectNoteLibraries,
    ],
    async () => {
      await db.noteLibraries.clear();
      await db.noteDocuments.clear();
      await db.noteChunks.clear();
      await db.projectNoteLibraries.clear();
      await db.noteLibraries.bulkPut(input.libraries);
      await db.noteDocuments.bulkPut(input.documents);
      await db.noteChunks.bulkPut(input.chunks);
      await db.projectNoteLibraries.bulkPut(input.bindings);
    },
  );
}

export const webNoteLibraryHost: NoteLibraryHost = {
  listLibraries: () => webNoteLibrary.listLibraries(),
  importFiles: (input) => webNoteLibrary.importFiles(input),
  search: (input) => webNoteLibrary.search(input),
  read: (input) => webNoteLibrary.read(input),
  removeLibrary: (id) => webNoteLibrary.removeLibrary(id),
  rebuild: (id) => webNoteLibrary.rebuild(id),
  projectLibraryIds: webProjectLibraryIds,
  setProjectLibraries: webSetProjectLibraries,
};
