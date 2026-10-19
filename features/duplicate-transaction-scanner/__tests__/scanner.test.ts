import { describe, expect, it } from "vitest";
import { withMswHandlers } from "@/core/testing/msw";
import { scanForDuplicates } from "@/features/duplicate-transaction-scanner/lib/scanner";
import {
  handlers,
  notFoundHandler,
  rateLimitedHandler,
} from "@/features/duplicate-transaction-scanner/msw/handlers";
import {
  HASH_A1,
  HASH_A2,
  HASH_B1,
} from "@/features/duplicate-transaction-scanner/fixtures/scanner.fixture";

const server = withMswHandlers(...handlers);

const TESTNET_BASE = "https://horizon-testnet.stellar.org";

describe("scanForDuplicates", () => {
  it("returns one duplicate group for two identical transactions", async () => {
    const result = await scanForDuplicates(
      { hashes: [HASH_A1, HASH_A2], network: "testnet" },
      TESTNET_BASE,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.scannedCount).toBe(2);
    expect(result.value.groupCount).toBe(1);
    expect(result.value.groups).toHaveLength(1);
    expect(result.value.groups[0].transactions).toHaveLength(2);
    expect(result.value.groups[0].state).toBe("pending");
  });

  it("returns no groups when there are no duplicates", async () => {
    const result = await scanForDuplicates(
      { hashes: [HASH_A1, HASH_B1], network: "testnet" },
      TESTNET_BASE,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.groupCount).toBe(0);
    expect(result.value.scannedCount).toBe(2);
  });

  it("returns not_found when a hash is missing from Horizon", async () => {
    server.use(notFoundHandler);
    const result = await scanForDuplicates(
      { hashes: [HASH_A1], network: "testnet" },
      TESTNET_BASE,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("not_found");
  });

  it("returns rate_limited on HTTP 429", async () => {
    server.use(rateLimitedHandler);
    const result = await scanForDuplicates(
      { hashes: [HASH_A1], network: "testnet" },
      TESTNET_BASE,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("rate_limited");
  });

  it("includes the network and scannedAt in the result", async () => {
    const result = await scanForDuplicates(
      { hashes: [HASH_A1, HASH_A2], network: "testnet" },
      TESTNET_BASE,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.network).toBe("testnet");
    expect(result.value.scannedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("duplicate groups have deterministic ids (same input → same group id)", async () => {
    const r1 = await scanForDuplicates(
      { hashes: [HASH_A1, HASH_A2], network: "testnet" },
      TESTNET_BASE,
    );
    const r2 = await scanForDuplicates(
      { hashes: [HASH_A1, HASH_A2], network: "testnet" },
      TESTNET_BASE,
    );
    expect(r1.ok && r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    expect(r1.value.groups[0].id).toBe(r2.value.groups[0].id);
  });
});
