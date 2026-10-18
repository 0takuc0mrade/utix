import { describe, expect, it, vi } from "vitest";
import {
  createVerificationStore,
  verifyReference,
  type ExternalReference,
  type ReferenceFetcher,
  type VerifyDeps
} from "@/core/references/verification";

const NOW = Date.parse("2026-01-10T12:00:00.000Z");
const REF: ExternalReference = {
  id: "ref-1",
  kind: "event_metadata",
  uri: "https://example.org/events/1.json"
};
const GOOD = { contentHash: "abc123", observedAt: new Date(NOW - 60_000).toISOString() };

function deps(fetcher: ReferenceFetcher, extra: Partial<VerifyDeps> = {}) {
  const sleep = vi.fn(async () => undefined);
  const store = createVerificationStore();
  return {
    sleep,
    store,
    args: {
      fetcher,
      store,
      sleep,
      now: () => NOW,
      policy: { timeoutMs: 20, maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 150 },
      ...extra
    }
  };
}

describe("verifyReference", () => {
  it("verifies a valid reference and persists the result with source metadata", async () => {
    const fetcher = vi.fn(async () => GOOD);
    const { args, store } = deps(fetcher);
    const record = await verifyReference(REF, args);

    expect(record).toEqual({
      referenceId: "ref-1",
      status: "verified",
      attempts: 1,
      checkedAt: new Date(NOW).toISOString(),
      source: { kind: "event_metadata", uri: REF.uri },
      contentHash: "abc123"
    });
    expect(store.get("ref-1")).toEqual(record);
  });

  it("fails an unsupported URI without fetching", async () => {
    const fetcher = vi.fn(async () => GOOD);
    const record = await verifyReference({ ...REF, uri: "http://example.org/x" }, deps(fetcher).args);
    expect(fetcher).not.toHaveBeenCalled();
    expect(record).toMatchObject({ status: "failed", attempts: 0, failure: { code: "invalid_reference" } });
  });

  it("times out a hung fetch and aborts it", async () => {
    let aborted = false;
    const fetcher: ReferenceFetcher = (_uri, signal) =>
      new Promise(() => signal.addEventListener("abort", () => (aborted = true)));
    const record = await verifyReference(REF, deps(fetcher, { policy: { timeoutMs: 10, maxAttempts: 1 } }).args);
    expect(aborted).toBe(true);
    expect(record.failure).toMatchObject({ code: "timeout", retriesExhausted: true });
  });

  it("fails a malformed response without retrying", async () => {
    const fetcher = vi.fn(async () => ({ contentHash: 42 }));
    const { args, sleep } = deps(fetcher);
    const record = await verifyReference(REF, args);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(record.failure).toMatchObject({ code: "malformed_response", retriesExhausted: false });
    expect(record.failure?.action).toBeTruthy();
  });

  it("rejects stale content and hash mismatches without retrying", async () => {
    const stale = vi.fn(async () => ({ ...GOOD, observedAt: new Date(NOW - 3 * 86_400_000).toISOString() }));
    expect((await verifyReference(REF, deps(stale).args)).failure?.code).toBe("stale_response");

    const fetcher = vi.fn(async () => GOOD);
    const mismatch = await verifyReference({ ...REF, expectedHash: "other" }, deps(fetcher).args);
    expect(mismatch.failure?.code).toBe("hash_mismatch");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("retries transient failures with capped exponential backoff, then succeeds", async () => {
    const fetcher = vi
      .fn<ReferenceFetcher>()
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce(GOOD);
    const { args, sleep } = deps(fetcher);
    const record = await verifyReference(REF, args);

    expect(record).toMatchObject({ status: "verified", attempts: 3 });
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([100, 150]);
  });

  it("settles as failed once retries are exhausted", async () => {
    const fetcher = vi.fn(async () => {
      throw new Error("503");
    });
    const { args, store } = deps(fetcher);
    const record = await verifyReference(REF, args);

    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(record).toMatchObject({
      status: "failed",
      attempts: 3,
      failure: { code: "unreachable", message: "503", retriesExhausted: true }
    });
    expect(store.list()).toEqual([record]);
  });
});
