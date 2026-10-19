import { formatDateTime } from "@/core/format/date";
import type { CandidateGroupState } from "@/features/duplicate-transaction-scanner/types";

/** 5 minutes in seconds — must match TIME_BUCKET_SECONDS. */
const BUCKET_SECONDS = 300;

/** Stroops per XLM. */
const STROOPS_PER_XLM = 10_000_000n;

/**
 * Convert a time bucket index back to a human-readable window string.
 * e.g. bucket 5 571 048 → "2026-10-18T22:05:00Z – 22:10:00Z"
 */
export function formatTimeBucket(bucket: number): string {
  const startSec = bucket * BUCKET_SECONDS;
  const endSec = startSec + BUCKET_SECONDS;
  const start = new Date(startSec * 1000);
  const end = new Date(endSec * 1000);
  // Show start in full, end as HH:MM:SS to save space.
  const endTime = end.toISOString().slice(11, 19) + "Z";
  return `${start.toISOString()} – ${endTime}`;
}

/**
 * Format a fee charged value (in stroops as a string) into a readable string.
 * e.g. "100" → "100 stroops (0.0000100 XLM)"
 */
export function formatFee(feeCharged: string): string {
  try {
    const stroops = BigInt(feeCharged);
    const xlmWhole = stroops / STROOPS_PER_XLM;
    const xlmFrac = String(stroops % STROOPS_PER_XLM).padStart(7, "0");
    return `${feeCharged} stroops (${xlmWhole}.${xlmFrac} XLM)`;
  } catch {
    return `${feeCharged} stroops`;
  }
}

/** Format a sorted list of operation types into a comma-separated string. */
export function formatOpTypes(types: string[]): string {
  if (types.length === 0) return "—";
  return types.join(", ");
}

/** Human-readable label for a CandidateGroupState. */
export function formatGroupState(state: CandidateGroupState): string {
  const labels: Record<CandidateGroupState, string> = {
    pending: "Pending review",
    confirmed: "Confirmed duplicate",
    dismissed: "Dismissed",
    deferred: "Deferred",
  };
  return labels[state];
}

/** Format an ISO-8601 timestamp via the shared core formatter. */
export function formatCreatedAt(isoTimestamp: string): string {
  return formatDateTime(isoTimestamp);
}
