/**
 * Bounded cache with explicit invalidation and stale detection (#270)
 *
 * A least-recently-used cache for projections of ledger state (Horizon and RPC
 * reads). It never grows past `maxEntries`, and it never serves a value that
 * the stale rules in `StaleProjectionDetector` would flag:
 *
 * - an entry older than its TTL is `cache_expired`;
 * - a write carrying an older ledger sequence than the entry it would replace
 *   is refused as `cache_stale_write`, so an out-of-order response cannot roll
 *   a projection back.
 *
 * Expired entries are dropped when they are read, so expiry costs nothing
 * until the key is touched again. `snapshot()` exposes the live entries in the
 * `CacheEntry` shape (stamped with `schemaVersion`), so the existing detector
 * reports schema skew, ledger drift and orphans for this cache as-is.
 *
 * Complexity: `get`, `set`, `invalidate` and `getOrLoad` are O(1) — a `Map`
 * keeps insertion order, so re-inserting on access makes its first key the
 * least recently used. `invalidateWhere`, `clear` and `snapshot` are O(n).
 * Space is O(maxEntries + loads in flight).
 */

import { hasPermission } from "@/core/auth/types";
import type { AuthContext } from "@/core/auth/middleware";
import { err, ok, type Result } from "@/core/result/result";
import { emitTelemetry, newCorrelationId } from "@/core/telemetry/telemetry";
import type { CacheEntry } from "./types.ts";

export type CacheReadErrorCode = "cache_miss" | "cache_expired";
export type CacheWriteErrorCode = "cache_stale_write";
export type CacheFlushErrorCode = "cache_unauthorized";

export interface BoundedCacheOptions {
  /** Upper bound on stored entries; the least recently used one is evicted. */
  readonly maxEntries: number;
  /** Default time-to-live for an entry, in milliseconds. */
  readonly ttlMs: number;
  /** Stamped on every entry for `StaleProjectionDetector`. Defaults to 1. */
  readonly schemaVersion?: number;
  /** Telemetry label, e.g. `horizon.accounts`. */
  readonly name?: string;
  /** Injected clock. Defaults to the wall clock. */
  readonly now?: () => number;
}

export interface CacheWriteOptions {
  /** Overrides the cache-wide TTL for this entry. */
  readonly ttlMs?: number;
  /** Ledger the value was read at. Writes may not move it backwards. */
  readonly ledgerSequence?: number;
  /** Primary record this value projects, for orphan detection. */
  readonly sourceEntityId?: string;
}

export interface CacheStats {
  readonly size: number;
  readonly hits: number;
  readonly misses: number;
  readonly evictions: number;
  readonly invalidations: number;
}

export type CacheLoader<V, C extends string> = () => Promise<Result<V, C>>;

export interface BoundedCache<V> {
  get(key: string): Result<V, CacheReadErrorCode>;
  set(key: string, value: V, options?: CacheWriteOptions): Result<true, CacheWriteErrorCode>;
  /**
   * Returns the cached value or runs `load` once for every concurrent caller.
   * A failed load is never cached, so the next call retries it. A load that
   * was invalidated while in flight returns its value but does not store it.
   */
  getOrLoad<C extends string>(
    key: string,
    load: CacheLoader<V, C>,
    options?: CacheWriteOptions
  ): Promise<Result<V, C | CacheWriteErrorCode>>;
  /** Drops one key and any load in flight for it. */
  invalidate(key: string): boolean;
  /** Drops every key the predicate selects and returns how many went. */
  invalidateWhere(predicate: (entry: CacheEntry<V>) => boolean): number;
  /** Drops everything. An operator action: requires `admin:recovery`. */
  clear(auth: AuthContext, reason: string): Result<number, CacheFlushErrorCode>;
  /** Live entries in the shape `StaleProjectionDetector.inspect` reads. */
  snapshot(): CacheEntry<V>[];
  stats(): CacheStats;
}

interface StoredEntry<V> {
  readonly value: V;
  readonly cachedAt: number;
  readonly ttlMs: number;
  readonly version: number;
  readonly ledgerSequence?: number;
  readonly sourceEntityId?: string;
}

function requirePositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer, received ${value}`);
  }
}

export function createBoundedCache<V>(options: BoundedCacheOptions): BoundedCache<V> {
  const { maxEntries, ttlMs, schemaVersion = 1, name = "cache" } = options;
  requirePositiveInteger("maxEntries", maxEntries);
  requirePositiveInteger("ttlMs", ttlMs);
  requirePositiveInteger("schemaVersion", schemaVersion);
  const now = options.now ?? (() => Date.now());

  const entries = new Map<string, StoredEntry<V>>();
  // The promise identity is the load's token: a load may only store its value
  // while it is still the registered load for its key.
  const inflight = new Map<string, Promise<Result<V, string>>>();
  let hits = 0;
  let misses = 0;
  let evictions = 0;
  let invalidations = 0;

  /** Same boundary as `StaleProjectionDetector`: stale once age exceeds the TTL. */
  function isExpired(entry: StoredEntry<V>, at: number): boolean {
    return at - entry.cachedAt > entry.ttlMs;
  }

  function toCacheEntry(key: string, entry: StoredEntry<V>): CacheEntry<V> {
    return {
      key,
      value: entry.value,
      cachedAt: entry.cachedAt,
      ttlMs: entry.ttlMs,
      version: entry.version,
      ledgerSequence: entry.ledgerSequence,
      sourceEntityId: entry.sourceEntityId
    };
  }

  function get(key: string): Result<V, CacheReadErrorCode> {
    const entry = entries.get(key);
    if (!entry) {
      misses += 1;
      return err("cache_miss");
    }
    if (isExpired(entry, now())) {
      entries.delete(key);
      misses += 1;
      return err("cache_expired");
    }
    // Re-insert so the Map's first key stays the least recently used.
    entries.delete(key);
    entries.set(key, entry);
    hits += 1;
    return ok(entry.value);
  }

  function set(key: string, value: V, write: CacheWriteOptions = {}): Result<true, CacheWriteErrorCode> {
    // A NaN TTL would never expire (`age > NaN` is false), so it is refused like a bad bound.
    if (write.ttlMs !== undefined) requirePositiveInteger("ttlMs", write.ttlMs);
    const at = now();
    const current = entries.get(key);
    if (
      current &&
      !isExpired(current, at) &&
      current.ledgerSequence !== undefined &&
      write.ledgerSequence !== undefined &&
      write.ledgerSequence < current.ledgerSequence
    ) {
      return err("cache_stale_write");
    }

    entries.delete(key);
    entries.set(key, {
      value,
      cachedAt: at,
      ttlMs: write.ttlMs ?? ttlMs,
      version: schemaVersion,
      ledgerSequence: write.ledgerSequence,
      sourceEntityId: write.sourceEntityId
    });
    if (entries.size > maxEntries) {
      entries.delete(entries.keys().next().value as string);
      evictions += 1;
    }
    return ok(true);
  }

  async function getOrLoad<C extends string>(
    key: string,
    load: CacheLoader<V, C>,
    write?: CacheWriteOptions
  ): Promise<Result<V, C | CacheWriteErrorCode>> {
    const cached = get(key);
    if (cached.ok) return cached;

    const pending = inflight.get(key) as Promise<Result<V, C | CacheWriteErrorCode>> | undefined;
    if (pending) return pending;

    // `load` starts on the next microtask, so `run` is always assigned before
    // either callback compares against it — even when `load` throws at once.
    const run: Promise<Result<V, C | CacheWriteErrorCode>> = Promise.resolve()
      .then(load)
      .then((loaded) => {
        if (!loaded.ok || inflight.get(key) !== run) return loaded;
        const stored = set(key, loaded.value, write);
        return stored.ok ? loaded : stored;
      })
      .finally(() => {
        if (inflight.get(key) === run) inflight.delete(key);
      });
    inflight.set(key, run);
    return run;
  }

  function invalidate(key: string): boolean {
    inflight.delete(key);
    const removed = entries.delete(key);
    if (removed) invalidations += 1;
    return removed;
  }

  function invalidateWhere(predicate: (entry: CacheEntry<V>) => boolean): number {
    let removed = 0;
    for (const [key, entry] of entries) {
      if (predicate(toCacheEntry(key, entry))) {
        entries.delete(key);
        inflight.delete(key);
        removed += 1;
      }
    }
    invalidations += removed;
    return removed;
  }

  function clear(auth: AuthContext, reason: string): Result<number, CacheFlushErrorCode> {
    const correlationId = newCorrelationId();
    if (!hasPermission(auth.role, "admin:recovery")) {
      emitTelemetry({
        op: "cache.flushed",
        actorType: "user",
        result: "failure",
        correlationId,
        errorCode: "cache_unauthorized",
        payload: { cache: name, role: auth.role }
      });
      return err("cache_unauthorized");
    }

    const removed = entries.size;
    entries.clear();
    inflight.clear();
    invalidations += removed;
    emitTelemetry({
      op: "cache.flushed",
      actorType: "user",
      result: "success",
      correlationId,
      payload: { cache: name, role: auth.role, removed, reason }
    });
    return ok(removed);
  }

  function snapshot(): CacheEntry<V>[] {
    return Array.from(entries, ([key, entry]) => toCacheEntry(key, entry));
  }

  function stats(): CacheStats {
    return { size: entries.size, hits, misses, evictions, invalidations };
  }

  return { get, set, getOrLoad, invalidate, invalidateWhere, clear, snapshot, stats };
}
