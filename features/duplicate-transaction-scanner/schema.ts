import { err, ok, type Result } from "@/core/result/result";
import type {
  DuplicateScanErrorCode,
  DuplicateScanInput,
} from "@/features/duplicate-transaction-scanner/types";

/** Stellar transaction hashes are 32 bytes encoded as 64 lower-case hex chars. */
const HASH_RE = /^[a-fA-F0-9]{64}$/;

/** Maximum number of hashes accepted in one scan request. */
export const MAX_HASHES = 20;

/**
 * Parse the raw textarea value into a list of normalised transaction hashes.
 *
 * Rules:
 * - Empty or whitespace-only input → `empty_input`
 * - More than MAX_HASHES lines → `too_many_hashes`
 * - Any line that is not a valid 64-hex-char string → `invalid_hash`
 * - Duplicates within the submitted list are silently deduplicated.
 */
export function parseDuplicateScanInput(
  rawHashes: string,
  network: string,
): Result<DuplicateScanInput, DuplicateScanErrorCode> {
  const trimmed = rawHashes.trim();
  if (!trimmed) return err("empty_input");

  const lines = trimmed
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length === 0) return err("empty_input");
  if (lines.length > MAX_HASHES) return err("too_many_hashes");

  const seen = new Set<string>();
  const hashes: string[] = [];

  for (const line of lines) {
    if (!HASH_RE.test(line)) return err("invalid_hash");
    const normalised = line.toLowerCase();
    if (!seen.has(normalised)) {
      seen.add(normalised);
      hashes.push(normalised);
    }
  }

  return ok({ hashes, network });
}
