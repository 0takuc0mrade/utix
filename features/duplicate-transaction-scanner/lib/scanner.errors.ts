import type { DuplicateScanErrorCode } from "@/features/duplicate-transaction-scanner/types";

/** Map an HTTP status code (or 0 for a network-level failure) to our error code. */
export function httpStatusToErrorCode(status: number): DuplicateScanErrorCode {
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  return "request_failed";
}

/** Map a thrown fetch error to our error code. */
export function fetchErrorToErrorCode(_error: unknown): DuplicateScanErrorCode {
  return "request_failed";
}
