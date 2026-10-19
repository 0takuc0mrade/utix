# Storage Schema Compatibility Checks & Migration Framework (#240)

## Overview

Utix persists browser state, operations history, idempotency records, and notification preferences client-side. As the application evolves to support multi-tenant isolation, structured actor attribution, and tamper-evident SHA-256 record checksums, storage schemas must transition safely from legacy (V1) to the next storage schema version (V2).

The **Storage Schema Migration Framework** (`core/migration/storage-schema.ts`) provides pre-flight compatibility checks, dry-run previews, atomic execution, automated post-migration invariant validation, and reverse downgrade rollback.

---

## The Four Required Paths

```
                             [Storage Records]
                                     │
                        ┌────────────┴────────────┐
                        ▼                         ▼
             [Authorization Check]       [Compatibility Check]
             - maintainer/admin only     - detect malformed records
             - unauthorized -> DENIED    - corrupt -> REJECT
                        │                         │
                        └────────────┬────────────┘
                                     ▼
                        ┌─────────────────────────┐
                        │   Migration Execution   │
                        └────────────┬────────────┘
                                     │
         ┌───────────────────────────┼───────────────────────────┐
         ▼                           ▼                           ▼
   [Normal Path]              [Failure Path]               [Retry Path]
   - Upgrade V1 -> V2         - Invariant fails            - Idempotent resume
   - Inject Checksums         - Trigger rollback           - Skip already V2
   - Post-checks PASS         - Restore V1 records         - Zero duplicate records
```

### 1. Normal Path
- Valid legacy V1 records are upgraded to V2 format.
- Injects `schemaVersion: 2`, `partition: "default"`, deterministic SHA-256 `checksum`, and `migrationMeta`.
- All post-migration invariant checks pass (`all_records_schema_version_2`, `valid_integrity_checksums`).
- Emits telemetry and an audit trail entry.

### 2. Failure Path
- Corrupt or malformed records (missing IDs, invalid dates) are detected during pre-flight checks and fail fast before touching storage.
- If a post-migration check fails and `autoRollbackOnFailure: true`, the framework executes `downgradeV2ToV1()` to restore records to their exact pre-migration state.

### 3. Retry Path
- Interrupted or retried migrations are fully idempotent.
- Records already carrying `schemaVersion: 2` are detected as noops and passed through unchanged without key collisions or duplicated records.

### 4. Authorization Path
- Migration operations are gated behind maintainer and administrative roles.
- Plain user actors attempting migration are refused with `permission_denied` and audited.

---

## V1 vs V2 Schema Differences

| Field | V1 (Legacy) | V2 (Next Version) | Purpose |
|---|---|---|---|
| `schemaVersion` | Optional / missing | `2` (required) | Explicit schema negotiation |
| `checksum` | Not present | 32-char SHA-256 hex | Tamper-evident record integrity |
| `partition` | Not present | `"default"` | Multi-account storage isolation |
| `actor` | Not present | `{ kind, id }` | Attribution for audit trail |
| `migrationMeta` | Not present | `{ migratedFrom, migratedAt }` | Provenance tracking |

---

## Operational Edge Cases & Failure Modes

1. **Storage Quota Exceeded During Migration**:
   - V2 records include checksum and metadata fields, slightly increasing storage footprint.
   - *Mitigation*: Run pre-flight `checkStorageCompatibility()` with dry-run estimation.
2. **Concurrent Tab Writes During Upgrade**:
   - *Mitigation*: Migrations use atomic batches and verify checksums before committing.
3. **Rollback Verification**:
   - If a rollback occurs, `verifyRollback()` asserts that record count and ID parity match the original set.

---

## Rollback & Recovery Steps

1. **Pre-flight Check**:
   ```bash
   node --loader ./scripts/loader.mjs scripts/verify-issues-219-240.mjs
   ```
2. **Reverse Migration**:
   If an issue is found in V2 behavior post-migration, execute downgrade:
   ```typescript
   StorageV1ToV2Migration.rollback(v2Records);
   ```
