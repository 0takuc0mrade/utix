/**
 * Types for the duplicate-transaction-scanner feature slice.
 *
 * The scanner accepts a batch of transaction hashes, fetches each one from
 * Horizon, computes a deterministic fingerprint, and groups transactions that
 * share the same fingerprint as candidate duplicates.
 *
 * Each candidate group then flows through a lightweight review workflow:
 * a reviewer confirms (marks the group as a real duplicate), dismisses
 * (marks the transactions as distinct despite the matching fingerprint) or
 * defers (skips for now). Confirm and dismiss are terminal; defer is
 * reversible on re-scan.
 */

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

export type DuplicateScanErrorCode =
  /** The input textarea was empty or contained only whitespace. */
  | "empty_input"
  /** More than MAX_HASHES hashes were supplied. */
  | "too_many_hashes"
  /** One or more of the supplied values is not a valid 64-hex-char hash. */
  | "invalid_hash"
  /** Horizon returned 404 for one of the hashes. */
  | "not_found"
  /** Horizon returned HTTP 429. */
  | "rate_limited"
  /** Any non-404, non-429 Horizon error. */
  | "request_failed"
  /** A review action was attempted on a group whose current state does not
   *  allow that transition. */
  | "invalid_transition";

// ---------------------------------------------------------------------------
// Core domain types
// ---------------------------------------------------------------------------

/**
 * The lifecycle states a candidate group can be in.
 * - pending: newly detected, not yet reviewed
 * - confirmed: reviewer confirmed these are real duplicates
 * - dismissed: reviewer marked as distinct (false positive)
 * - deferred: reviewer skipped; will re-appear on the next scan
 */
export type CandidateGroupState = "pending" | "confirmed" | "dismissed" | "deferred";

/** The three review actions a user can take on a pending or deferred group. */
export type ReviewAction = "confirm" | "dismiss" | "defer";

/** A single transaction fetched from Horizon with the fields needed for
 *  fingerprinting. */
export interface FetchedTransaction {
  hash: string;
  sourceAccount: string;
  /** In stroops, as the string Horizon returns. */
  feeCharged: string;
  memoType: string;
  /** The memo value, empty string if none. */
  memo: string;
  /** ISO-8601 string. */
  createdAt: string;
  /** Operation type strings, sorted lexicographically. */
  operationTypes: string[];
  ledger: number;
  successful: boolean;
}

/**
 * The pre-image that was hashed, plus the resulting hex digest.
 * Storing the pre-image fields makes it easy to explain to a reviewer
 * exactly *why* two transactions were grouped together.
 */
export interface DuplicateFingerprint {
  /** Hex SHA-256 digest of the canonical JSON pre-image. */
  value: string;
  sourceAccount: string;
  opTypesSorted: string[];
  feeCharged: string;
  memoType: string;
  memo: string;
  network: string;
  /** Unix time / TIME_BUCKET_SECONDS (300 s = 5-minute windows). */
  timeBucket: number;
}

/** A group of 2+ transactions that share the same fingerprint. */
export interface CandidateGroup {
  /** Equal to fingerprint.value — stable across re-scans. */
  id: string;
  fingerprint: DuplicateFingerprint;
  transactions: FetchedTransaction[];
  state: CandidateGroupState;
  /** ISO-8601 instant of the last review action, if any. */
  reviewedAt?: string;
  /** Actor id of the reviewer (opaque string supplied by the caller). */
  reviewedBy?: string;
  /** Optional stable reason token supplied by the reviewer. */
  reviewReason?: string;
}

/** Top-level result returned after a full scan. */
export interface DuplicateScanResult {
  scannedCount: number;
  /** How many groups have 2+ matching transactions. */
  groupCount: number;
  /** Only groups with 2+ transactions — singletons are filtered out. */
  groups: CandidateGroup[];
  network: string;
  /** ISO-8601 instant. */
  scannedAt: string;
}

/** Validated input after schema parsing. */
export interface DuplicateScanInput {
  hashes: string[];
  network: string;
}

/** Parameters for a single review action. */
export interface ReviewInput {
  groupId: string;
  action: ReviewAction;
  /** Optional stable reason token (must match /^[a-z0-9_.:-]{1,64}$/). */
  reason?: string;
  /**
   * Caller-supplied actor identifier, e.g. a Stellar public key or a session
   * id. Stored in the group's `reviewedBy` and in the audit trail.
   */
  actorId: string;
}
