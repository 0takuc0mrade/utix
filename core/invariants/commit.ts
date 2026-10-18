/**
 * Optimistic commit for domain mutations (#192).
 *
 * `issueTicket`, `transferTicket` and `redeemTicket` are pure: they validate a
 * snapshot and return the next one. They are only safe under concurrency if
 * the snapshot they validated is still the current one when the result is
 * stored. Two requests that both read the same snapshot would otherwise both
 * pass the capacity, ownership or nonce check and the second write would
 * overwrite the first.
 *
 * `commitMutation` closes that gap with compare-and-set on a version:
 *
 * 1. read the state and its version;
 * 2. run the mutation on that snapshot;
 * 3. store the result only if the version is unchanged;
 * 4. otherwise re-read and run the mutation again on the new snapshot.
 *
 * A request that lost a race is therefore judged against the winner's result,
 * so it fails with the real invariant (capacity reached, no longer the owner,
 * already redeemed, nonce replayed) rather than overwriting it. After
 * `maxAttempts` lost races it gives up with `reason: "conflict"` and has changed
 * nothing, so the caller may retry with the same idempotency key.
 *
 * The cell is an interface because a real store (database row, contract
 * ledger entry) is asynchronous; `createMemoryStateCell` is the reference
 * implementation for tests.
 */

import type { DomainState } from './types';

export interface VersionedState {
  readonly version: number;
  readonly state: DomainState;
}

export interface StateCell {
  read(): Promise<VersionedState>;
  /**
   * Installs `next` and bumps the version only if the cell is still at
   * `expectedVersion`. Must be atomic. Returns false when it lost the race.
   */
  compareAndSet(expectedVersion: number, next: DomainState): Promise<boolean>;
}

export const DEFAULT_COMMIT_ATTEMPTS = 10;

export function createMemoryStateCell(initial: DomainState): StateCell {
  let current: VersionedState = { version: 0, state: initial };
  return {
    async read() {
      return current;
    },
    async compareAndSet(expectedVersion, next) {
      if (current.version !== expectedVersion) return false;
      current = { version: expectedVersion + 1, state: next };
      return true;
    }
  };
}

type MutationResult<E> =
  | { readonly ok: true; readonly value: DomainState }
  | { readonly ok: false; readonly code: E };

export type CommitOutcome<E> =
  | { readonly ok: true; readonly value: DomainState; readonly attempts: number }
  /** The mutation refused the latest snapshot. Nothing was stored. */
  | { readonly ok: false; readonly reason: 'rejected'; readonly code: E; readonly attempts: number }
  /** Every attempt lost a race. Nothing was stored; retrying is safe. */
  | { readonly ok: false; readonly reason: 'conflict'; readonly attempts: number };

export interface CommitOptions {
  readonly maxAttempts?: number;
}

export async function commitMutation<E>(
  cell: StateCell,
  mutate: (state: DomainState) => MutationResult<E>,
  options: CommitOptions = {}
): Promise<CommitOutcome<E>> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_COMMIT_ATTEMPTS);
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const { version, state } = await cell.read();
    const result = mutate(state);
    if (!result.ok) return { ok: false, reason: 'rejected', code: result.code, attempts: attempt };
    if (await cell.compareAndSet(version, result.value)) {
      return { ok: true, value: result.value, attempts: attempt };
    }
  }
  return { ok: false, reason: 'conflict', attempts: maxAttempts };
}
