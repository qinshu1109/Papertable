import { noteLibraries } from "./index";
import {
  readDesktopNotes,
  resolveDesktopNoteCitation,
  searchDesktopNotes,
} from "./tauri";
import { resolveWebNoteCitation } from "./web";
import { isConfidentNoteHit } from "./search";
import { attachments } from "../attachments";
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
  attachmentCardId?: string;
  query: string;
  limit: number;
}): Promise<NoteHit[]> {
  if (!input.query.trim()) return [];
  const [attachmentHits, noteHits] = await Promise.all([
    input.attachmentCardId
      ? attachments.search({
          runId: input.runId,
          projectId: input.projectId,
          cardId: input.attachmentCardId,
          query: input.query,
          limit: input.limit,
        })
      : Promise.resolve([]),
    input.libraryIds.length
      ? target === "desktop"
        ? searchDesktopNotes(
            input.runId ?? "",
            input.projectId,
            input.query,
            input.limit,
          )
        : noteLibraries.search({
            libraryIds: input.libraryIds,
            query: input.query,
            limit: input.limit,
          })
      : Promise.resolve([]),
  ]);
  const hits = [...attachmentHits, ...noteHits];
  const unique = [
    ...new Map(hits.map((hit) => [hit.chunk.id, hit])).values(),
  ].slice(0, Math.max(1, Math.min(8, input.limit)));
  if (input.query.trim() === "*") return unique;
  return unique.filter((hit) => isConfidentNoteHit(hit, input.query));
}

export async function readProjectNotes(input: {
  runId?: string;
  projectId: string;
  libraryIds: string[];
  attachmentCardId?: string;
  chunkIds: string[];
}): Promise<NoteChunk[]> {
  if (!input.chunkIds.length) return [];
  const requested = [...new Set(input.chunkIds)].slice(0, 4);
  const attachmentIds = requested.filter((id) => id.startsWith("attachment-"));
  const noteIds = requested.filter((id) => !id.startsWith("attachment-"));
  const [attachmentChunks, noteChunks] = await Promise.all([
    input.attachmentCardId && attachmentIds.length
      ? attachments.read({
          runId: input.runId,
          projectId: input.projectId,
          cardId: input.attachmentCardId,
          chunkIds: attachmentIds,
        })
      : Promise.resolve([]),
    input.libraryIds.length && noteIds.length
      ? target === "desktop"
        ? readDesktopNotes(input.runId ?? "", input.projectId, noteIds)
        : noteLibraries.read({
            libraryIds: input.libraryIds,
            chunkIds: noteIds,
          })
      : Promise.resolve([]),
  ]);
  const byId = new Map(
    [...attachmentChunks, ...noteChunks].map((chunk) => [chunk.id, chunk]),
  );
  return requested.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
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
  if (input.citation.libraryId.startsWith("attachment:"))
    return attachments.resolveCitation({
      projectId: input.projectId,
      citation: input.citation,
    });
  if (target === "desktop")
    return resolveDesktopNoteCitation(input.projectId, input.citation);
  return resolveWebNoteCitation(input);
}
