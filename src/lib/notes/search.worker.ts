/// <reference lib="webworker" />
import { rankNoteChunks } from "./search";
import type { NoteChunk } from "./types";

type SearchRequest = {
  id: string;
  chunks: NoteChunk[];
  query: string;
  limit: number;
};

self.onmessage = (event: MessageEvent<SearchRequest>) => {
  const { id, chunks, query, limit } = event.data;
  try {
    const hits = rankNoteChunks(chunks, query, limit);
    self.postMessage({ id, hits });
  } catch (cause) {
    self.postMessage({
      id,
      error: cause instanceof Error ? cause.message : "资料库索引失败。",
    });
  }
};

export {};
