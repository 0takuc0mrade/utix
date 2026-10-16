/**
 * Stale Cache and Stale Index Detection Types (#236)
 *
 * Types for identifying, scoping, and repairing stale cache projections
 * and index mappings with operator-visible telemetry and evidence.
 */

export type StaleReason =
  | "ttl_expired"
  | "version_mismatch"
  | "ledger_drift"
  | "orphan_reference"
  | "index_inconsistency";

export type StaleSeverity = "info" | "warning" | "critical";

export type RepairAction =
  | "evict"
  | "reindex"
  | "resync"
  | "queue_repair_job";

export interface CacheEntry<T = unknown> {
  readonly key: string;
  readonly value: T;
  readonly cachedAt: number | string;
  readonly ttlMs: number;
  readonly version: number;
  readonly ledgerSequence?: number;
  readonly sourceEntityId?: string;
}

export interface IndexEntry {
  readonly indexKey: string;
  readonly targetId: string;
  readonly indexedAt: number | string;
  readonly version: number;
  readonly ledgerSequence?: number;
}

export interface StaleFinding {
  readonly id: string;
  readonly kind: "cache" | "index";
  readonly targetKey: string;
  readonly staleReason: StaleReason;
  readonly severity: StaleSeverity;
  readonly ageMs: number;
  readonly observedVersion?: number;
  readonly expectedVersion?: number;
  readonly observedSequence?: number;
  readonly authoritativeSequence?: number;
  readonly details: string;
}

export interface RepairRecommendation {
  readonly id: string;
  readonly targetKey: string;
  readonly kind: "cache" | "index";
  readonly staleReason: StaleReason;
  readonly severity: StaleSeverity;
  readonly recommendedAction: RepairAction;
  readonly scope: "single" | "partition" | "full";
  readonly operatorGuidance: string;
  readonly remediationPayload?: Record<string, unknown>;
}

export interface InspectionContext {
  readonly now?: number | Date;
  readonly currentSchemaVersion: number;
  readonly authoritativeLedgerSequence?: number;
  readonly primaryEntityIds?: ReadonlySet<string> | readonly string[];
  readonly maxToleratedDriftLedgers?: number;
}

export interface StaleInspectionReport {
  readonly inspectedAt: string;
  readonly totalCachesScanned: number;
  readonly staleCachesCount: number;
  readonly totalIndexesScanned: number;
  readonly staleIndexesCount: number;
  readonly findings: readonly StaleFinding[];
  readonly recommendations: readonly RepairRecommendation[];
  readonly clean: boolean;
}

export interface RepairResult {
  readonly recommendationId: string;
  readonly success: boolean;
  readonly actionExecuted: RepairAction;
  readonly targetKey: string;
  readonly timestamp: string;
  readonly message: string;
  readonly evidence: Record<string, unknown>;
}
