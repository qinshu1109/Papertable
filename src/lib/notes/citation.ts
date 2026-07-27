import type { NoteCitation } from "../../types";
import type { NoteChunk } from "./types";

const marker = /\[\[source:([^\]\s]+)\]\]/g;

/**
 * A model may only cite one of the chunks the tool gate actually returned.
 * Unknown/guessed ids are stripped rather than becoming a misleading link.
 */
export function collectControlledCitations(input: {
  content: string;
  readChunks: NoteChunk[];
}): { content: string; citations: NoteCitation[] } {
  const byId = new Map(input.readChunks.map((chunk) => [chunk.id, chunk]));
  const used = new Set<string>();
  const citations: NoteCitation[] = [];
  const content = input.content.replace(marker, (_all, id: string) => {
    const chunk = byId.get(id);
    if (!chunk) return "";
    if (!used.has(id)) {
      used.add(id);
      citations.push({
        chunkId: chunk.id,
        libraryId: chunk.libraryId,
        documentId: chunk.documentId,
        title:
          chunk.titlePath[chunk.titlePath.length - 1] ?? chunk.relativePath,
        relativePath: chunk.relativePath,
        documentHash: chunk.documentVersionHash,
        excerpt: chunk.text.slice(0, 360),
      });
    }
    return "";
  });
  return { content: content.replace(/[ \t]+\n/g, "\n").trim(), citations };
}
