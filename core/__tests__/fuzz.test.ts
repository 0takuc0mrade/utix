import { describe, expect, it } from "vitest";
import { hasAllPermissions, hasAnyPermission, hasPermission, ROLE_PERMISSIONS, type Permission, type Role } from "@/core/auth/types";
import {
  AMOUNT_DECIMALS,
  amountToStroops,
  INT64_MAX,
  INT64_MIN,
  parseAmount,
  stroopsToAmount,
  type AmountParseError
} from "@/core/format/amount";
import { canonicalize, createIdempotencyStore, requestDigest } from "@/core/idempotency/idempotency";
import { parseJsonRpcResponse } from "@/core/rpc/client";

/**
 * Fuzz coverage for malformed payloads and boundary numeric values (#268).
 *
 * Inputs come from a seeded PRNG, so a failure reproduces exactly: rerun with
 * `FUZZ_SEED=<seed printed in the assertion message> npm test -- core/__tests__/fuzz`.
 * Each property states what must hold for *every* input — never throw, always
 * answer with a declared code — rather than what one hand-picked input returns.
 */
const SEED = Number(process.env.FUZZ_SEED ?? 0x5eed_0268);
const RUNS = 1_000;

/** mulberry32: tiny, fast, and good enough to spread inputs. Not crypto. */
function prng(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
  const int = (max: number) => Math.floor(next() * max);
  const pick = <T>(items: readonly T[]): T => items[int(items.length)];
  const string = (alphabet: string, maxLength: number) =>
    Array.from({ length: int(maxLength + 1) }, () => alphabet[int(alphabet.length)]).join("");
  /** Uniform over the full signed 64-bit range. */
  const int64 = () => {
    const high = BigInt(int(2 ** 32)) << 32n;
    return BigInt.asIntN(64, high | BigInt(int(2 ** 32)));
  };
  return { next, int, pick, string, int64 };
}

const BOUNDARY_NUMBERS = [
  0, -0, 1, -1, 0.1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY,
  Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1, Number.MIN_SAFE_INTEGER, Number.EPSILON,
  2 ** 31, -(2 ** 31) - 1, 2 ** 32, 2 ** 53, -32_600, -32_700
] as const;

/** Any JSON-ish value plus the non-JSON values a buggy upstream can produce. */
function arbitraryValue(random: ReturnType<typeof prng>, depth = 0): unknown {
  const leaves: (() => unknown)[] = [
    () => null,
    () => undefined,
    () => random.pick(BOUNDARY_NUMBERS),
    () => random.string("abc 2.0-\u0000\u{1F680}\"\\", 8),
    () => random.next() < 0.5,
    () => random.int64(),
    () => "2.0",
    () => Symbol("payload")
  ];
  if (depth >= 3 || random.next() < 0.4) return random.pick(leaves)();
  if (random.next() < 0.3) {
    return Array.from({ length: random.int(4) }, () => arbitraryValue(random, depth + 1));
  }
  const keys = ["jsonrpc", "id", "result", "error", "code", "message", "data", "__proto__", "constructor"];
  const object: Record<string, unknown> = {};
  for (let index = random.int(5); index > 0; index -= 1) {
    Object.defineProperty(object, random.pick(keys), {
      value: arbitraryValue(random, depth + 1),
      enumerable: true,
      configurable: true,
      writable: true
    });
  }
  if (random.next() < 0.1) object.self = object;
  return object;
}

const AMOUNT_ERRORS: readonly AmountParseError[] = [
  "empty",
  "grouping_separator",
  "invalid_format",
  "too_many_decimals",
  "negative",
  "out_of_range"
];

describe("fuzz: Stellar amount boundaries (#268)", () => {
  // developers.stellar.org: amounts are signed int64 stroops scaled by 10^7;
  // the largest is 922,337,203,685.4775807 and the smallest unit is 0.0000001.
  it.each([
    ["922337203685.4775807", false, INT64_MAX],
    ["922337203685.4775808", false, "out_of_range"],
    ["-922337203685.4775808", true, INT64_MIN],
    ["-922337203685.4775809", true, "out_of_range"],
    ["0.0000001", false, 1n],
    ["0.00000001", false, "too_many_decimals"],
    ["0", false, 0n],
    ["-0.0000001", false, "negative"],
    ["99999999999999999999999999", false, "out_of_range"]
  ] as const)("parseAmount(%s, allowNegative=%s) → %s", (raw, allowNegative, expected) => {
    const parsed = parseAmount(raw, { allowNegative });
    expect(parsed).toEqual(typeof expected === "bigint" ? { ok: true, value: expected } : { ok: false, code: expected });
  });

  it("round-trips every int64 stroop value through its canonical amount string", () => {
    const random = prng(SEED);
    const samples = [INT64_MAX, INT64_MIN, 0n, 1n, -1n, ...Array.from({ length: RUNS }, random.int64)];
    for (const stroops of samples) {
      const amount = stroopsToAmount(stroops);
      expect(amount, `seed ${SEED}`).toMatch(new RegExp(`^-?\\d+\\.\\d{${AMOUNT_DECIMALS}}$`));
      expect(parseAmount(amount, { allowNegative: true }), `seed ${SEED}: ${amount}`).toEqual({ ok: true, value: stroops });
      expect(amountToStroops(amount), `seed ${SEED}: ${amount}`).toBe(stroops);
    }
  });

  it("answers malformed amount input with a declared code and never throws", () => {
    const random = prng(SEED + 1);
    for (let run = 0; run < RUNS; run += 1) {
      const raw = random.string("0123456789.-+eE ,_'  ٣\t", 30);
      const parsed = parseAmount(raw, { allowNegative: random.next() < 0.5 });
      if (parsed.ok) {
        expect(parsed.value <= INT64_MAX && parsed.value >= INT64_MIN, `seed ${SEED + 1}: ${JSON.stringify(raw)}`).toBe(true);
      } else {
        expect(AMOUNT_ERRORS, `seed ${SEED + 1}: ${JSON.stringify(raw)}`).toContain(parsed.code);
      }
    }
  });
});

describe("fuzz: malformed JSON-RPC payloads (#268)", () => {
  it("rejects a non-integer error code (JSON-RPC 2.0 §5.1)", () => {
    for (const code of [1.5, Number.NaN, Number.POSITIVE_INFINITY, "-32000", null]) {
      const parsed = parseJsonRpcResponse({ jsonrpc: "2.0", id: 1, error: { code, message: "x" } }, 1);
      expect(parsed).toMatchObject({ error: { code: -32600 } });
    }
  });

  it("always returns a well-formed envelope and never throws", () => {
    const random = prng(SEED + 2);
    for (let run = 0; run < RUNS; run += 1) {
      const payload = arbitraryValue(random);
      const expectedId = random.pick([undefined, 1, "req-1"]);
      const parsed = parseJsonRpcResponse(payload, expectedId);
      const context = `seed ${SEED + 2}, run ${run}`;

      expect(parsed.jsonrpc, context).toBe("2.0");
      expect(parsed.id === null || ["string", "number"].includes(typeof parsed.id), context).toBe(true);
      expect("result" in parsed !== "error" in parsed, context).toBe(true);
      if ("error" in parsed) {
        expect(Number.isInteger(parsed.error.code), context).toBe(true);
        expect(typeof parsed.error.message, context).toBe("string");
      } else if (expectedId !== undefined) {
        expect(parsed.id, context).toBe(expectedId);
      }
    }
  });
});

describe("fuzz: idempotency payloads and keys (#268)", () => {
  it("digests any payload — including BigInt and cycles — deterministically", () => {
    const random = prng(SEED + 3);
    for (let run = 0; run < RUNS; run += 1) {
      const payload = arbitraryValue(random);
      expect(() => requestDigest(payload), `seed ${SEED + 3}, run ${run}`).not.toThrow();
      expect(requestDigest(payload), `seed ${SEED + 3}, run ${run}`).toBe(requestDigest(payload));
    }
  });

  it("keeps BigInt and cycle markers distinct from the JSON values they resemble", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const shared = { a: 1 };

    expect(canonicalize({ amount: 10n })).toBe('{"amount":10n}');
    expect(requestDigest({ amount: 10n })).not.toBe(requestDigest({ amount: 10 }));
    expect(requestDigest({ amount: 10n })).not.toBe(requestDigest({ amount: "10n" }));
    expect(canonicalize(cyclic)).toBe('{"self":#cycle}');
    expect(canonicalize([shared, shared])).toBe('[{"a":1},{"a":1}]');
  });

  it("answers any key with a claim or a declared rejection, and blocks the duplicate retry", () => {
    const random = prng(SEED + 4);
    const store = createIdempotencyStore({ now: () => 0 });
    const codes = ["idempotency_key_missing", "idempotency_key_invalid", "idempotency_in_flight"];
    for (let run = 0; run < RUNS; run += 1) {
      const key = random.pick([undefined, "", random.string("Aa0._:-/ é", 140)]);
      const request = { key, operation: "fuzz", request: arbitraryValue(random) };
      const first = store.begin(request);
      if (first.ok) {
        expect(store.begin(request), `seed ${SEED + 4}: ${JSON.stringify(key)}`).toEqual({
          ok: false,
          code: "idempotency_in_flight"
        });
        store.abandon(key!);
      } else {
        expect(codes, `seed ${SEED + 4}: ${JSON.stringify(key)}`).toContain(first.code);
      }
    }
  });
});

describe("fuzz: authorization with malformed roles (#268)", () => {
  const permissions = Object.values(ROLE_PERMISSIONS).flat() as Permission[];
  const known = Object.keys(ROLE_PERMISSIONS);

  it("denies, never throws, for an unknown role — including prototype keys", () => {
    const random = prng(SEED + 5);
    const roles = [
      "admin", "VIEWER", "", " viewer", "toString", "__proto__", "constructor", "hasOwnProperty",
      undefined, null, ...Array.from({ length: RUNS }, () => random.string("aeiorstvwnmc_ ", 12))
    ].filter((role) => !known.includes(role as string)) as unknown as Role[];

    for (const role of roles) {
      for (const permission of permissions) {
        expect(hasPermission(role, permission), `role ${JSON.stringify(role)}`).toBe(false);
      }
      expect(hasAnyPermission(role, permissions)).toBe(false);
      expect(hasAllPermissions(role, permissions)).toBe(false);
    }
  });

  it("still grants exactly the declared permissions to every known role", () => {
    for (const role of known as Role[]) {
      for (const permission of permissions) {
        expect(hasPermission(role, permission)).toBe(ROLE_PERMISSIONS[role].includes(permission));
      }
    }
  });
});
