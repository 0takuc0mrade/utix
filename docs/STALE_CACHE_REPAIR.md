# Stale Cache and Stale Index Detection with Automated Repair (#236)

## Overview
Utix maintains read-heavy projections, memoized Horizon client responses, decoded transaction caches, and lookup indices to provide fast query responses. Over time or after network disconnects, projections can become stale due to TTL expiry, schema migrations, ledger sequence advancement, or missing target records.

The **Stale Projection Detector** (`core/cache/stale-detector.ts`) identifies, scopes, and provides automated repair recommendations with operator-visible telemetry and audit logging.

---

## Staleness Classification

| Reason | Description | Recommended Action | Severity |
| :--- | :--- | :--- | :--- |
| `ttl_expired` | Entry age exceeds configured TTL window | Evict | Info / Warning |
| `version_mismatch` | Serialization schema is older than system schema | Resync / Reindex | Warning |
| `ledger_drift` | Cached state sequence is behind authoritative ledger head | Resync | Warning / Critical |
| `orphan_reference` | Cache entry points to deleted or absent root entity | Evict | Warning |
| `index_inconsistency` | Index pointer targets absent record | Reindex | Critical |

---

## Operational Edge Cases

1. **Horizon Ledger Sequence Ingestion Lag**:
   - During high network activity, Horizon nodes may temporarily trail Stellar Core by 1-2 ledgers.
   - The detector incorporates a configurable tolerance window (`maxToleratedDriftLedgers`, default 5 ledgers) to prevent false-positive churn.

2. **Concurrent Mutation during Reindex**:
   - If an index is being rebuilt while a transaction mutation occurs, reindex operations must use version checks or idempotency keys to avoid overwriting newer mutations.

3. **High-Cardinality Cache Partition Eviction**:
   - If thousands of keys expire simultaneously, bulk eviction is partitioned to prevent event-loop latency spikes.

---

## Failure Modes & Mitigations

| Failure Mode | Impact | Mitigation |
| :--- | :--- | :--- |
| **Repair Action Failure** | Network error during resync | Failed repairs are marked `success: false` and queued for background retry |
| **Cascading Eviction Storm** | Evicting all keys simultaneously causes backend overload | Evictions are staged with rate-limiting; fallback stale serve during burst |
| **Index Pointer Deadlock** | Corrupted pointer cannot be resolved | Safe fallback to primary table lookup when index pointer is flagged stale |

---

## Rollback & Recovery Steps

1. **Reverting an Erroneous Eviction**:
   - Cache entries are projections of primary state (Horizon ledgers, accounts, transactions).
   - Re-querying the primary source automatically populates a fresh cache entry.

2. **Index Rebuild Recovery**:
   - If an automated index rebuild was interrupted, run the reindex task with the partition key or full rebuild flag.
   - All repairs log evidence under `projection.repaired` in the audit log for inspection.
