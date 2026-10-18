# Public API Contract

Utix is a read-only browser toolkit: there is no HTTP service to curl and no
API key to mint. The "public API" is therefore the set of **operation shapes**
that integration points and downstream consumers rely on. This document is the
single source of truth for those shapes, and `core/contract/` enforces them
with drift tests that fail CI whenever a response shape changes incompatibly.

Locked operations (see `core/contract/__tests__/contract.test.ts`). Each one is
version-negotiated before its payload is read — see
[Version negotiation](#version-negotiation):

| Operation           | Shape                                                       |
|---------------------|-------------------------------------------------------------|
| `telemetry.event`   | Structured record emitted by `core/telemetry`               |
| `horizon.error`     | Classified failure from `classifyHorizonError`              |
| `worker.job`        | Job payload from `core/workers`                             |
| `export.envelope`   | Export artifact from `core/export`                          |
| `feature.manifest`  | Registry metadata every feature publishes                   |
| `lifecycle.state`   | Derived state view shared by the UI and API responses        |
| `idempotency.record` | Persisted outcome replayed for a retried write             |
| `reconciliation.report` | Read-only dry-run drift report                         |
| `reconciliation.repair_plan` | Dry-run repair plan derived from a report         |

## Conventions

- **Results** are `{ ok: true, value }` or `{ ok: false, code, detail? }` — the
  shared `Result` type. Never throw for expected failures.
- **Error codes** are stable strings (`not_found`, `rate_limited`,
  `export_denied`, `schema_unsupported`, …). The UI maps each code to recovery
  copy; consumers can switch on codes, not on English messages.
- **Auth**: read-only by design. No secrets are ever accepted or returned.
  The only authorization decision is export scope — a plain `user` actor may
  request `scope: "own"` only; `scope: "maintainer"` requires a maintainer
  actor, otherwise `export_denied`.
- **Pagination**: exports paginate with `pageSize` / `page`; the envelope
  always carries `recordCount` and `totalRecords`.

## 1. Telemetry record — `telemetry.event`

Every field is required.

```json
{"op":"horizon.request","actorType":"client","result":"failure","latencyMs":10012,"correlationId":"8f0c…01","timestamp":"2026-09-25T12:00:00.000Z","errorCode":"timeout"}
```

```json
{"op":"export.generate","actorType":"user","result":"success","latencyMs":2,"correlationId":"8f0c…02","timestamp":"2026-09-25T12:00:01.000Z"}
```

## 2. Horizon error — `horizon.error`

Output of `classifyHorizonError(error)`: `{ code, detail }`.

```json
{"code":"rate_limited","detail":{"status":429}}
```

```json
{"code":"not_found","detail":{"status":404,"title":"Resource Missing","detail":"The resource at the url requested was not found."}}
```

## 3. Worker job — `worker.job`

```json
{"id":"…","operation":"maintenance.prune_horizon_clients","params":{"network":"mainnet"},"maxAttempts":3,"attempts":0,"status":"queued","enqueuedAt":"2026-09-25T12:00:00.000Z","correlationId":"8f0c…03"}
```

```json
{"id":"…","operation":"flaky.process","attempts":3,"status":"dead_lettered","lastError":{"code":"Error","message":"naive failure"},"enqueuedAt":"2026-09-25T12:00:00.000Z","correlationId":"8f0c…04"}
```

## 4. Export envelope — `export.envelope`

Success:

```json
{"schemaVersion":"1.0","scope":"own","generatedAt":"2026-09-25T12:00:00.000Z","expiresAt":"2026-09-26T12:00:00.000Z","generator":"utix-export@1","correlationId":"8f0c…05","recordCount":2,"page":1,"totalRecords":2,"records":[{"op":"wallet.detect","result":"success","recordType":"operation_log","scope":"own"}]}
```

Failure (authorization):

```json
{"ok":false,"code":"export_denied"}
```

Failure (version):

```json
{"ok":false,"code":"schema_unsupported"}
```

## 5. Feature manifest — `feature.manifest`

What `manifest.ts` publishes for every tool:

```json
{"slug":"payment-qr","title":"Payment QR Generator","description":"Build a SEP-0007 payment request URI and render it as a scannable QR code.","category":"payments","status":"working"}
```

## 6. Record state view — `lifecycle.state`

`stateView(kind, state)` from `core/lifecycle/records.ts`. The UI and an API
consumer receive the *same* object: the label, the tone and the legal events all
come from the lifecycle table, so a badge can never disagree with a payload.

```json
{"kind":"worker_job","state":"retrying","label":"Retrying","tone":"warning","terminal":false,"allowedEvents":["start","fail","exhaust","retry","dead_letter"]}
```

```json
{"kind":"notification","state":"purged","label":"Purged","tone":"danger","terminal":true,"allowedEvents":[]}
```

A rejected transition is a `Result`, not an exception:

```json
{"ok":false,"code":"terminal_state"}
```

Codes: `unknown_record_kind`, `unknown_state`, `unknown_event`,
`invalid_transition`, `terminal_state`. See
[LIFECYCLE.md](./LIFECYCLE.md).

## 7. Idempotency record — `idempotency.record`

A retried write replays this record instead of repeating the side effect.

```json
{"key":"export:2026-09-26:1","operation":"export.generate","requestHash":"req-37be50f9","status":"completed","response":{"recordCount":2},"createdAt":"2026-09-26T00:00:00.000Z","expiresAt":"2026-09-27T00:00:00.000Z","replays":1,"correlationId":"8f0c…06"}
```

Refused keys:

```json
{"ok":false,"code":"idempotency_key_conflict"}
```

Codes: `idempotency_key_missing`, `idempotency_key_invalid`,
`idempotency_key_expired`, `idempotency_key_conflict`, `idempotency_in_flight`,
`idempotency_not_found`. See [IDEMPOTENCY.md](./IDEMPOTENCY.md).

## 8. Reconciliation report — `reconciliation.report`

Read-only output of a dry run. `dryRun` is always `true`; nothing in the report
mutates anything. Each finding may carry an additive `rootCause`
(`{ code, confidence, hint, evidence? }`); consumers that ignore unknown fields
are unaffected.

```json
{"runId":"…","startedAt":"2026-09-26T00:00:00.000Z","finishedAt":"2026-09-26T00:00:00.000Z","dryRun":true,"checks":[{"invariant":"balance.amount_agrees","checked":4,"findings":1}],"findings":[{"id":"balance.amount_agrees:G1|USDC","invariant":"balance.amount_agrees","kind":"inconsistent","severity":"critical","subject":"stored_balance","recordId":"G1|USDC","detail":"Stored USDC balance disagrees with ledger reference ledger:100.","expected":"10.51","observed":"10.50","repair":"Treat the ledger as authoritative and re-cache the line. …"}],"summary":{"missing":0,"duplicate":0,"stale":1,"inconsistent":1,"total":2},"clean":false}
```

`kind` is one of `missing`, `duplicate`, `stale`, `inconsistent`. See
[RECONCILIATION.md](./RECONCILIATION.md).

### 8a. Repair plan — `reconciliation.repair_plan`

Output of `planRepairs(report, snapshot)`. A plan is itself a dry run: it
describes writes and makes none.

```json
{"planId":"…","runId":"…","createdAt":"2026-09-26T00:00:00.000Z","expiresAt":"2026-09-26T00:15:00.000Z","dryRun":true,"actions":[{"id":"recache_balance:G1|USDC","kind":"recache_balance","findingIds":["balance.amount_agrees:G1|USDC"],"invariant":"balance.amount_agrees","subject":"stored_balance","target":{"account":"G1","asset":"USDC"},"before":{"balance":"10.50","cachedAt":null},"after":{"balance":"10.51","reference":"ledger:100","cachedAt":"2026-09-26T00:00:00.000Z"},"reversible":true,"risk":"low","rollback":"Write `before.balance` back; …"}],"manual":[],"fingerprint":"9f2c…","summary":{"actions":1,"reversible":1,"irreversible":0,"manual":0}}
```

Applying a plan returns `{ ok: true, value: RepairOutcome }` or one of
`repair_denied`, `confirmation_required`, `plan_tampered`, `plan_expired`,
`nothing_selected`, `blast_radius_exceeded`, `handler_missing`,
`snapshot_unavailable`, `plan_stale`, `repair_failed`.

## 9. Audit event — `audit.event`

One event per sensitive action. `before`/`after` hold primitives only, so an
event can never carry a payload.

```json
{"id":"4b16c3b6-85b7-4d43-8abb-79491d0fe612","action":"record.state_changed","actor":{"kind":"maintainer","id":"ada"},"actorId":"ada","scope":"maintainer","target":{"kind":"worker_job","id":"job-1"},"reason":"manual_dead_letter","outcome":"allowed","before":{"state":"retrying"},"after":{"state":"dead_lettered","event":"dead_letter"},"at":"2026-09-26T00:00:00.000Z","correlationId":"8f0c…06"}
```

`action` is one of `record.state_changed`, `record.transition_denied`,
`export.generated`, `notification.published`, `notification.cleared`,
`reconciliation.reported`, `reconciliation.repaired`, `idempotency.claim_released`,
`quota.override_granted`, `quota.override_revoked`. `outcome` is `allowed`
or `denied`, in which case `errorCode` carries the refusal. Refused reads:

```json
{"ok":false,"code":"audit_denied"}
```

Codes: `audit_denied`, `invalid_audit_field`, `invalid_filter`,
`audit_not_found`. See [AUDIT.md](./AUDIT.md).

## Version negotiation

Every operation that carries a `schemaVersion` is negotiated *before* its
payload is interpreted, so a consumer never reads a shape this build does not
speak. `negotiateSchemaVersion` in `core/contract/contract.ts` is the boundary;
`negotiateSchemaVersionOrError` returns the same answer as the shared `Result`
for callers that switch on the code.

Four outcomes, because they call for four different responses:

| Requested          | Code                 | `guidance`      | Meaning |
|--------------------|----------------------|-----------------|---------|
| absent / empty     | `schema_missing`     | `upgrade`       | No version was sent. A caller bug: nothing about the payload can be trusted, and falling back would mean guessing a version. |
| older, still served| — (served)           | —               | Served, and reported with `status: "deprecated"`. The payload is valid; plan the upgrade before it stops being served. |
| newer than current | `schema_future`      | `safe_fallback` | The payload may mean something this build cannot read. Ignore it and use defaults; retrying only helps once the consumer is upgraded. |
| anything else      | `schema_unsupported` | `upgrade`       | Not served by this build, and not parseable as a version either. The refusal lists the versions that are served. |

`retry` is reserved for a genuinely transient version problem and is not
produced today; it exists so a future code has a home rather than overloading
`upgrade`.

```ts
const outcome = negotiateSchemaVersionOrError({
  requested: payload.schemaVersion,
  current: EXPORT_CURRENT_SCHEMA_VERSION,
  deprecated: ["0.9"]
});

if (!outcome.ok) {
  // outcome.detail.guidance tells a caller whether to retry, upgrade, or fall back.
  return err(outcome.code, outcome.detail);
}
```

Two rules for changing any of this:

- a *new* older version that is still served must be added to the `deprecated`
  list, not to a new code — a consumer that handled a deprecation keeps working
  when the version is finally dropped, and the transition is a documentation
  change rather than a new failure mode
- a version string that is not `major.minor` is refused as
  `schema_unsupported` rather than coerced. `"latest"` must never be resolved to
  whatever happens to be current.

The fixtures in `core/contract/fixtures/schemaVersions.ts` cover each row above,
and `core/contract/__tests__/schemaVersion.test.ts` negotiates every one of them.

## Drift detection

`npm run test` (or `npm run check`) runs `core/contract/__tests__/contract.test.ts`,
which *captures the real output of each module* and validates it against the
locked schemas above. Adding a required field to a response without updating a
contract, or omitting one, fails the suite:

```bash
npm run test -- core/contract
```

To change an intentionally breaking contract, update this document **and** the
locked `ContractSchema` in the drift test in the same commit.