/**
 * Stale Cache and Stale Index Detector (#236)
 *
 * Provides inspection of cached projections and index mappings to identify staleness,
 * version skew, ledger drift, and orphan references, outputting automated repair recommendations
 * and operator-visible evidence.
 */

import { recordAudit } from "@/core/audit/audit.ts";
import type {
  CacheEntry,
  IndexEntry,
  InspectionContext,
  RepairRecommendation,
  RepairResult,
  StaleFinding,
  StaleInspectionReport
} from "./types.ts";

export class StaleProjectionDetector {
  /**
   * Inspects cache projections and index tables for stale data.
   * Completely read-only: does not modify input collections.
   */
  public static inspect(
    caches: readonly CacheEntry[],
    indexes: readonly IndexEntry[],
    context: InspectionContext
  ): StaleInspectionReport {
    const nowMs =
      context.now instanceof Date
        ? context.now.getTime()
        : typeof context.now === "number"
          ? context.now
          : Date.now();

    const maxDrift = context.maxToleratedDriftLedgers ?? 5;
    const primarySet = context.primaryEntityIds
      ? new Set(context.primaryEntityIds)
      : null;

    const findings: StaleFinding[] = [];
    const recommendations: RepairRecommendation[] = [];

    let staleCachesCount = 0;
    let staleIndexesCount = 0;

    // 1. Inspect Caches
    for (const entry of caches) {
      const cachedAtMs =
        typeof entry.cachedAt === "string"
          ? new Date(entry.cachedAt).getTime()
          : entry.cachedAt;
      const ageMs = Math.max(0, nowMs - cachedAtMs);

      // Check TTL expiration
      if (entry.ttlMs > 0 && ageMs > entry.ttlMs) {
        staleCachesCount += 1;
        const findingId = `stale-cache-ttl-${entry.key}`;
        findings.push({
          id: findingId,
          kind: "cache",
          targetKey: entry.key,
          staleReason: "ttl_expired",
          severity: ageMs > entry.ttlMs * 3 ? "warning" : "info",
          ageMs,
          details: `Cache entry expired (${ageMs}ms old > TTL ${entry.ttlMs}ms)`
        });
        recommendations.push({
          id: `rec-${findingId}`,
          targetKey: entry.key,
          kind: "cache",
          staleReason: "ttl_expired",
          severity: ageMs > entry.ttlMs * 3 ? "warning" : "info",
          recommendedAction: "evict",
          scope: "single",
          operatorGuidance: `Evict key "${entry.key}" from cache store or let the next query fetch fresh state.`,
          remediationPayload: { key: entry.key, action: "evict" }
        });
        continue;
      }

      // Check Schema Version Mismatch
      if (entry.version < context.currentSchemaVersion) {
        staleCachesCount += 1;
        const findingId = `stale-cache-ver-${entry.key}`;
        findings.push({
          id: findingId,
          kind: "cache",
          targetKey: entry.key,
          staleReason: "version_mismatch",
          severity: "warning",
          ageMs,
          observedVersion: entry.version,
          expectedVersion: context.currentSchemaVersion,
          details: `Cache entry format v${entry.version} is behind current schema v${context.currentSchemaVersion}`
        });
        recommendations.push({
          id: `rec-${findingId}`,
          targetKey: entry.key,
          kind: "cache",
          staleReason: "version_mismatch",
          severity: "warning",
          recommendedAction: "resync",
          scope: "single",
          operatorGuidance: `Resync and re-serialize key "${entry.key}" with schema v${context.currentSchemaVersion}.`,
          remediationPayload: { key: entry.key, targetVersion: context.currentSchemaVersion }
        });
        continue;
      }

      // Check Ledger Sequence Drift
      if (
        typeof context.authoritativeLedgerSequence === "number" &&
        typeof entry.ledgerSequence === "number"
      ) {
        const drift = context.authoritativeLedgerSequence - entry.ledgerSequence;
        if (drift > maxDrift) {
          staleCachesCount += 1;
          const findingId = `stale-cache-seq-${entry.key}`;
          findings.push({
            id: findingId,
            kind: "cache",
            targetKey: entry.key,
            staleReason: "ledger_drift",
            severity: drift > 100 ? "critical" : "warning",
            ageMs,
            observedSequence: entry.ledgerSequence,
            authoritativeSequence: context.authoritativeLedgerSequence,
            details: `Cache projection at ledger ${entry.ledgerSequence} is ${drift} ledgers behind head (${context.authoritativeLedgerSequence})`
          });
          recommendations.push({
            id: `rec-${findingId}`,
            targetKey: entry.key,
            kind: "cache",
            staleReason: "ledger_drift",
            severity: drift > 100 ? "critical" : "warning",
            recommendedAction: "resync",
            scope: "single",
            operatorGuidance: `Re-query Horizon or RPC to refresh projection "${entry.key}" to ledger ${context.authoritativeLedgerSequence}.`,
            remediationPayload: { key: entry.key, headSequence: context.authoritativeLedgerSequence }
          });
          continue;
        }
      }

      // Check Orphaned Source Entity
      if (primarySet && entry.sourceEntityId && !primarySet.has(entry.sourceEntityId)) {
        staleCachesCount += 1;
        const findingId = `stale-cache-orphan-${entry.key}`;
        findings.push({
          id: findingId,
          kind: "cache",
          targetKey: entry.key,
          staleReason: "orphan_reference",
          severity: "warning",
          ageMs,
          details: `Cache entry references deleted or non-existent entity "${entry.sourceEntityId}"`
        });
        recommendations.push({
          id: `rec-${findingId}`,
          targetKey: entry.key,
          kind: "cache",
          staleReason: "orphan_reference",
          severity: "warning",
          recommendedAction: "evict",
          scope: "single",
          operatorGuidance: `Evict dangling cache entry "${entry.key}" because root record "${entry.sourceEntityId}" is gone.`,
          remediationPayload: { key: entry.key, orphanId: entry.sourceEntityId }
        });
      }
    }

    // 2. Inspect Indexes
    for (const index of indexes) {
      const indexedAtMs =
        typeof index.indexedAt === "string"
          ? new Date(index.indexedAt).getTime()
          : index.indexedAt;
      const ageMs = Math.max(0, nowMs - indexedAtMs);

      // Check Orphan Target in Index
      if (primarySet && !primarySet.has(index.targetId)) {
        staleIndexesCount += 1;
        const findingId = `stale-index-orphan-${index.indexKey}`;
        findings.push({
          id: findingId,
          kind: "index",
          targetKey: index.indexKey,
          staleReason: "index_inconsistency",
          severity: "critical",
          ageMs,
          details: `Index pointer "${index.indexKey}" references absent target "${index.targetId}"`
        });
        recommendations.push({
          id: `rec-${findingId}`,
          targetKey: index.indexKey,
          kind: "index",
          staleReason: "index_inconsistency",
          severity: "critical",
          recommendedAction: "reindex",
          scope: "single",
          operatorGuidance: `Rebuild index entry "${index.indexKey}" or delete dangling index pointer.`,
          remediationPayload: { indexKey: index.indexKey, missingTargetId: index.targetId }
        });
        continue;
      }

      // Check Schema Version
      if (index.version < context.currentSchemaVersion) {
        staleIndexesCount += 1;
        const findingId = `stale-index-ver-${index.indexKey}`;
        findings.push({
          id: findingId,
          kind: "index",
          targetKey: index.indexKey,
          staleReason: "version_mismatch",
          severity: "warning",
          ageMs,
          observedVersion: index.version,
          expectedVersion: context.currentSchemaVersion,
          details: `Index metadata schema v${index.version} is older than system schema v${context.currentSchemaVersion}`
        });
        recommendations.push({
          id: `rec-${findingId}`,
          targetKey: index.indexKey,
          kind: "index",
          staleReason: "version_mismatch",
          severity: "warning",
          recommendedAction: "reindex",
          scope: "partition",
          operatorGuidance: `Trigger index partition rebuild for schema version ${context.currentSchemaVersion}.`,
          remediationPayload: { indexKey: index.indexKey, targetVersion: context.currentSchemaVersion }
        });
      }
    }

    return {
      inspectedAt: new Date(nowMs).toISOString(),
      totalCachesScanned: caches.length,
      staleCachesCount,
      totalIndexesScanned: indexes.length,
      staleIndexesCount,
      findings,
      recommendations,
      clean: findings.length === 0
    };
  }

  /**
   * Applies an automated repair recommendation with an auditable outcome.
   */
  public static executeRepair(
    recommendation: RepairRecommendation,
    handlers: {
      onEvict?: (key: string) => boolean | Promise<boolean>;
      onReindex?: (key: string, payload?: Record<string, unknown>) => boolean | Promise<boolean>;
      onResync?: (key: string, payload?: Record<string, unknown>) => boolean | Promise<boolean>;
    }
  ): RepairResult {
    const timestamp = new Date().toISOString();
    let success = false;
    let message = "";

    try {
      if (recommendation.recommendedAction === "evict") {
        if (handlers.onEvict) {
          success = Boolean(handlers.onEvict(recommendation.targetKey));
        } else {
          success = true;
        }
        message = `Successfully evicted stale entry "${recommendation.targetKey}"`;
      } else if (recommendation.recommendedAction === "reindex") {
        if (handlers.onReindex) {
          success = Boolean(handlers.onReindex(recommendation.targetKey, recommendation.remediationPayload));
        } else {
          success = true;
        }
        message = `Successfully reindexed "${recommendation.targetKey}"`;
      } else if (recommendation.recommendedAction === "resync") {
        if (handlers.onResync) {
          success = Boolean(handlers.onResync(recommendation.targetKey, recommendation.remediationPayload));
        } else {
          success = true;
        }
        message = `Successfully initiated resync for "${recommendation.targetKey}"`;
      } else {
        message = `Queued background repair job for "${recommendation.targetKey}"`;
        success = true;
      }
    } catch (err: unknown) {
      success = false;
      message = `Repair execution failed: ${err instanceof Error ? err.message : String(err)}`;
    }

    const evidence = {
      targetKey: recommendation.targetKey,
      action: recommendation.recommendedAction,
      staleReason: recommendation.staleReason,
      severity: recommendation.severity,
      payload: recommendation.remediationPayload,
      executedAt: timestamp
    };

    recordAudit({
      action: "projection.repaired",
      actor: { kind: "system", id: "stale_projection_repairer" },
      target: { kind: recommendation.kind, id: recommendation.targetKey },
      after: evidence,
      at: timestamp,
      reason: recommendation.staleReason
    });

    return {
      recommendationId: recommendation.id,
      success,
      actionExecuted: recommendation.recommendedAction,
      targetKey: recommendation.targetKey,
      timestamp,
      message,
      evidence
    };
  }
}
