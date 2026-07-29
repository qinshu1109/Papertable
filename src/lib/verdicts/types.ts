export type VerdictType = "tombstone" | "gold";
export type VerdictSourceKind = "edge" | "turn";

export interface VerdictInput {
  projectId: string;
  verdictType: VerdictType;
  sourceKind: VerdictSourceKind;
  sourceId: string;
  sourceCardId?: string;
  sourceTurnId?: string;
  content: string;
  concepts: string[];
}

export interface Verdict {
  id: string;
  projectId: string;
  verdictType: VerdictType;
  sourceKind: VerdictSourceKind;
  sourceId: string;
  sourceCardId?: string;
  sourceTurnId?: string;
  content: string;
  concepts: string[];
  status: "confirmed";
  idempotencyKey: string;
  supersedesMemoryId: string | null;
}

export interface VerdictList {
  /** Only chain tails; this is the safe set for later context injection. */
  verdicts: Verdict[];
  /** Full supersede history for audit. */
  history: Verdict[];
}

export interface VerdictWriteResult {
  verdict: Verdict;
  created: boolean;
}

export interface VerdictHealth {
  available: true;
  cubeId: "papertable-verdicts";
}

export type VerdictResponse<T> =
  | { available: true; data: T }
  | {
      available: false;
      error: { code: string; message: string; detail?: string };
    };

export interface VerdictHost {
  health(): Promise<VerdictResponse<VerdictHealth>>;
  ensureCube(): Promise<VerdictResponse<{ cubeId: string; created: boolean }>>;
  list(
    projectId: string,
    concept?: string,
  ): Promise<VerdictResponse<VerdictList>>;
  confirm(input: VerdictInput): Promise<VerdictResponse<VerdictWriteResult>>;
  supersede(
    memoryId: string,
    input: VerdictInput,
  ): Promise<VerdictResponse<VerdictWriteResult>>;
}
