import { afterEach, describe, expect, it } from "vitest";
import { err, ok, type Result } from "@/core/result/result";
import {
  createCaptureSink,
  resetTelemetrySink,
  setTelemetrySink
} from "@/core/telemetry/telemetry";
import { createBoundedCache, type BoundedCacheOptions } from "../bounded-cache";
import { StaleProjectionDetector } from "../stale-detector";

const START = Date.parse("2026-10-17T00:00:00.000Z");

function harness(overrides: Partial<BoundedCacheOptions> = {}) {
  let clock = START;
  const cache = createBoundedCache<string>({
    maxEntries: 3,
    ttlMs: 1_000,
    now: () => clock,
    ...overrides
  });
  return { cache, advance: (ms: number) => (clock += ms) };
}

/** A loader whose settlement the test controls. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => (resolve = settle));
  return { promise, resolve };
}

afterEach(() => resetTelemetrySink());

describe("bounded cache (#270)", () => {
  describe("normal path", () => {
    it("serves a stored value until its TTL elapses", () => {
      const { cache, advance } = harness();
      cache.set("balance:GA", "100.0000000");

      advance(1_000);
      expect(cache.get("balance:GA")).toEqual(ok("100.0000000"));
      advance(1);
      expect(cache.get("balance:GA")).toEqual(err("cache_expired"));
      expect(cache.get("balance:GA")).toEqual(err("cache_miss"));
    });

    it("never holds more than maxEntries and evicts the least recently used key", () => {
      const { cache } = harness();
      cache.set("a", "1");
      cache.set("b", "2");
      cache.set("c", "3");
      cache.get("a");
      cache.set("d", "4");

      expect(cache.get("b")).toEqual(err("cache_miss"));
      expect(cache.snapshot().map((entry) => entry.key)).toEqual(["c", "a", "d"]);
      expect(cache.stats()).toMatchObject({ size: 3, evictions: 1 });
    });

    it("honours a per-entry TTL override", () => {
      const { cache, advance } = harness();
      cache.set("ledger:head", "5247219", { ttlMs: 5_000 });
      advance(4_000);
      expect(cache.get("ledger:head").ok).toBe(true);
    });

    it("rejects a per-entry TTL that could never expire or is already expired", () => {
      const { cache } = harness();
      for (const ttlMs of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 1.5]) {
        expect(() => cache.set("k", "v", { ttlMs })).toThrow(RangeError);
      }
      expect(cache.get("k")).toEqual(err("cache_miss"));
    });

    it("rejects a non-positive or fractional bound at construction", () => {
      expect(() => createBoundedCache({ maxEntries: 0, ttlMs: 1 })).toThrow(RangeError);
      expect(() => createBoundedCache({ maxEntries: 1, ttlMs: 0.5 })).toThrow(RangeError);
      expect(() => createBoundedCache({ maxEntries: 1, ttlMs: 1, schemaVersion: 0 })).toThrow(RangeError);
    });
  });

  describe("stale detection", () => {
    it("stamps entries with the schema version so a bump is reported as skew", () => {
      const { cache } = harness({ schemaVersion: 1 });
      cache.set("k", "v1-shape");

      const report = StaleProjectionDetector.inspect(cache.snapshot(), [], {
        now: START,
        currentSchemaVersion: 2
      });
      expect(report.findings.map((finding) => finding.staleReason)).toEqual(["version_mismatch"]);
    });

    it("refuses a write that would move a projection to an older ledger", () => {
      const { cache } = harness();
      expect(cache.set("account:GA", "seq-200", { ledgerSequence: 200 })).toEqual(ok(true));
      expect(cache.set("account:GA", "seq-199", { ledgerSequence: 199 })).toEqual(err("cache_stale_write"));
      expect(cache.get("account:GA")).toEqual(ok("seq-200"));
      expect(cache.set("account:GA", "seq-201", { ledgerSequence: 201 })).toEqual(ok(true));
    });

    it("accepts an older ledger once the newer entry has itself expired", () => {
      const { cache, advance } = harness();
      cache.set("account:GA", "seq-200", { ledgerSequence: 200 });
      advance(1_001);
      expect(cache.set("account:GA", "seq-199", { ledgerSequence: 199 })).toEqual(ok(true));
    });

    it("exposes a snapshot the existing StaleProjectionDetector can inspect", () => {
      const { cache, advance } = harness();
      cache.set("account:GA", "a", { ledgerSequence: 100, sourceEntityId: "GA" });
      cache.set("account:GB", "b", { ledgerSequence: 190, sourceEntityId: "GB" });
      advance(10);

      const report = StaleProjectionDetector.inspect(cache.snapshot(), [], {
        now: START + 10,
        currentSchemaVersion: 1,
        authoritativeLedgerSequence: 200,
        maxToleratedDriftLedgers: 5
      });

      expect(report.findings.map((finding) => [finding.targetKey, finding.staleReason])).toEqual([
        ["account:GA", "ledger_drift"],
        ["account:GB", "ledger_drift"]
      ]);
      const evicted = cache.invalidateWhere((entry) => (entry.ledgerSequence ?? 0) < 200 - 5);
      expect(evicted).toBe(2);
    });
  });

  describe("explicit invalidation", () => {
    it("drops one key and reports whether it existed", () => {
      const { cache } = harness();
      cache.set("a", "1");
      expect(cache.invalidate("a")).toBe(true);
      expect(cache.invalidate("a")).toBe(false);
      expect(cache.get("a")).toEqual(err("cache_miss"));
      expect(cache.stats().invalidations).toBe(1);
    });

    it("drops every key a predicate selects", () => {
      const { cache } = harness();
      cache.set("account:GA:balances", "1", { sourceEntityId: "GA" });
      cache.set("account:GA:signers", "2", { sourceEntityId: "GA" });
      cache.set("account:GB:balances", "3", { sourceEntityId: "GB" });

      expect(cache.invalidateWhere((entry) => entry.sourceEntityId === "GA")).toBe(2);
      expect(cache.snapshot().map((entry) => entry.key)).toEqual(["account:GB:balances"]);
    });
  });

  describe("failure and retry paths", () => {
    it("coalesces concurrent loads of one key into a single request", async () => {
      const { cache } = harness();
      const gate = deferred<Result<string, "horizon_unavailable">>();
      let calls = 0;
      const load = () => {
        calls += 1;
        return gate.promise;
      };

      const first = cache.getOrLoad("k", load);
      const second = cache.getOrLoad("k", load);
      gate.resolve(ok("value"));

      expect(await Promise.all([first, second])).toEqual([ok("value"), ok("value")]);
      await Promise.resolve();
      expect(calls).toBe(1);
      expect(cache.get("k")).toEqual(ok("value"));
    });

    it("does not cache a failed load, so the next call retries it", async () => {
      const { cache } = harness();
      const outcomes: Result<string, "horizon_unavailable">[] = [err("horizon_unavailable"), ok("value")];
      const load = async () => outcomes.shift()!;

      expect(await cache.getOrLoad("k", load)).toEqual(err("horizon_unavailable"));
      expect(cache.get("k")).toEqual(err("cache_miss"));
      expect(await cache.getOrLoad("k", load)).toEqual(ok("value"));
      expect(cache.get("k")).toEqual(ok("value"));
    });

    it("releases the in-flight slot when a loader throws", async () => {
      const { cache } = harness();
      const thrower = () => {
        throw new Error("transport");
      };

      await expect(cache.getOrLoad("k", thrower)).rejects.toThrow("transport");
      expect(await cache.getOrLoad("k", async () => ok("recovered"))).toEqual(ok("recovered"));
    });

    it("does not store a load that was invalidated while it was in flight", async () => {
      const { cache } = harness();
      const stale = deferred<Result<string, never>>();

      const pending = cache.getOrLoad("k", () => stale.promise);
      cache.invalidate("k");
      const fresh = cache.getOrLoad("k", async () => ok("fresh"));
      stale.resolve(ok("stale"));

      expect(await pending).toEqual(ok("stale"));
      expect(await fresh).toEqual(ok("fresh"));
      expect(cache.get("k")).toEqual(ok("fresh"));
    });

    it("returns cache_stale_write when a slow load lost the race to a newer ledger", async () => {
      const { cache } = harness();
      const slow = deferred<Result<string, never>>();

      const pending = cache.getOrLoad("account:GA", () => slow.promise, { ledgerSequence: 290 });
      cache.set("account:GA", "seq-302", { ledgerSequence: 302 });
      slow.resolve(ok("seq-290"));

      expect(await pending).toEqual(err("cache_stale_write"));
      expect(cache.get("account:GA")).toEqual(ok("seq-302"));
    });
  });

  describe("authorization path", () => {
    it("refuses a full flush from a role without admin:recovery", () => {
      const sink = createCaptureSink();
      setTelemetrySink(sink);
      const { cache } = harness();
      cache.set("a", "1");

      expect(cache.clear({ role: "viewer" }, "manual")).toEqual(err("cache_unauthorized"));
      expect(cache.clear({ role: "service" }, "manual")).toEqual(err("cache_unauthorized"));
      expect(cache.get("a")).toEqual(ok("1"));
      expect(sink.events.at(-1)).toMatchObject({
        op: "cache.flushed",
        result: "failure",
        errorCode: "cache_unauthorized"
      });
    });

    it("lets a maintainer flush everything, including loads in flight", async () => {
      const sink = createCaptureSink();
      setTelemetrySink(sink);
      const { cache } = harness();
      cache.set("a", "1");
      cache.set("b", "2");
      const gate = deferred<Result<string, never>>();
      const pending = cache.getOrLoad("c", () => gate.promise);

      expect(cache.clear({ role: "maintainer" }, "schema rollback")).toEqual(ok(2));
      gate.resolve(ok("3"));
      await pending;

      expect(cache.stats().size).toBe(0);
      expect(sink.events.at(-1)).toMatchObject({
        op: "cache.flushed",
        result: "success",
        payload: { removed: 2, reason: "schema rollback" }
      });
    });
  });
});
