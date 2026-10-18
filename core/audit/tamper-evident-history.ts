/**
 * Tamper-evident change history for critical domain records (#76).
 *
 * Records before/after metadata for every mutation on critical records
 * (ownership, money, permissions, user access). Each entry includes a
 * SHA-256 hash chain so any alteration, deletion, or reordering of
 * history entries is detectable.
 *
 * Hash chain: `hash = sha256(prevHash + entryData)`.
 * Verification walks the chain and recomputes each hash; any mismatch
 * indicates tampering.
 */

import { createHash } from 'crypto';

export type MutationType = 'create' | 'update' | 'delete' | 'transfer' | 'redeem' | 'revoke';

export interface ChangeHistoryEntry {
  /** Monotonic sequence number (1-based). */
  seq: number;
  /** Record type (e.g. 'ticket', 'event', 'permission'). */
  recordType: string;
  /** Record identifier. */
  recordId: string;
  /** Type of mutation. */
  mutationType: MutationType;
  /** Actor who performed the mutation. */
  actor: string;
  /** Reason/justification for the mutation. */
  reason: string;
  /** State before the mutation (null for create). */
  before: Record<string, unknown> | null;
  /** State after the mutation (null for delete). */
  after: Record<string, unknown> | null;
  /** ISO timestamp of the mutation. */
  timestamp: string;
  /** SHA-256 hash of this entry (chain link). */
  hash: string;
  /** Hash of the previous entry (chain link). */
  prevHash: string;
}

export interface VerificationResult {
  valid: boolean;
  /** Index of the first broken entry, or -1 if valid. */
  brokenAt: number;
  /** Description of the tampering detected. */
  reason: string | null;
}

function computeHash(prevHash: string, entry: Omit<ChangeHistoryEntry, 'hash'>): string {
  const data = JSON.stringify({ ...entry, prevHash });
  return createHash('sha256').update(data).digest('hex');
}

export class TamperEvidentHistory {
  private readonly entries: ChangeHistoryEntry[] = [];

  /**
   * Record a mutation. Returns the created entry.
   */
  record(params: {
    recordType: string;
    recordId: string;
    mutationType: MutationType;
    actor: string;
    reason: string;
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
  }): ChangeHistoryEntry {
    const prevHash = this.entries.length > 0
      ? this.entries[this.entries.length - 1].hash
      : '0'.repeat(64);

    const entryData = {
      seq: this.entries.length + 1,
      recordType: params.recordType,
      recordId: params.recordId,
      mutationType: params.mutationType,
      actor: params.actor,
      reason: params.reason,
      before: params.before,
      after: params.after,
      timestamp: new Date().toISOString(),
      prevHash,
    };

    const hash = computeHash(prevHash, entryData);
    const entry: ChangeHistoryEntry = { ...entryData, hash };
    this.entries.push(entry);
    return entry;
  }

  /**
   * Get all entries for a record.
   */
  getHistory(recordType: string, recordId: string): ChangeHistoryEntry[] {
    return this.entries.filter(
      (e) => e.recordType === recordType && e.recordId === recordId,
    );
  }

  /**
   * Verify the hash chain integrity. Detects altered, missing, or
   * out-of-order entries.
   */
  verify(): VerificationResult {
    if (this.entries.length === 0) {
      return { valid: true, brokenAt: -1, reason: null };
    }

    let expectedPrevHash = '0'.repeat(64);

    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i];

      // Check sequence number is correct
      if (entry.seq !== i + 1) {
        return {
          valid: false,
          brokenAt: i,
          reason: `Entry ${i}: expected seq ${i + 1}, got ${entry.seq} — entries are missing or out of order`,
        };
      }

      // Check chain link
      if (entry.prevHash !== expectedPrevHash) {
        return {
          valid: false,
          brokenAt: i,
          reason: `Entry ${i}: prevHash mismatch — chain broken at seq ${entry.seq}`,
        };
      }

      // Recompute hash
      const entryData = {
        seq: entry.seq,
        recordType: entry.recordType,
        recordId: entry.recordId,
        mutationType: entry.mutationType,
        actor: entry.actor,
        reason: entry.reason,
        before: entry.before,
        after: entry.after,
        timestamp: entry.timestamp,
        prevHash: entry.prevHash,
      };
      const expectedHash = computeHash(entry.prevHash, entryData);
      if (entry.hash !== expectedHash) {
        return {
          valid: false,
          brokenAt: i,
          reason: `Entry ${i}: hash mismatch — entry data was altered after recording`,
        };
      }

      expectedPrevHash = entry.hash;
    }

    return { valid: true, brokenAt: -1, reason: null };
  }

  /** Total entries recorded. */
  get count(): number {
    return this.entries.length;
  }
}
