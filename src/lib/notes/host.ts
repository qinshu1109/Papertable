import type { NoteLibraryAdapter } from "./types";

/**
 * The model never receives this interface.  It is purely host/UI state for
 * binding a project to a fixed set of read-only libraries before an Agent run.
 */
export interface NoteLibraryHost extends NoteLibraryAdapter {
  projectLibraryIds(projectId: string): Promise<string[]>;
  setProjectLibraries(projectId: string, libraryIds: string[]): Promise<void>;
}
