import { chunkMarkdown } from "./chunk";
import type { ChunkMarkdownInput, ChunkedNoteDocument } from "./types";

type Request = {
  id: string;
  inputs: ChunkMarkdownInput[];
};

type Response =
  | { id: string; documents: ChunkedNoteDocument[] }
  | { id: string; error: string };

self.onmessage = (event: MessageEvent<Request>) => {
  try {
    const documents = event.data.inputs.map(chunkMarkdown);
    (self as DedicatedWorkerGlobalScope).postMessage({
      id: event.data.id,
      documents,
    } satisfies Response);
  } catch (cause) {
    (self as DedicatedWorkerGlobalScope).postMessage({
      id: event.data.id,
      error: cause instanceof Error ? cause.message : "资料库切块失败。",
    } satisfies Response);
  }
};
