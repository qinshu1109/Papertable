import { Channel, invoke } from "@tauri-apps/api/core";
import type { NoteChunk, NoteHit } from "../notes/types";
import type {
  Attachment,
  AttachmentCitationResolution,
  AttachmentHost,
  AttachmentImportResult,
  AttachmentPreflight,
  AttachmentProgress,
} from "./types";

export const tauriAttachmentHost: AttachmentHost = {
  list: (cardId) => invoke<Attachment[]>("attachment_list", { cardId }),

  preflightFiles: async () => {
    throw new Error("桌面版文件拖放由 Tauri 路径预检处理。");
  },

  preflightPaths: (cardId, paths) =>
    invoke<AttachmentPreflight>("attachment_preflight", { cardId, paths }),

  importFiles: async () => {
    throw new Error("桌面版文件导入由 Tauri 路径快照处理。");
  },

  importPaths: async ({ preflight, paths, confirmed, onProgress }) => {
    const progress = new Channel<AttachmentProgress>();
    progress.onmessage = onProgress;
    return invoke<AttachmentImportResult>("attachment_import", {
      request: {
        jobId: preflight.jobId,
        cardId: preflight.cardId,
        paths,
        confirmed,
      },
      progress,
    });
  },

  cancel: (jobId) => invoke<void>("attachment_cancel_import", { jobId }),
  remove: (id) => invoke<void>("attachment_remove", { id }),
  promote: ({ projectId, attachmentId }) =>
    invoke<Attachment>("attachment_promote", { projectId, attachmentId }),
  search: (input) =>
    invoke<NoteHit[]>("attachment_search", {
      runId: input.runId ?? "",
      projectId: input.projectId,
      cardId: input.cardId,
      query: input.query,
      limit: input.limit,
    }),
  read: (input) =>
    invoke<NoteChunk[]>("attachment_read", {
      runId: input.runId ?? "",
      projectId: input.projectId,
      cardId: input.cardId,
      chunkIds: input.chunkIds,
    }),
  resolveCitation: ({ projectId, citation }) =>
    invoke<AttachmentCitationResolution>("attachment_resolve_citation", {
      projectId,
      citation,
    }),
};
