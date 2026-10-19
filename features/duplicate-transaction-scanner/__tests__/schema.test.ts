import { describe, expect, it } from "vitest";
import { MAX_HASHES, parseDuplicateScanInput } from "@/features/duplicate-transaction-scanner/schema";
import { HASH_A1, HASH_A2 } from "@/features/duplicate-transaction-scanner/fixtures/scanner.fixture";

describe("parseDuplicateScanInput", () => {
  it("rejects empty input", () => {
    expect(parseDuplicateScanInput("", "testnet")).toEqual({ ok: false, code: "empty_input" });
    expect(parseDuplicateScanInput("   \n\n  ", "testnet")).toEqual({ ok: false, code: "empty_input" });
  });

  it("accepts a single valid hash", () => {
    const result = parseDuplicateScanInput(HASH_A1, "testnet");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.hashes).toEqual([HASH_A1]);
    expect(result.value.network).toBe("testnet");
  });

  it("accepts multiple hashes separated by newlines", () => {
    const result = parseDuplicateScanInput(`${HASH_A1}\n${HASH_A2}`, "testnet");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.hashes).toHaveLength(2);
  });

  it("normalises hashes to lower case", () => {
    const upper = HASH_A1.toUpperCase();
    const result = parseDuplicateScanInput(upper, "testnet");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.hashes[0]).toBe(HASH_A1);
  });

  it("deduplicates hashes submitted twice", () => {
    const result = parseDuplicateScanInput(`${HASH_A1}\n${HASH_A1}`, "testnet");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.hashes).toHaveLength(1);
  });

  it("rejects a non-hex string", () => {
    const bad = "z".repeat(64);
    expect(parseDuplicateScanInput(bad, "testnet")).toEqual({ ok: false, code: "invalid_hash" });
  });

  it("rejects a hash that is too short", () => {
    const short = "a".repeat(63);
    expect(parseDuplicateScanInput(short, "testnet")).toEqual({ ok: false, code: "invalid_hash" });
  });

  it("rejects a hash that is too long", () => {
    const long = "a".repeat(65);
    expect(parseDuplicateScanInput(long, "testnet")).toEqual({ ok: false, code: "invalid_hash" });
  });

  it(`rejects more than ${MAX_HASHES} hashes`, () => {
    const hashes = Array.from({ length: MAX_HASHES + 1 }, (_, i) =>
      String(i).padStart(2, "0").padEnd(64, "0"),
    ).join("\n");
    expect(parseDuplicateScanInput(hashes, "testnet")).toEqual({
      ok: false,
      code: "too_many_hashes",
    });
  });

  it(`accepts exactly ${MAX_HASHES} hashes`, () => {
    const hashes = Array.from({ length: MAX_HASHES }, (_, i) =>
      String(i).padStart(2, "0").padEnd(64, "0"),
    ).join("\n");
    const result = parseDuplicateScanInput(hashes, "testnet");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.hashes).toHaveLength(MAX_HASHES);
  });

  it("strips surrounding whitespace from each line", () => {
    const result = parseDuplicateScanInput(`  ${HASH_A1}  \n  ${HASH_A2}  `, "testnet");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.hashes).toEqual([HASH_A1, HASH_A2]);
  });
});
