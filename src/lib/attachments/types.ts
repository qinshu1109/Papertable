import type { NoteChunk, NoteCitationLookup, NoteHit } from "../notes/types";

export const ATTACHMENT_COUNT_LIMIT = 25;
export const ATTACHMENT_BYTE_LIMIT = 50 * 1024 * 1024;
export const ATTACHMENT_HARD_COUNT_LIMIT = 500;
export const ATTACHMENT_HARD_BYTE_LIMIT = 512 * 1024 * 1024;

export interface Attachment {
  id: string;
  cardId: string;
  /** Always `attachment:<cardId>`; persisted so scope mistakes are inspectable. */
  scope: string;
  name: string;
  /** Safe display path only. Desktop absolute source paths are never persisted. */
  relativePath: string;
  mimeType: string;
  byteSize: number;
  sha256: string;
  indexed: boolean;
  createdAt: number;
  promotedLibraryId?: string;
  promotedDocumentId?: string;
}

export interface AttachmentCandidate {
  key: string;
  name: string;
  relativePath: string;
  byteSize: number;
}

export interface AttachmentPreflight {
  schemaVersion: 1;
  jobId: string;
  cardId: string;
  items: AttachmentCandidate[];
  totalCount: number;
  totalBytes: number;
  countLimit: number;
  byteLimit: number;
  requiresConfirmation: boolean;
  issues: string[];
}

export type AttachmentProgressPhase =
  "copying" | "indexing" | "complete" | "cancelled" | "error";

export interface AttachmentProgress {
  schemaVersion: 1;
  jobId: string;
  phase: AttachmentProgressPhase;
  completedCount: number;
  totalCount: number;
  completedBytes: number;
  totalBytes: number;
  currentItem?: string;
  itemId?: string;
  error?: string;
}

export interface AttachmentImportResult {
  schemaVersion: 1;
  jobId: string;
  attachments: Attachment[];
  totalBytes: number;
}

export interface AttachmentSearchInput {
  runId?: string;
  projectId: string;
  cardId: string;
  query: string;
  limit: number;
}

export interface AttachmentReadInput {
  runId?: string;
  projectId: string;
  cardId: string;
  chunkIds: string[];
}

export interface AttachmentCitationResolution {
  state: "current" | "missing";
  chunk?: NoteChunk;
  reason?: string;
}

export interface AttachmentHost {
  list(cardId: string): Promise<Attachment[]>;
  preflightFiles(cardId: string, files: File[]): Promise<AttachmentPreflight>;
  preflightPaths(cardId: string, paths: string[]): Promise<AttachmentPreflight>;
  importFiles(input: {
    preflight: AttachmentPreflight;
    files: File[];
    confirmed: boolean;
    signal: AbortSignal;
    onProgress(progress: AttachmentProgress): void;
  }): Promise<AttachmentImportResult>;
  importPaths(input: {
    preflight: AttachmentPreflight;
    paths: string[];
    confirmed: boolean;
    onProgress(progress: AttachmentProgress): void;
  }): Promise<AttachmentImportResult>;
  cancel(jobId: string): Promise<void>;
  remove(id: string): Promise<void>;
  promote(input: {
    projectId: string;
    attachmentId: string;
  }): Promise<Attachment>;
  search(input: AttachmentSearchInput): Promise<NoteHit[]>;
  read(input: AttachmentReadInput): Promise<NoteChunk[]>;
  resolveCitation(input: {
    projectId: string;
    citation: NoteCitationLookup;
  }): Promise<AttachmentCitationResolution>;
}

export const attachmentScope = (cardId: string) => `attachment:${cardId}`;
