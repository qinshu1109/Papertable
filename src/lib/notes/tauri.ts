import { invoke } from "@tauri-apps/api/core";
import type { NoteLibraryHost } from "./host";
import type {
  BoundNoteRead,
  BoundNoteSearch,
  IndexReport,
  NoteCitationLookup,
  NoteCitationResolution,
  NoteChunk,
  NoteHit,
  NoteImportInput,
  NoteLibrary,
  ResolvedNoteScope,
} from "./types";

/**
 * Desktop note queries never send a path or a library scope.  Rust resolves
 * the project binding inside one SQLite transaction, so a model only gets to
 * influence the text query / chunk ids after the host has frozen its scope.
 */
export const tauriNoteLibraryHost: NoteLibraryHost = {
  listLibraries: () => invoke<NoteLibrary[]>("note_library_list"),
  importFiles: (input: NoteImportInput) =>
    invoke<IndexReport>("note_library_import", { input }),
  search: (input: BoundNoteSearch) =>
    // This lower-level method is only used by pure code/tests.  The agent
    // always calls the project-bound helper below via `searchForProject`.
    invoke<NoteHit[]>("note_library_search", {
      projectId: "",
      query: input.query,
      limit: input.limit,
    }),
  read: (input: BoundNoteRead) =>
    invoke<NoteChunk[]>("note_library_read", {
      projectId: "",
      chunkIds: input.chunkIds,
    }),
  removeLibrary: (id) => invoke<void>("note_library_remove", { id }),
  rebuild: (id) => invoke<IndexReport>("note_library_rebuild", { id }),
  projectLibraryIds: (projectId) =>
    invoke<string[]>("note_library_project_bindings", { projectId }),
  setProjectLibraries: (projectId, libraryIds) =>
    invoke<void>("note_library_bind_project", { projectId, libraryIds }),
};

export function connectDesktopVault(vault: string): Promise<NoteLibrary> {
  return invoke<NoteLibrary>("note_library_connect_vault", { vault });
}

/** Host-only helpers that preserve the Rust-side fixed binding. */
export function searchDesktopNotes(
  projectId: string,
  query: string,
  limit: number,
): Promise<NoteHit[]> {
  return invoke<NoteHit[]>("note_library_search", { projectId, query, limit });
}

export function readDesktopNotes(
  projectId: string,
  chunkIds: string[],
): Promise<NoteChunk[]> {
  return invoke<NoteChunk[]>("note_library_read", { projectId, chunkIds });
}

/** Safe public scope status: includes IDs and reasons, never a Vault root path. */
export function desktopProjectNoteScope(
  projectId: string,
): Promise<ResolvedNoteScope> {
  return invoke<ResolvedNoteScope>("note_library_project_scope", { projectId });
}

/**
 * Historical citations resolve through documentId + relativePath, not only an
 * old chunk id. That is what makes “source updated” distinct from “missing”.
 */
export function resolveDesktopNoteCitation(
  projectId: string,
  citation: NoteCitationLookup,
): Promise<NoteCitationResolution> {
  return invoke<NoteCitationResolution>("note_library_resolve_citation", {
    projectId,
    citation,
  });
}
