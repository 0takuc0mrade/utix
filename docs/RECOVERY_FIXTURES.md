# Rare recovery fixtures

`core/testing/recoveryFixtures.ts` generates deterministic, JSON-safe operation
records for normal completion, failure before an external effect, retry,
ambiguous committed effects, and authorization denial. Equal seeds produce
equal records, timestamps, ids, and idempotency keys, which makes CI failures
replayable. `createFaultingOperationStorage` adds explicit read/write/remove/list
faults for persistence-edge tests.

Use the corpus in table-driven tests, or request one scenario when a test needs
to mutate it. Unknown scenarios throw rather than silently falling back. The
generators perform no I/O and never mutate production state.

An ambiguous-commit fixture must be resolved by an authorized maintainer; never
convert it directly to a retry, because the external effect may already exist.
Authorization-denied and checkpoint-write failures must leave the original
record unchanged. Recovery is to fix the permission/storage dependency and
re-run using the same fixture seed and idempotency key. Rollback is simply
discarding generated data; fixtures are not migration or production records.

This is an additive testing API and requires no consumer migration. Verify it
with `npx vitest run core/testing/__tests__/recoveryFixtures.test.ts`.
