# Idempotency and replay protection

Retries are normal. A Horizon request times out and the caller sends it again; a
user double-clicks "mark all read"; an export is generated, the tab reloads
before the response lands, and the same export is requested once more. Each of
those is a *new* attempt at a side effect that may already have happened.

`core/idempotency/` makes those writes safe to retry. The caller attaches an
**idempotency key**; the store records the outcome of the first attempt and
replays it for every later attempt with the same key. The side effect happens
once.

## Using it

Two shapes are available. For a single call site, the wrapper:

```ts
import { createIdempotencyStore, withIdempotency } from "@/core/idempotency/idempotency";

const idempotency = createIdempotencyStore();

const outcome = await withIdempotency(idempotency, {
  key: requestIdempotencyKey,          // from the client; must be stable per intent
  operation: "wallet.detect",
  request: { network, address },       // digested, order-insensitive
  run: async () => detectWallet(address)
});

if (outcome.ok && outcome.value.replayed) {
  // A duplicate submission. Same value, no second side effect.
}
```

For a record you need to hold onto, drive the store directly:

```ts
const begun = idempotency.begin({ key, operation, request });
if (!begun.ok) return begun;             // expired / conflicting / in flight
if (begun.value.replay) return begun.value.record.response;

// …do the work, then persist the outcome exactly once…
idempotency.complete(key, response);      // or .fail(key, code) / .abandon(key)
```

## Outcomes and error codes

| Code | When | What the caller should do |
| --- | --- | --- |
| `idempotency_key_missing` | no key on a request that requires one | ask the client for one |
| `idempotency_key_invalid` | fewer than 8 chars, or outside `[A-Za-z0-9._:-]` | regenerate the key |
| `idempotency_key_expired` | the record's TTL has elapsed | retry with a **new** key |
| `idempotency_key_conflict` | same key, different request digest or operation | treat as a bug; never retry blindly |
| `idempotency_in_flight` | the first attempt has not settled | wait, then retry the same key |
| `idempotency_not_found` | unknown key, or the record expired | — |

Two rules are worth stating explicitly, because they are the ones that protect
funds and users:

- **A replayed request never re-runs the work.** A completed key returns the
  recorded response; a failed key returns the recorded failure code. A retry
  after an error therefore looks like the same error, which is exactly what a
  caller can reason about.
- **An expired key is an error, not a licence to run again.** Silently
  re-executing an expired request is how double charges happen. The caller must
  decide whether the new attempt is a new intent (new key) or not (stop).

`abandon(key)` releases a claim whose work never started, so an aborted attempt
can be retried with the *same* key. Use it when the failure is definitely
pre-side-effect; do not use it to re-run work that may have landed.

## Record shape

```json
{"key":"export:2026-09-26:1","operation":"export.generate","requestHash":"req-37be50f9","status":"completed","response":{"recordCount":2},"createdAt":"2026-09-26T00:00:00.000Z","expiresAt":"2026-09-27T00:00:00.000Z","replays":1,"correlationId":"…"}
```

- `requestHash` — FNV-1a over a canonical (sorted-key) JSON form of the request,
  so `{a,b}` and `{b,a}` never look like a conflict. It is a digest, not a
  signature.
- `response` — the persisted outcome. Redacted through `core/telemetry`'s
  `redact()` before it is written, so a recorded payload never keeps a
  secret-shaped value. The envelope's own fields are stored verbatim, because
  the idempotency key is an identifier, not a secret.
- `replays` — how many times the outcome was served again.

Records are persisted through an `IdempotencyStorage` adapter
(`getItem` / `setItem` / `removeItem`); the default is `localStorage` in a
browser and an in-memory map elsewhere, and `sweep()` drops expired entries.
The clock and the id factory are injected, so tests are deterministic.

## Telemetry

| `op` | When |
| --- | --- |
| `idempotency.claimed` | a key was claimed by a first attempt |
| `idempotency.completed` | the outcome was recorded |
| `idempotency.failed` | a failure was recorded (or re-served) |
| `idempotency.replayed` | a recorded outcome was served again |
| `idempotency.rejected` | a key was refused, with the failure `errorCode` |
| `idempotency.swept` | expired records were dropped, with the `dropped` count |

## Guarded write paths today

| Path | Entry point |
| --- | --- |
| Enqueueing background work | `WorkerFramework.submit({ …, idempotencyKey })` |
| Generating an export | `exportRecords({ …, idempotencyKey })` |

`enqueue()` keeps its signature and its `dedupeKey` behaviour; `submit()` is the
guarded variant and returns `{ job, replayed, record }` or an idempotency code.
`exportRecords` replays the recorded envelope, so a duplicate submission cannot
mint a second artifact.

## Contributor rules

- Any write that creates a record, a notification or a settlement takes an
  idempotency key and goes through `withIdempotency` or `submit()`.
- Never treat `idempotency_key_conflict` as a retry. It means two different
  requests shared a key, which is a client bug worth surfacing.
- Keep a write's `operation` string stable. Changing it makes every in-flight
  key for that write look like a collision.

```bash
npm test -- core/idempotency   # replay, expiry, in-flight, collision, sweep
npm test -- core/workers core/export
```

## Concurrency: duplicate submissions and stale versions (#271)

`withIdempotency` claims its key **synchronously**, before its first `await`.
In one JavaScript realm, the first of two concurrent submissions always owns
the work, and the second gets `idempotency_in_flight`. The executable spec is in
`core/idempotency/__tests__/idempotency.concurrency.test.ts`:

| Scenario | Outcome |
| :--- | :--- |
| Same key, same payload, concurrently | One run; duplicate gets `idempotency_in_flight` |
| Retry after the first settled | Recorded outcome replayed; work count stays 1 |
| Two tabs sharing one storage | Same as above: the claim is in shared storage |
| First attempt failed or threw | Failure is recorded and replayed, never re-run |
| Claim stuck in flight | Only `abandon()` (audited) frees the key for a re-run |
| Same key, different payload or operation | `idempotency_key_conflict`, no replay of another's outcome |
| Duplicate after the TTL | `idempotency_key_expired`, never a silent second run |

Stale versions are covered in
`core/notifications/__tests__/preferences.concurrency.test.ts`.
`NotificationStore.updatePreferences` accepts an optional third argument,
`{ expectedVersion }`. When it is given and the stored `version` differs, the
write throws `StalePreferencesVersionError` (`recipient`, `expectedVersion`,
`actualVersion`) and storage is left unchanged. The caller re-reads, recomputes
its patch and retries.

### Edge cases

- **Cross-tab atomicity** is only as strong as `localStorage`. Browsers do not
  lock it across tabs, so two tabs that read the key in the same instant can both
  claim it. The in-realm guarantees above are exact. Cross-process exactly-once
  needs a store with compare-and-set behind `IdempotencyStorage`.
- **Corrupt stored preferences** fall back to defaults (`version: 1`), so a
  writer passing `expectedVersion: 1` recovers instead of being locked out.

### Migration and rollback

`expectedVersion` is optional, and omitting it keeps the previous last-write-wins
behaviour, so no existing caller changes. Rolling back removes the option and
the error class. Stored data is unaffected because the record shape and storage
keys are unchanged.

```bash
npm test -- core/idempotency core/notifications
```
