import { chunkMarkdown } from "./chunk";
import { rankNoteChunks } from "./search";
import type {
  BoundNoteRead,
  BoundNoteSearch,
  IndexReport,
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
): IndexReport {
  return { libraryId, documents, chunks, skipped, updatedAt: Date.now() };
}

export class WebNoteLibraryAdapter implements NoteLibraryAdapter {
  async listLibraries(): Promise<NoteLibrary[]> {
    return db.noteLibraries.orderBy("updatedAt").reverse().toArray();
  }

  async importFiles(input: NoteImportInput): Promise<IndexReport> {
    const valid = input.files.filter(
      (file) =>
        safePath(file.relativePath) && /\.md(?:own)?$/i.test(file.relativePath),
    );
    const skipped = input.files.length - valid.length;
    const documents: NoteDocumentRecord[] = [];
    const chunks: NoteChunk[] = [];
    for (const file of valid) {
      const relativePath = safePath(file.relativePath)!;
      const chunked = chunkMarkdown({
        libraryId: input.library.id,
        relativePath,
        content: file.content,
        updatedAt: file.modifiedAt ?? Date.now(),
      });
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
    return report(input.library.id, documents.length, chunks.length, skipped);
  }

  async search(input: BoundNoteSearch): Promise<NoteHit[]> {
    const libraryIds = [...new Set(input.libraryIds)].filter(Boolean);
    if (!libraryIds.length || !input.query.trim()) return [];
    const chunks = await db.noteChunks
      .where("libraryId")
      .anyOf(libraryIds)
      .toArray();
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
