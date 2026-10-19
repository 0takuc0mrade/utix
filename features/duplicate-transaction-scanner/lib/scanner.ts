/**
 * Fetches a batch of Stellar transactions from Horizon, extracts their
 * operation types, computes deterministic fingerprints, and groups candidate
 * duplicates.
 *
 * Design notes
 * ------------
 * - Requests are sequential (one hash at a time) to stay within Horizon's
 *   per-IP rate limit. For up to 20 hashes the total wall-clock time is well
 *   under typical timeouts.
 * - The entire scan is wrapped in `measure` so it shows up in telemetry as
 *   `duplicate_scanner.scan`.
 * - Per-hash errors (404, 429) short-circuit the whole scan rather than
 *   silently dropping hashes. The caller sees the first error code encountered.
 */

import { HORIZON_URLS } from "@/core/network/config";
import { err, ok, type Result } from "@/core/result/result";
import { measure } from "@/core/telemetry/telemetry";
import { groupByFingerprint } from "@/features/duplicate-transaction-scanner/lib/fingerprint";
import {
  fetchErrorToErrorCode,
  httpStatusToErrorCode,
} from "@/features/duplicate-transaction-scanner/lib/scanner.errors";
import type {
  DuplicateScanErrorCode,
  DuplicateScanInput,
  DuplicateScanResult,
  FetchedTransaction,
} from "@/features/duplicate-transaction-scanner/types";

// ---------------------------------------------------------------------------
// Horizon JSON shapes (minimal, only the fields we need)
// ---------------------------------------------------------------------------

interface HorizonTransaction {
  hash: string;
  source_account: string;
  fee_charged: string;
  memo_type: string;
  memo?: string;
  created_at: string;
  ledger: number;
  successful: boolean;
}

interface HorizonOperation {
  type: string;
}

interface HorizonOperationsPage {
  _embedded: { records: HorizonOperation[] };
}

// ---------------------------------------------------------------------------
// Internal fetch helpers
// ---------------------------------------------------------------------------

async function fetchTransaction(
  baseUrl: string,
  hash: string,
): Promise<Result<HorizonTransaction, DuplicateScanErrorCode>> {
  try {
    const res = await fetch(`${baseUrl}/transactions/${hash}`);
    if (!res.ok) return err(httpStatusToErrorCode(res.status));
    const data = await res.json() as HorizonTransaction;
    return ok(data);
  } catch (e) {
    return err(fetchErrorToErrorCode(e));
  }
}

async function fetchOperationTypes(
  baseUrl: string,
  hash: string,
): Promise<Result<string[], DuplicateScanErrorCode>> {
  try {
    const res = await fetch(`${baseUrl}/transactions/${hash}/operations?limit=50`);
    if (!res.ok) return err(httpStatusToErrorCode(res.status));
    const page = await res.json() as HorizonOperationsPage;
    const types = page._embedded.records.map((op) => op.type);
    return ok(types);
  } catch (e) {
    return err(fetchErrorToErrorCode(e));
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scan a list of validated transaction hashes against Horizon and return
 * candidate duplicate groups.
 *
 * @param input  Validated hashes and network (from schema.ts).
 * @param baseUrl  Optional override for the Horizon base URL, used in tests.
 */
export async function scanForDuplicates(
  input: DuplicateScanInput,
  baseUrl?: string,
): Promise<Result<DuplicateScanResult, DuplicateScanErrorCode>> {
  return measure(
    "duplicate_scanner.scan",
    { actorType: "user", correlationId: crypto.randomUUID() },
    async () => {
      const horizonBase =
        baseUrl ?? HORIZON_URLS[input.network as "testnet" | "mainnet"] ?? HORIZON_URLS.testnet;

      const fetched: FetchedTransaction[] = [];

      for (const hash of input.hashes) {
        const txResult = await fetchTransaction(horizonBase, hash);
        if (!txResult.ok) return txResult;

        const tx = txResult.value;
        const opsResult = await fetchOperationTypes(horizonBase, hash);
        if (!opsResult.ok) return opsResult;

        fetched.push({
          hash: tx.hash,
          sourceAccount: tx.source_account,
          feeCharged: tx.fee_charged,
          memoType: tx.memo_type,
          memo: tx.memo ?? "",
          createdAt: tx.created_at,
          operationTypes: opsResult.value.slice().sort(),
          ledger: tx.ledger,
          successful: tx.successful,
        });
      }

      const groups = groupByFingerprint(fetched, input.network);

      return ok({
        scannedCount: fetched.length,
        groupCount: groups.length,
        groups,
        network: input.network,
        scannedAt: new Date().toISOString(),
      });
    },
  );
}
