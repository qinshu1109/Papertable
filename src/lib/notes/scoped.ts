import { noteLibraries } from "./index";
import { readDesktopNotes, searchDesktopNotes } from "./tauri";
import { isConfidentNoteHit } from "./search";
import type { NoteChunk, NoteHit } from "./types";

const target =
  typeof __PAPERTABLE_TARGET__ === "undefined" ? "web" : __PAPERTABLE_TARGET__;

/**
 * The only entry point used by the Harness tool gate.  Project/library scope
 * is supplied before the model starts and is never accepted from tool JSON.
 */
export async function searchProjectNotes(input: {
  projectId: string;
  libraryIds: string[];
  query: string;
  limit: number;
}): Promise<NoteHit[]> {
  if (!input.libraryIds.length || !input.query.trim()) return [];
  const hits =
    target === "desktop"
      ? await searchDesktopNotes(input.projectId, input.query, input.limit)
      : await noteLibraries.search({
          libraryIds: input.libraryIds,
          query: input.query,
          limit: input.limit,
        });
  return hits.filter((hit) => isConfidentNoteHit(hit, input.query));
}

export async function readProjectNotes(input: {
  projectId: string;
  libraryIds: string[];
  chunkIds: string[];
}): Promise<NoteChunk[]> {
  if (!input.libraryIds.length || !input.chunkIds.length) return [];
  if (target === "desktop")
    return readDesktopNotes(input.projectId, input.chunkIds.slice(0, 4));
  return noteLibraries.read({
    libraryIds: input.libraryIds,
    chunkIds: input.chunkIds.slice(0, 4),
  });
}
