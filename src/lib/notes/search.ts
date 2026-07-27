import MiniSearch from "minisearch";
import type { NoteChunk, NoteHit } from "./types";

type SearchRecord = NoteChunk & {
  title: string;
  tagText: string;
};

/**
 * CJK-friendly tokenization.  Each non-space character is searchable so a
 * phrase such as「唯一事实」does not need spaces to be found.  Latin runs are
 * preserved too, which makes Markdown terms, filenames and code identifiers
 * useful queries without a separate vector index.
 */
export function noteTokens(value: string): string[] {
  const text = value.normalize("NFKC").toLocaleLowerCase();
  const words = text.match(/[\p{L}\p{N}_-]+/gu) ?? [];
  const chars = Array.from(text).filter(
    (char) => /[\p{L}\p{N}]/u.test(char) && !/[a-z0-9]/i.test(char),
  );
  return [...words, ...chars];
}

function normalizedLetters(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
}

function longestSharedRun(left: string, right: string): number {
  if (!left || !right) return 0;
  // Query strings are capped at 100 characters and chunks at 800, so this
  // deliberately simple dynamic-programming check is cheap while keeping the
  // Web Worker and desktop host on the same deterministic confidence rule.
  let previous = new Array<number>(right.length + 1).fill(0);
  let longest = 0;
  for (let row = 1; row <= left.length; row += 1) {
    const current = new Array<number>(right.length + 1).fill(0);
    for (let column = 1; column <= right.length; column += 1) {
      if (left[row - 1] !== right[column - 1]) continue;
      current[column] = previous[column - 1] + 1;
      longest = Math.max(longest, current[column]);
    }
    previous = current;
  }
  return longest;
}

function cjkEvidenceQuery(value: string): string {
  // A model will sometimes pass a whole question to lexical search.  Remove
  // only question scaffolding before judging whether its shared CJK run is
  // meaningful; otherwise「赤霄项目代号是什么」and「内部代号是」share the
  // accidental run「代号是」and look like the same evidence.
  const contentTerms = value
    .normalize("NFKC")
    .replace(
      /资料库(?:里|中)?|笔记(?:里|中)?|(?:没|未)?有出现|没有|未出现|是什么|什么是|为什么|怎么(?:样)?|如何|哪些|是否|请问|[的了吗呢呀啊是在和与或]/g,
      "",
    );
  return (contentTerms.match(/[\u3400-\u9fff]/g) ?? []).join("");
}

/**
 * A lexical search result is a candidate, not automatic evidence.  CJK
 * tokenization intentionally indexes individual characters, which is useful
 * for recall but can otherwise turn a question sharing only「代号」into a false
 * source hit.  The Agent gate keeps a result only when it shares a meaningful
 * contiguous phrase (or an exact Latin/numeric identifier) with the note.
 *
 * This does not decide truth: it only prevents a weak fuzzy candidate from
 * becoming readable material in a strict `sources-only` answer.
 */
export function isConfidentNoteHit(hit: NoteHit, query: string): boolean {
  const haystack = normalizedLetters(
    [
      hit.chunk.relativePath,
      hit.chunk.titlePath.join(" "),
      hit.chunk.tags.join(" "),
      hit.chunk.text,
    ].join("\n"),
  );
  const normalizedQuery = normalizedLetters(query);
  if (!normalizedQuery || !haystack) return false;
  if (haystack.includes(normalizedQuery)) return true;

  const identifiers = query
    .normalize("NFKC")
    .toLocaleLowerCase()
    .match(/[a-z0-9][a-z0-9_-]{2,}/g);
  if (
    identifiers?.some((identifier) =>
      haystack.includes(normalizedLetters(identifier)),
    )
  )
    return true;

  const cjkQuery = cjkEvidenceQuery(query);
  const cjkHaystack = (haystack.match(/[\u3400-\u9fff]/g) ?? []).join("");
  if (!cjkQuery) return false;
  if (cjkQuery.length <= 2) return cjkHaystack.includes(cjkQuery);
  return longestSharedRun(cjkQuery, cjkHaystack) >= 3;
}

function record(chunk: NoteChunk): SearchRecord {
  return {
    ...chunk,
    title: chunk.titlePath.join(" / "),
    tagText: chunk.tags.join(" "),
  };
}

/** Shared by the worker and Node tests; the worker is what calls it in UI. */
export function rankNoteChunks(
  chunks: NoteChunk[],
  query: string,
  limit: number,
): NoteHit[] {
  const normalized = query.trim();
  if (!normalized || !chunks.length) return [];
  const index = new MiniSearch<SearchRecord>({
    fields: ["text", "title", "tagText", "relativePath"],
    storeFields: [
      "id",
      "libraryId",
      "documentId",
      "documentVersionHash",
      "relativePath",
      "titlePath",
      "tags",
      "ordinal",
      "start",
      "end",
      "text",
    ],
    tokenize: noteTokens,
    processTerm: (term) => term,
    searchOptions: { prefix: true, fuzzy: 0.12 },
  });
  index.addAll(chunks.map(record));
  const results = index.search(normalized, {
    prefix: true,
    fuzzy: 0.12,
    combineWith: "OR",
  });
  const byId = new Map(chunks.map((chunk) => [chunk.id, chunk]));
  const needle = normalized.toLocaleLowerCase();
  const max = Math.max(1, Math.min(8, Math.floor(limit) || 4));
  return results
    .map((result) => {
      const chunk = byId.get(String(result.id));
      if (!chunk) return null;
      const at = chunk.text.toLocaleLowerCase().indexOf(needle);
      const start = at >= 0 ? Math.max(0, at - 54) : 0;
      const end =
        at >= 0 ? Math.min(chunk.text.length, at + needle.length + 140) : 180;
      return {
        chunk,
        // Exact source text gets a deterministic lift over mere token overlap.
        score: result.score + (at >= 0 ? 8 : 0),
        snippet: chunk.text.slice(start, end).replace(/\s+/g, " ").trim(),
      } satisfies NoteHit;
    })
    .filter((hit): hit is NoteHit => hit !== null)
    .sort((a, b) => b.score - a.score || a.chunk.ordinal - b.chunk.ordinal)
    .slice(0, max);
}
