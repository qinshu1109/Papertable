import { noteLibraries } from "./index";
import {
  readDesktopNotes,
  resolveDesktopNoteCitation,
  searchDesktopNotes,
} from "./tauri";
import { resolveWebNoteCitation } from "./web";
import { isConfidentNoteHit } from "./search";
import type {
  NoteCitationLookup,
  NoteCitationResolution,
  NoteChunk,
  NoteHit,
} from "./types";

const target =
  typeof __PAPERTABLE_TARGET__ === "undefined" ? "web" : __PAPERTABLE_TARGET__;

/**
 * The only entry point used by the Harness tool gate.  Project/library scope
 * is supplied before the model starts and is never accepted from tool JSON.
 */
export async function searchProjectNotes(input: {
  runId?: string;
  projectId: string;
  libraryIds: string[];
  query: string;
  limit: number;
}): Promise<NoteHit[]> {
  if (!input.libraryIds.length || !input.query.trim()) return [];
  const hits =
    target === "desktop"
      ? await searchDesktopNotes(
          input.runId ?? "",
          input.projectId,
          input.query,
          input.limit,
        )
      : await noteLibraries.search({
          libraryIds: input.libraryIds,
          query: input.query,
          limit: input.limit,
        });
  if (input.query.trim() === "*") return hits;
  return hits.filter((hit) => isConfidentNoteHit(hit, input.query));
}

export async function readProjectNotes(input: {
  runId?: string;
  projectId: string;
  libraryIds: string[];
  chunkIds: string[];
}): Promise<NoteChunk[]> {
  if (!input.libraryIds.length || !input.chunkIds.length) return [];
  if (target === "desktop")
    return readDesktopNotes(
      input.runId ?? "",
      input.projectId,
      input.chunkIds.slice(0, 4),
    );
  return noteLibraries.read({
    libraryIds: input.libraryIds,
    chunkIds: input.chunkIds.slice(0, 4),
  });
}

/**
 * Used only by the temporary source card. It never promotes a source into a
 * reference or the main conversation; it simply tells the renderer whether a
 * historical citation still points at the current, updated, or unavailable
 * read-only material.
 */
export async function resolveProjectNoteCitation(input: {
  projectId: string;
  citation: NoteCitationLookup;
}): Promise<NoteCitationResolution> {
  if (target === "desktop")
    return resolveDesktopNoteCitation(input.projectId, input.citation);
  return resolveWebNoteCitation(input);
}
