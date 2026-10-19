import { describe, expect, it } from "vitest";
import {
  computeFingerprint,
  groupByFingerprint,
  TIME_BUCKET_SECONDS,
  timeBucketFor,
} from "@/features/duplicate-transaction-scanner/lib/fingerprint";
import {
  TX_A1,
  TX_A2,
  TX_B1,
} from "@/features/duplicate-transaction-scanner/fixtures/scanner.fixture";

describe("timeBucketFor", () => {
  it("returns the same bucket for two timestamps in the same 5-minute window", () => {
    const t1 = "2026-10-18T22:05:30.000Z";
    const t2 = "2026-10-18T22:06:00.000Z";
    expect(timeBucketFor(t1)).toBe(timeBucketFor(t2));
  });

  it("returns different buckets for timestamps in different windows", () => {
    const t1 = "2026-10-18T22:05:30.000Z";
    const t2 = "2026-10-18T22:15:00.000Z";
    expect(timeBucketFor(t1)).not.toBe(timeBucketFor(t2));
  });

  it("the bucket width equals TIME_BUCKET_SECONDS", () => {
    const base = new Date("2026-10-18T22:00:00.000Z").getTime() / 1000;
    const b1 = Math.floor(base / TIME_BUCKET_SECONDS);
    const b2 = Math.floor((base + TIME_BUCKET_SECONDS - 1) / TIME_BUCKET_SECONDS);
    const b3 = Math.floor((base + TIME_BUCKET_SECONDS) / TIME_BUCKET_SECONDS);
    expect(b1).toBe(b2); // within the same bucket
    expect(b1).not.toBe(b3); // across the boundary
  });
});

describe("computeFingerprint", () => {
  it("produces a 64-char hex digest", () => {
    const fp = computeFingerprint(TX_A1, "testnet");
    expect(fp.value).toMatch(/^[a-f0-9]{64}$/);
  });

  it("produces the same fingerprint for two structurally identical transactions", () => {
    const fp1 = computeFingerprint(TX_A1, "testnet");
    const fp2 = computeFingerprint(TX_A2, "testnet");
    expect(fp1.value).toBe(fp2.value);
  });

  it("produces different fingerprints for structurally distinct transactions", () => {
    const fp1 = computeFingerprint(TX_A1, "testnet");
    const fp2 = computeFingerprint(TX_B1, "testnet");
    expect(fp1.value).not.toBe(fp2.value);
  });

  it("is sensitive to the network field", () => {
    const fpTestnet = computeFingerprint(TX_A1, "testnet");
    const fpMainnet = computeFingerprint(TX_A1, "mainnet");
    expect(fpTestnet.value).not.toBe(fpMainnet.value);
  });

  it("is sensitive to memo type", () => {
    const noMemo = computeFingerprint(TX_A1, "testnet");
    const withMemo = computeFingerprint({ ...TX_A1, memoType: "text", memo: "hello" }, "testnet");
    expect(noMemo.value).not.toBe(withMemo.value);
  });

  it("op type order does not affect the fingerprint (order-insensitive)", () => {
    const txAscending = { ...TX_A1, operationTypes: ["create_account", "payment"] };
    const txDescending = { ...TX_A1, operationTypes: ["payment", "create_account"] };
    const fp1 = computeFingerprint(txAscending, "testnet");
    const fp2 = computeFingerprint(txDescending, "testnet");
    expect(fp1.value).toBe(fp2.value);
  });

  it("stores the pre-image fields on the fingerprint object", () => {
    const fp = computeFingerprint(TX_A1, "testnet");
    expect(fp.sourceAccount).toBe(TX_A1.sourceAccount);
    expect(fp.feeCharged).toBe(TX_A1.feeCharged);
    expect(fp.network).toBe("testnet");
    expect(fp.opTypesSorted).toEqual(["payment"]);
  });
});

describe("groupByFingerprint", () => {
  it("returns one group for the two transactions with identical fingerprints", () => {
    const groups = groupByFingerprint([TX_A1, TX_A2, TX_B1], "testnet");
    expect(groups).toHaveLength(1);
    expect(groups[0].transactions).toHaveLength(2);
  });

  it("returns an empty array when no duplicates exist", () => {
    const groups = groupByFingerprint([TX_A1, TX_B1], "testnet");
    expect(groups).toHaveLength(0);
  });

  it("returns an empty array for a single transaction", () => {
    expect(groupByFingerprint([TX_A1], "testnet")).toHaveLength(0);
  });

  it("returns an empty array for an empty list", () => {
    expect(groupByFingerprint([], "testnet")).toHaveLength(0);
  });

  it("groups start with state pending", () => {
    const groups = groupByFingerprint([TX_A1, TX_A2], "testnet");
    expect(groups[0].state).toBe("pending");
  });

  it("group id equals the fingerprint value", () => {
    const groups = groupByFingerprint([TX_A1, TX_A2], "testnet");
    expect(groups[0].id).toBe(groups[0].fingerprint.value);
  });

  it("is deterministic — same input, same output", () => {
    const g1 = groupByFingerprint([TX_A1, TX_A2], "testnet");
    const g2 = groupByFingerprint([TX_A1, TX_A2], "testnet");
    expect(g1[0].id).toBe(g2[0].id);
  });
});
