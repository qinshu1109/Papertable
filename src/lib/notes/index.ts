import { tauriNoteLibraryHost } from "./tauri";
import { webExportNoteLibraryData, webNoteLibraryHost } from "./web";
import type { NoteCorpusBackup } from "../backup";

export * from "./types";
export * from "./host";
export { chunkMarkdown, noteContentHash, noteDocumentId } from "./chunk";
export {
  connectDesktopVault,
  readDesktopNotes,
  searchDesktopNotes,
} from "./tauri";

// See provider/index.ts: TypeScript unit tests do not pass through Vite's
// compile-time target replacement.  The web host is the safe no-side-effect
// fallback there; packaged builds still use their literal target.
const target =
  typeof __PAPERTABLE_TARGET__ === "undefined" ? "web" : __PAPERTABLE_TARGET__;

export const noteLibraries =
  target === "desktop" ? tauriNoteLibraryHost : webNoteLibraryHost;

/** Whole-library backup retains Web imports; desktop Vault data remains rebuildable. */
export async function exportNoteCorpusForBackup(): Promise<
  NoteCorpusBackup | undefined
> {
  if (target !== "web") return undefined;
  const data = await webExportNoteLibraryData();
  return {
    libraries: data.libraries,
    documents: data.documents.map((document) => ({
      id: document.id,
      libraryId: document.libraryId,
      relativePath: document.relativePath,
      content: document.content,
      updatedAt: document.updatedAt,
    })),
    bindings: data.bindings,
  };
}

/** Replays durable imported source documents through the active host adapter. */
export async function importNoteCorpusFromBackup(
  corpus: NoteCorpusBackup | undefined,
): Promise<void> {
  if (!corpus) return;
  // Imported Markdown source is the durable portable form.  Chunk IDs are
  // deterministic for a library/path/content triple, so replaying it preserves
  // citations while allowing each host to build its own local index.
  for (const library of corpus.libraries) {
    const documents = corpus.documents.filter(
      (document) => document.libraryId === library.id,
    );
    if (!documents.length) continue;
    await noteLibraries.importFiles({
      library,
      files: documents.map((document) => ({
        relativePath: document.relativePath,
        content: document.content,
        modifiedAt: document.updatedAt,
      })),
    });
  }
  const byProject = new Map<string, string[]>();
  for (const binding of corpus.bindings) {
    const list = byProject.get(binding.projectId) ?? [];
    list.push(binding.libraryId);
    byProject.set(binding.projectId, list);
  }
  for (const [projectId, libraryIds] of byProject)
    await noteLibraries.setProjectLibraries(projectId, libraryIds);
}
