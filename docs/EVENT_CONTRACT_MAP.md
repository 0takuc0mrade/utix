# Cross-Service Contract Map for Domain Events and Integration Boundaries (#219)

## Overview

Utix is a browser-centric Stellar development and diagnostics toolkit with strict read-only security guarantees. While Utix does not expose public external HTTP API mutations, its services, core kernel, feature slices, background workers, and external integration points exchange structured payloads across well-defined boundaries.

The **Cross-Service Contract Map** (`core/contract/contract-map.ts`) establishes an authoritative, locked registry and verification system for all domain events and integration payloads.

---

## Architecture & Integration Boundaries

```
[Feature Slices / External Network]
          │
          ▼ (Input Validation / Classification)
┌────────────────────────────────────────────────────────┐
│                      Utix Core                         │
│                                                        │
│  telemetry.event       horizon.error       worker.job  │
│  export.envelope       lifecycle.state     replay.event│
│  idempotency.record    ownership.transfer  webhook.del │
│  reconciliation.report                                 │
└────────────────────────────────────────────────────────┘
          │
          ▼ (Strict Contract Enforcement & Versioning)
[Audit Subsystem / Storage Adapters / Read Projections / UI]
```

---

## Contract Inventory

| Event / Payload ID | Name | Producer | Consumers | Version | Failure Policy | Idempotency |
|---|---|---|---|---|---|---|
| `telemetry.event` | Telemetry Metric Record | `core/telemetry` | `core/audit`, `core/health`, logging | `1.0` | `fail_silent` (skip poison) | Optional |
| `horizon.error` | Classified Horizon Error | `core/horizon` | `features/*/hooks`, `core/ui` | `1.0` | `safe_fallback` (`request_failed`) | Optional |
| `worker.job` | Background Worker Job | `features/*` | `core/workers`, `core/audit` | `1.0` | `retry_and_dead_letter` (max 3, DLQ) | Required (`id`) |
| `export.envelope` | Data Export Envelope | `core/export` | browser download, `core/audit` | `1.0` | `reject_with_code` (`export_denied`) | Required (`correlationId`) |
| `lifecycle.state` | Lifecycle State Transition | `core/lifecycle` | `core/ui`, `core/notifications` | `1.0` | `revert_state` (`invalid_transition`) | Required (`id`) |
| `idempotency.record`| Idempotency Record Replay | `core/idempotency` | `core/workers`, `core/operations` | `1.0` | `reject_with_code` (`idempotency_key_conflict`) | Required (`key`) |
| `reconciliation.report`| Reconciliation Invariant Report | `core/reconciliation` | `core/health`, maintainer dashboard | `1.0` | `safe_fallback` (read-only) | Optional |
| `webhook.delivery` | Webhook Signed Delivery | `core/webhooks` | external subscribers, `core/audit` | `1.0` | `retry_and_dead_letter` (max 5, DLQ) | Required (`id`) |
| `replay.event` | Event Log Replay Entry | `core/replay` | `core/replay/projections` | `1.0` | `safe_fallback` (poison halt) | Required (`id`) |
| `ownership.transfer` | Ownership Transfer Intent | `core/ownership` | `core/notifications`, `core/audit` | `1.0` | `reject_with_code` (two-step) | Required (`id`) |

---

## Producer / Consumer Specifications & Required Fields

### 1. `telemetry.event`
- **Producer**: `core/telemetry` via `measureSync` or `emitTelemetry`.
- **Consumers**: `core/audit`, `core/health`, log streams.
- **Required Fields**:
  - `op` (`string`): operation identifier (e.g. `horizon.request`, `export.generate`).
  - `actorType` (`string`): `client`, `user`, or `maintainer`.
  - `result` (`string`): `success` or `failure`.
  - `latencyMs` (`number`): execution duration in milliseconds.
  - `correlationId` (`string`): tracing identifier.
  - `timestamp` (`string`): ISO 8601 timestamp.
- **Allowed Failure Behavior**: Fail-silent (`fail_silent`). Telemetry drops or formatting issues must never crash user workflows. Poison events are skipped with warnings.

### 2. `horizon.error`
- **Producer**: `core/horizon` via `classifyHorizonError`.
- **Consumers**: Feature slice hooks, components, and toast notifications.
- **Required Fields**:
  - `code` (`string`): stable error code (`rate_limited`, `not_found`, `timeout`, `network_error`).
  - `detail` (`object`): HTTP status and upstream detail object.
- **Allowed Failure Behavior**: Safe fallback (`safe_fallback`). Unknown errors map to `request_failed`.

### 3. `worker.job`
- **Producer**: Feature slices initiating background work.
- **Consumers**: `core/workers` queue and executor.
- **Required Fields**:
  - `id` (`string`): deterministic or unique job ID.
  - `operation` (`string`): operation name.
  - `status` (`string`): `queued`, `running`, `retrying`, `succeeded`, `dead_lettered`.
  - `attempts` (`number`): current attempt count.
  - `enqueuedAt` (`string`): ISO 8601 timestamp.
  - `correlationId` (`string`): correlation identifier.
- **Allowed Failure Behavior**: Retried with exponential backoff up to `maxAttempts: 3`. On exhaustion, transitioned to `dead_lettered` and recorded in audit trail.

### 4. `export.envelope`
- **Producer**: `core/export` via `generateExport`.
- **Consumers**: Browser download handler, audit logger.
- **Required Fields**:
  - `schemaVersion` (`string`): version negotiation string (`"1.0"`).
  - `scope` (`string`): `"own"` or `"maintainer"`.
  - `generatedAt` (`string`), `expiresAt` (`string`): lifecycle bounds.
  - `generator` (`string`): generator tag.
  - `correlationId` (`string`): audit correlation ID.
  - `recordCount` (`number`), `page` (`number`), `totalRecords` (`number`): paging metadata.
  - `records` (`array`): sanitized, privacy-filtered data records.
- **Allowed Failure Behavior**: Refused with explicit error codes (`export_denied`, `schema_unsupported`). No partial or unauthenticated exports.

### 5. `lifecycle.state`
- **Producer**: `core/lifecycle/records.ts`.
- **Consumers**: UI state badges, notification triggers, reconciliation sweeps.
- **Required Fields**:
  - `id` (`string`): record key.
  - `kind` (`string`): record machine name (e.g., `worker_job`, `notification`, `ticket`).
  - `state` (`string`): legal state name.
  - `updatedAt` (`string`): ISO 8601 timestamp.
- **Allowed Failure Behavior**: Illegal state transitions return `{ ok: false, code: "invalid_transition" }`. Machine reverts to previous state atomically.

### 6. `idempotency.record`
- **Producer**: `core/idempotency`.
- **Consumers**: Retrying callers, background jobs, payment verifiers.
- **Required Fields**:
  - `key` (`string`): idempotency key.
  - `operation` (`string`): targeted operation.
  - `requestHash` (`string`): SHA-256 canonical hash of payload.
  - `status` (`string`): `in_flight`, `completed`, `failed`.
  - `createdAt` (`string`), `expiresAt` (`string`).
  - `replays` (`number`): count of replayed responses.
- **Allowed Failure Behavior**: Key collision produces `idempotency_key_conflict`. Expired keys produce `idempotency_key_expired`. In-flight duplicates produce `idempotency_in_flight`.

---

## Versioning Rules & Upcast Policies

Every domain event contract adheres to SemVer-compatible negotiation:
1. **Current Version**: Active schema version produced by the current build.
2. **Supported Versions**: Versions the consumer/boundary can accept without error.
3. **Deprecated Versions**: Supported older versions that trigger upgrade notices but remain operational.
4. **Upcast Policy**:
   - `automatic`: Missing optional fields filled with safe defaults.
   - `manual`: Specific upcaster function applied via `core/replay/upcast.ts`.
   - `reject`: Payload strictly rejected with `schema_unsupported` or `schema_future` to avoid silent data truncation.

---

## Operational Edge Cases & Failure Modes

1. **Schema Drift During Rolling Deployment**:
   - *Risk*: A newer client produces an event format an older background worker cannot parse.
   - *Behavior*: Worker inspects `schemaVersion`. If newer than supported, the job is quarantined as `safe_fallback` or scheduled with backoff until all workers are updated.
2. **Poison Event in Replay Stream**:
   - *Risk*: A corrupt event in the append-only log triggers unhandled exceptions in all projections.
   - *Behavior*: Projection evaluator enforces poison event policy: `halt` (stop stream to prevent corrupted view promotion) or `skip` with metric emission depending on configuration.
3. **Idempotency Hash Collision on Concurrent Retries**:
   - *Risk*: Two distinct payloads send the same key concurrently.
   - *Behavior*: Atomic CAS on storage key locks `in_flight` status; canonical hash comparison detects conflicts and returns `idempotency_key_conflict`.

---

## Rollback & Recovery Steps

1. **Detecting Incompatible Payloads**:
   Run automated contract verification:
   ```bash
   npm run verify:issues-219-240
   ```
2. **Contract Reversion**:
   If an incompatible contract was rolled out, rollback to the previous version pointer. Deprecated version support ensures old consumers continue operating during the transition.
3. **Quarantine Inspection**:
   Inspect dead-lettered jobs in `core/workers` or failed deliveries in `core/webhooks` using audit logs:
   ```bash
   node scripts/verify-audit.mjs
   ```
