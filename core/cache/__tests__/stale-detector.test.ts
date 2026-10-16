import { describe, expect, it } from "vitest";
import { StaleProjectionDetector } from "../stale-detector";
import type { CacheEntry, IndexEntry, InspectionContext } from "../types";

describe("StaleProjectionDetector (#236)", () => {
  const baseTime = 1700000000000;

  const freshCaches: CacheEntry[] = [
    {
      key: "balance:GAAA:XLM",
      value: { balance: "150.00" },
      cachedAt: baseTime - 1000,
      ttlMs: 60000,
      version: 2,
      ledgerSequence: 50000,
      sourceEntityId: "GAAA"
    }
  ];

  const freshIndexes: IndexEntry[] = [
    {
      indexKey: "account:by_signer:GBBB",
      targetId: "GAAA",
      indexedAt: baseTime - 2000,
      version: 2,
      ledgerSequence: 50000
    }
  ];

  const defaultContext: InspectionContext = {
    now: baseTime,
    currentSchemaVersion: 2,
    authoritativeLedgerSequence: 50002,
    primaryEntityIds: new Set(["GAAA"]),
    maxToleratedDriftLedgers: 5
  };

  it("returns clean inspection report when caches and indexes are fresh", () => {
    const report = StaleProjectionDetector.inspect(freshCaches, freshIndexes, defaultContext);

    expect(report.clean).toBe(true);
    expect(report.staleCachesCount).toBe(0);
    expect(report.staleIndexesCount).toBe(0);
    expect(report.findings).toHaveLength(0);
    expect(report.recommendations).toHaveLength(0);
  });

  it("detects expired TTL and recommends eviction", () => {
    const expiredCaches: CacheEntry[] = [
      {
        key: "orderbook:XLM:USDC",
        value: { bids: [] },
        cachedAt: baseTime - 120000, // 2 minutes old
        ttlMs: 30000, // 30s TTL
        version: 2
      }
    ];

    const report = StaleProjectionDetector.inspect(expiredCaches, [], defaultContext);

    expect(report.clean).toBe(false);
    expect(report.staleCachesCount).toBe(1);
    expect(report.findings[0].staleReason).toBe("ttl_expired");
    expect(report.recommendations[0].recommendedAction).toBe("evict");
    expect(report.recommendations[0].operatorGuidance).toContain("Evict key");
  });

  it("detects schema version mismatch on cache entries", () => {
    const legacyCaches: CacheEntry[] = [
      {
        key: "account:data:GAAA",
        value: { legacy: true },
        cachedAt: baseTime - 5000,
        ttlMs: 60000,
        version: 1 // behind current v2
      }
    ];

    const report = StaleProjectionDetector.inspect(legacyCaches, [], defaultContext);

    expect(report.staleCachesCount).toBe(1);
    expect(report.findings[0].staleReason).toBe("version_mismatch");
    expect(report.findings[0].observedVersion).toBe(1);
    expect(report.recommendations[0].recommendedAction).toBe("resync");
  });

  it("detects ledger sequence drift behind authoritative head", () => {
    const driftedCaches: CacheEntry[] = [
      {
        key: "signer:GAAA",
        value: { weight: 1 },
        cachedAt: baseTime - 5000,
        ttlMs: 600000,
        version: 2,
        ledgerSequence: 49950 // 52 ledgers behind head 50002
      }
    ];

    const report = StaleProjectionDetector.inspect(driftedCaches, [], defaultContext);

    expect(report.staleCachesCount).toBe(1);
    expect(report.findings[0].staleReason).toBe("ledger_drift");
    expect(report.recommendations[0].recommendedAction).toBe("resync");
  });

  it("detects orphan references in cache when root entity does not exist", () => {
    const orphanCaches: CacheEntry[] = [
      {
        key: "balance:G_DELETED:XLM",
        value: { balance: "0" },
        cachedAt: baseTime - 5000,
        ttlMs: 600000,
        version: 2,
        sourceEntityId: "G_DELETED" // Not in primaryEntityIds
      }
    ];

    const report = StaleProjectionDetector.inspect(orphanCaches, [], defaultContext);

    expect(report.staleCachesCount).toBe(1);
    expect(report.findings[0].staleReason).toBe("orphan_reference");
    expect(report.recommendations[0].recommendedAction).toBe("evict");
  });

  it("detects index inconsistency when target entity is missing", () => {
    const corruptedIndexes: IndexEntry[] = [
      {
        indexKey: "lookup:tx_hash_abc",
        targetId: "DELETED_TX",
        indexedAt: baseTime - 1000,
        version: 2
      }
    ];

    const report = StaleProjectionDetector.inspect([], corruptedIndexes, defaultContext);

    expect(report.staleIndexesCount).toBe(1);
    expect(report.findings[0].staleReason).toBe("index_inconsistency");
    expect(report.findings[0].severity).toBe("critical");
    expect(report.recommendations[0].recommendedAction).toBe("reindex");
  });

  it("executes automated repair and produces operator-visible evidence", () => {
    const expiredCaches: CacheEntry[] = [
      {
        key: "test:cache:1",
        value: 123,
        cachedAt: baseTime - 100000,
        ttlMs: 5000,
        version: 2
      }
    ];

    const report = StaleProjectionDetector.inspect(expiredCaches, [], defaultContext);
    const recommendation = report.recommendations[0];

    let evictedKey = "";
    const result = StaleProjectionDetector.executeRepair(recommendation, {
      onEvict: (k) => {
        evictedKey = k;
        return true;
      }
    });

    expect(result.success).toBe(true);
    expect(evictedKey).toBe("test:cache:1");
    expect(result.evidence.targetKey).toBe("test:cache:1");
    expect(result.evidence.action).toBe("evict");
  });
});
