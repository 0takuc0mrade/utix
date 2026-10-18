# Concurrency on Critical Mutation Paths

Ticket issuance, transfer and redemption are pure functions in
`core/invariants/mutations.ts`: each validates one snapshot and returns the
next. Concurrency safety is therefore decided where the result is stored, not
inside the functions.

## Vulnerable paths

| Path | Race if two requests read the same snapshot | Guard |
| --- | --- | --- |
| `issueTicket` | Both pass the capacity check, event is oversold (`INV-10`) | `commitMutation` |
| `transferTicket` | Both pass the ownership check, one transfer is lost or the ticket changes hands twice (`INV-02`) | `commitMutation` |
| `transferTicket` nonce | Same nonce accepted twice (`INV-09`) | `commitMutation` |
| `redeemTicket` | Same ticket redeemed twice (`INV-03`) | `commitMutation` |
| Retried client request | The same request runs twice | idempotency key (`core/idempotency`) |
| Projection rebuild | Two rebuilds write one projection | per-projection lock with timeout (`core/replay`) |

## Strategy

`core/invariants/commit.ts` implements optimistic concurrency:

1. `StateCell.read()` returns the state and its version.
2. The mutation runs on that snapshot.
3. `StateCell.compareAndSet(version, next)` stores the result only if the
   version is unchanged.
4. If another request committed first, the loser re-reads and runs the
   mutation again on the new snapshot.

A loser is judged against the winner's result, so it fails with the real
invariant (capacity reached, not the owner, already redeemed, nonce replayed)
instead of overwriting the winner. After `maxAttempts` (default 10) lost races
it returns `{ ok: false, reason: "conflict" }`. Nothing was stored, so the
client may retry.

`compareAndSet` must be atomic in the real store (a conditional update on a
version column, or a ledger entry sequence). `createMemoryStateCell` is the
reference implementation used by the tests.

## Idempotency and locks

- **Duplicate retries.** Wrap the commit in `withIdempotency`. While the first
  attempt is running, duplicates get `idempotency_in_flight`; after it settles,
  they replay the stored outcome. A key reused for a different request gets
  `idempotency_key_conflict`.
- **Lock timeout.** `ProjectionStore.acquireLock(name, owner, now, ttlMs)` grants
  the lock to one owner; the owner may refresh it; once `ttlMs` has passed
  another owner may take it over, and the old owner can no longer release it.
  An idempotency claim that outlives its TTL is not replayed: the caller gets
  `idempotency_key_expired` and must use a new key. In both cases a crashed
  worker cannot block an operation forever.

## Tests

`core/invariants/__tests__/mutations.concurrency.test.ts` covers, with no
timers and no randomness:

- concurrent success (many issuances within capacity, no duplicate ids);
- conflicting requests (oversell, double redeem, double transfer, replayed
  nonce, redeem racing a transfer);
- lost races (`conflict` result, retry succeeds, attempt counts);
- duplicate retries (one transfer however many submissions, replay after
  settle, key reuse refused);
- lock timeout (single grant, takeover after the TTL, refresh and release by the
  owner only, expired idempotency claim).

Run with `npx vitest run core/invariants/__tests__/mutations.concurrency.test.ts`.

## Limits

The in-memory cell serializes within one process. Cross-process safety depends
on the real store providing an atomic `compareAndSet`.
