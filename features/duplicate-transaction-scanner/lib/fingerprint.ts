/**
 * Deterministic transaction fingerprinting and duplicate grouping.
 *
 * Two transactions are considered structurally duplicate when they share the
 * same source account, the same multiset of operation types, the same fee, the
 * same memo, the same network, *and* fall within the same 5-minute time window.
 *
 * The fingerprint is a SHA-256 digest of a minimal canonical JSON object that
 * encodes all of those fields. Using a hash keeps group ids short and stable —
 * the pre-image fields are stored alongside the digest so a reviewer can see
 * exactly why two transactions were grouped.
 *
 * Time bucketing intentionally coarsens the comparison: identical operations
 * submitted in the same 5-minute window are the most common accidental
 * duplicates (e.g. a double-submit from a UI retry). Transactions that are
 * hours apart but otherwise identical are NOT flagged — they are almost
 * certainly intentional repetitions.
 */

import { sha256Hex } from "@/core/ledger/sha256";
import type {
  CandidateGroup,
  DuplicateFingerprint,
  FetchedTransaction,
} from "@/features/duplicate-transaction-scanner/types";

/** Width of each time bucket in seconds (5 minutes). */
export const TIME_BUCKET_SECONDS = 300;

/**
 * Compute the time bucket index for an ISO-8601 timestamp.
 * Two times map to the same bucket iff they are within the same 5-minute
 * window aligned to the Unix epoch.
 */
export function timeBucketFor(isoTimestamp: string): number {
  const epochSeconds = Math.floor(new Date(isoTimestamp).getTime() / 1000);
  return Math.floor(epochSeconds / TIME_BUCKET_SECONDS);
}

/**
 * Build a canonical JSON string that uniquely identifies the "shape" of a
 * transaction within its time bucket.  Key ordering is fixed; field names are
 * intentionally short to minimise the pre-image length.
 */
function canonicalPreImage(
  tx: FetchedTransaction,
  network: string,
): string {
  const bucket = timeBucketFor(tx.createdAt);
  const obj = {
    src: tx.sourceAccount,
    ops: tx.operationTypes.slice().sort(),
    fee: tx.feeCharged,
    mt: tx.memoType,
    m: tx.memo,
    net: network,
    tb: bucket,
  };
  // JSON.stringify with sorted keys produces a deterministic string because the
  // key order is defined — the object literal above has a fixed key order.
  return JSON.stringify(obj);
}

/** Compute the fingerprint for one transaction. */
export function computeFingerprint(
  tx: FetchedTransaction,
  network: string,
): DuplicateFingerprint {
  const preImage = canonicalPreImage(tx, network);
  return {
    value: sha256Hex(preImage),
    sourceAccount: tx.sourceAccount,
    opTypesSorted: tx.operationTypes.slice().sort(),
    feeCharged: tx.feeCharged,
    memoType: tx.memoType,
    memo: tx.memo,
    network,
    timeBucket: timeBucketFor(tx.createdAt),
  };
}

/**
 * Group a list of fetched transactions into candidate duplicate groups.
 *
 * Only groups with 2 or more transactions are included — a group of 1 is not
 * a duplicate by definition.
 *
 * Groups are sorted by descending transaction count (most duplicates first)
 * so the most actionable groups appear at the top of the review queue.
 */
export function groupByFingerprint(
  txs: FetchedTransaction[],
  network: string,
): CandidateGroup[] {
  const byFingerprint = new Map<
    string,
    { fingerprint: DuplicateFingerprint; transactions: FetchedTransaction[] }
  >();

  for (const tx of txs) {
    const fp = computeFingerprint(tx, network);
    const existing = byFingerprint.get(fp.value);
    if (existing) {
      existing.transactions.push(tx);
    } else {
      byFingerprint.set(fp.value, { fingerprint: fp, transactions: [tx] });
    }
  }

  const groups: CandidateGroup[] = [];
  for (const [id, { fingerprint, transactions }] of byFingerprint) {
    if (transactions.length >= 2) {
      groups.push({
        id,
        fingerprint,
        transactions,
        state: "pending",
      });
    }
  }

  // Most duplicates first.
  groups.sort((a, b) => b.transactions.length - a.transactions.length);
  return groups;
}
