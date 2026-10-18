import { describe, expect, it } from "vitest";
import {
  createIdempotencyStore,
  withIdempotency,
  type IdempotencyStorage
} from "@/core/idempotency/idempotency";
import { err, ok, type Result } from "@/core/result/result";

/**
 * Duplicate submissions under concurrency (#271).
 *
 * `withIdempotency` claims its key synchronously, before its first `await`, so
 * the order in which two submissions reach `begin` is the order they were
 * issued. Every test drives that order explicitly: a submission's work is held
 * open on a gate the test releases, so "still in flight" is a fact of the test
 * and not a guess about scheduling.
 */
const START = Date.parse("2026-10-17T00:00:00.000Z");
const KEY = "submit-payment-csv-0001";

function sharedStorage(): IdempotencyStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key)
  };
}

function gate<T>() {
  let release!: (value: T) => void;
  const promise = new Promise<T>((resolve) => (release = resolve));
  return { promise, release };
}

function counted<T>(outcome: () => Promise<Result<T, string>>) {
  let runs = 0;
  return {
    run: () => {
      runs += 1;
      return outcome();
    },
    get runs() {
      return runs;
    }
  };
}

describe("idempotent submissions under concurrency (#271)", () => {
  it("runs the work once when the same submission arrives twice at the same time", async () => {
    const store = createIdempotencyStore({ storage: sharedStorage(), now: () => START });
    const held = gate<Result<string, string>>();
    const work = counted(() => held.promise);
    const submit = () => withIdempotency(store, { key: KEY, operation: "export.generate", request: { rows: 3 }, run: work.run });

    const first = submit();
    const duplicate = submit();
    held.release(ok("artifact-1"));

    expect(await duplicate).toEqual(err("idempotency_in_flight"));
    expect(await first).toMatchObject({ ok: true, value: { value: "artifact-1", replayed: false } });
    expect(work.runs).toBe(1);
  });

  it("replays the first outcome to every retry once it has settled", async () => {
    const store = createIdempotencyStore({ storage: sharedStorage(), now: () => START });
    const work = counted(async () => ok("artifact-1"));
    const submit = () => withIdempotency(store, { key: KEY, operation: "export.generate", request: { rows: 3 }, run: work.run });

    await submit();
    const retries = await Promise.all([submit(), submit(), submit()]);

    expect(retries.every((retry) => retry.ok && retry.value.replayed && retry.value.value === "artifact-1")).toBe(true);
    expect(work.runs).toBe(1);
    expect(store.lookup(KEY)).toMatchObject({ ok: true, value: { replays: 3 } });
  });

  it("deduplicates across two tabs that share one storage", async () => {
    const storage = sharedStorage();
    const tabA = createIdempotencyStore({ storage, now: () => START });
    const tabB = createIdempotencyStore({ storage, now: () => START });
    const held = gate<Result<string, string>>();
    const work = counted(() => held.promise);

    const fromA = withIdempotency(tabA, { key: KEY, operation: "notify.send", run: work.run });
    const fromB = withIdempotency(tabB, { key: KEY, operation: "notify.send", run: work.run });
    held.release(ok("sent"));

    expect(await fromB).toEqual(err("idempotency_in_flight"));
    expect((await fromA).ok).toBe(true);
    expect(await withIdempotency(tabB, { key: KEY, operation: "notify.send", run: work.run })).toMatchObject({
      ok: true,
      value: { value: "sent", replayed: true }
    });
    expect(work.runs).toBe(1);
  });

  it("replays a recorded failure instead of re-running the work on retry", async () => {
    const store = createIdempotencyStore({ storage: sharedStorage(), now: () => START });
    const held = gate<Result<string, string>>();
    const work = counted(() => held.promise);
    const submit = () => withIdempotency(store, { key: KEY, operation: "worker.enqueue", run: work.run });

    const first = submit();
    const duplicate = submit();
    held.release(err("horizon_unavailable"));

    expect(await duplicate).toEqual(err("idempotency_in_flight"));
    expect(await first).toEqual(err("horizon_unavailable"));
    expect(await submit()).toEqual(err("horizon_unavailable"));
    expect(work.runs).toBe(1);
  });

  it("records a thrown error, so a concurrent retry cannot slip a second run in", async () => {
    const store = createIdempotencyStore({ storage: sharedStorage(), now: () => START });
    const work = counted<string>(async () => {
      throw new TypeError("network");
    });
    const submit = () => withIdempotency(store, { key: KEY, operation: "worker.enqueue", run: work.run });

    expect(await Promise.all([submit(), submit()])).toEqual([err("TypeError"), err("idempotency_in_flight")]);
    expect(await submit()).toEqual(err("TypeError"));
    expect(work.runs).toBe(1);
  });

  it("lets a retry run again only after the stuck claim is explicitly abandoned", async () => {
    const store = createIdempotencyStore({ storage: sharedStorage(), now: () => START });
    expect(store.begin({ key: KEY, operation: "worker.enqueue" }).ok).toBe(true);

    const work = counted(async () => ok("done"));
    const submit = () => withIdempotency(store, { key: KEY, operation: "worker.enqueue", run: work.run });

    expect(await submit()).toEqual(err("idempotency_in_flight"));
    expect(store.abandon(KEY)).toEqual(ok(true));
    expect(await submit()).toMatchObject({ ok: true, value: { value: "done", replayed: false } });
    expect(work.runs).toBe(1);
  });

  it("rejects a concurrent submission that reuses the key for a different payload", async () => {
    const store = createIdempotencyStore({ storage: sharedStorage(), now: () => START });
    const held = gate<Result<string, string>>();
    const work = counted(() => held.promise);

    const first = withIdempotency(store, { key: KEY, operation: "export.generate", request: { rows: 3 }, run: work.run });
    const altered = withIdempotency(store, { key: KEY, operation: "export.generate", request: { rows: 4 }, run: work.run });
    held.release(ok("artifact-1"));

    expect(await altered).toEqual(err("idempotency_key_conflict"));
    expect((await first).ok).toBe(true);
    expect(work.runs).toBe(1);
  });

  it("does not let another operation replay a recorded outcome under the same key", async () => {
    const store = createIdempotencyStore({ storage: sharedStorage(), now: () => START });
    await withIdempotency(store, { key: KEY, operation: "export.generate", run: async () => ok("private-artifact") });

    const foreign = await withIdempotency(store, {
      key: KEY,
      operation: "notify.send",
      run: async () => ok("never")
    });

    expect(foreign).toEqual(err("idempotency_key_conflict"));
  });

  it("refuses a late duplicate after the replay window instead of running twice", async () => {
    let clock = START;
    const store = createIdempotencyStore({ storage: sharedStorage(), now: () => clock, ttlMs: 1_000 });
    const work = counted(async () => ok("done"));
    const submit = () => withIdempotency(store, { key: KEY, operation: "worker.enqueue", run: work.run });

    await submit();
    clock += 1_000;
    expect(await submit()).toEqual(err("idempotency_key_expired"));
    expect(work.runs).toBe(1);
  });
});
