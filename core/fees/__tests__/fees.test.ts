import { describe, expect, it } from "vitest";
import {
  calculateFees,
  explainFees,
  formatAssetAmount,
  parseAssetAmount,
  reconcileFees
} from "../fees";
import type { FeeAsset, FeeBreakdown, FeeSchedule } from "../types";

const XLM: FeeAsset = { code: "XLM", decimals: 7 };

const MULTI_LINE: FeeSchedule = {
  lines: [
    { id: "protocol", label: "Protocol fee", basisPoints: 100 },
    { id: "organizer", label: "Organizer fee", basisPoints: 250 }
  ]
};

function breakdown(amount: bigint, schedule: FeeSchedule, asset: FeeAsset = XLM): FeeBreakdown {
  const result = calculateFees({ asset, amount, schedule });
  if (!result.ok) throw new Error(`expected a breakdown, got ${result.code}`);
  return result.value;
}

describe("fee calculation (#182)", () => {
  it("charges nothing for a zero-rate schedule and for a zero amount", () => {
    const free = breakdown(1_000_000_000n, { lines: [{ id: "protocol", label: "Protocol", basisPoints: 0 }] });
    expect(free.totalFees).toBe(0n);
    expect(free.net).toBe(1_000_000_000n);
    expect(free.lines[0].basis).toBe("zero");

    const empty = breakdown(0n, {
      lines: [{ id: "protocol", label: "Protocol", basisPoints: 100, minimum: 50_000n }]
    });
    expect(empty.totalFees).toBe(0n);
    expect(empty.lines[0].basis).toBe("zero");
  });

  it("raises a line to its minimum when the rate amount is below it", () => {
    const result = breakdown(1_000_000n, {
      lines: [{ id: "protocol", label: "Protocol", basisPoints: 100, minimum: 50_000n }]
    });
    expect(result.lines[0]).toMatchObject({ rateAmount: 10_000n, amount: 50_000n, basis: "minimum" });
    expect(result.net).toBe(950_000n);
  });

  it("keeps the rate amount when it is above the minimum", () => {
    const result = breakdown(1_000_000_000n, {
      lines: [{ id: "protocol", label: "Protocol", basisPoints: 100, minimum: 50_000n }]
    });
    expect(result.lines[0]).toMatchObject({ amount: 10_000_000n, basis: "rate" });
  });

  it("itemizes several lines that add up to the total", () => {
    const result = breakdown(1_000_000_000n, MULTI_LINE);
    expect(result.lines.map((line) => [line.id, line.amount])).toEqual([
      ["protocol", 10_000_000n],
      ["organizer", 25_000_000n]
    ]);
    expect(result.totalFees).toBe(35_000_000n);
    expect(result.net).toBe(965_000_000n);
    expect(result.totalFees + result.net).toBe(result.gross);
  });

  it("rounds each line half up to the smallest unit", () => {
    const tenPercent: FeeSchedule = { lines: [{ id: "fee", label: "Fee", basisPoints: 1000 }] };
    expect(breakdown(14n, tenPercent).lines[0].amount).toBe(1n); // 1.4
    expect(breakdown(15n, tenPercent).lines[0].amount).toBe(2n); // 1.5
    expect(breakdown(5n, tenPercent).lines[0].amount).toBe(1n); // 0.5
    expect(breakdown(4n, tenPercent).lines[0].amount).toBe(0n); // 0.4
  });

  it("is deterministic for identical inputs", () => {
    expect(breakdown(123_456_789n, MULTI_LINE)).toEqual(breakdown(123_456_789n, MULTI_LINE));
    expect(explainFees(breakdown(123_456_789n, MULTI_LINE))).toEqual(
      explainFees(breakdown(123_456_789n, MULTI_LINE))
    );
  });

  it("stays exact for amounts beyond the safe integer range", () => {
    const result = breakdown(9_223_372_036_854_775_807n, {
      lines: [{ id: "fee", label: "Fee", basisPoints: 10_000 }]
    });
    expect(result.lines[0].amount).toBe(9_223_372_036_854_775_807n);
    expect(result.net).toBe(0n);
  });

  it("rejects an invalid asset precision", () => {
    expect(calculateFees({ asset: { code: "XLM", decimals: 19 }, amount: 1n, schedule: MULTI_LINE })).toEqual({
      ok: false,
      code: "invalid_asset_precision"
    });
    expect(calculateFees({ asset: { code: "XLM", decimals: 1.5 }, amount: 1n, schedule: MULTI_LINE })).toEqual({
      ok: false,
      code: "invalid_asset_precision"
    });
    expect(calculateFees({ asset: { code: "XLM", decimals: -1 }, amount: 1n, schedule: MULTI_LINE })).toEqual({
      ok: false,
      code: "invalid_asset_precision"
    });
  });

  it("rejects an invalid asset code, amount or schedule", () => {
    expect(calculateFees({ asset: { code: "", decimals: 7 }, amount: 1n, schedule: MULTI_LINE })).toEqual({
      ok: false,
      code: "invalid_asset"
    });
    expect(calculateFees({ asset: XLM, amount: -1n, schedule: MULTI_LINE })).toEqual({
      ok: false,
      code: "invalid_amount"
    });
    expect(
      calculateFees({
        asset: XLM,
        amount: 1n,
        schedule: { lines: [{ id: "fee", label: "Fee", basisPoints: 10_001 }] }
      })
    ).toEqual({ ok: false, code: "invalid_fee_schedule" });
    expect(
      calculateFees({
        asset: XLM,
        amount: 1n,
        schedule: {
          lines: [
            { id: "fee", label: "Fee", basisPoints: 1 },
            { id: "fee", label: "Again", basisPoints: 1 }
          ]
        }
      })
    ).toEqual({ ok: false, code: "invalid_fee_schedule" });
  });

  it("refuses fees that exceed the amount", () => {
    expect(
      calculateFees({
        asset: XLM,
        amount: 100n,
        schedule: {
          lines: [
            { id: "a", label: "A", basisPoints: 6000 },
            { id: "b", label: "B", basisPoints: 6000 }
          ]
        }
      })
    ).toEqual({ ok: false, code: "fees_exceed_amount" });
    expect(
      calculateFees({
        asset: XLM,
        amount: 10n,
        schedule: { lines: [{ id: "a", label: "A", basisPoints: 100, minimum: 11n }] }
      })
    ).toEqual({ ok: false, code: "fees_exceed_amount" });
  });
});

describe("asset amounts", () => {
  it("parses decimal text into smallest units", () => {
    expect(parseAssetAmount(XLM, "100")).toEqual({ ok: true, value: 1_000_000_000n });
    expect(parseAssetAmount(XLM, "0.0000001")).toEqual({ ok: true, value: 1n });
    expect(parseAssetAmount({ code: "JPY", decimals: 0 }, "42")).toEqual({ ok: true, value: 42n });
  });

  it("refuses digits beyond the asset precision instead of rounding them", () => {
    expect(parseAssetAmount(XLM, "1.12345678")).toEqual({ ok: false, code: "invalid_asset_precision" });
    expect(parseAssetAmount({ code: "JPY", decimals: 0 }, "1.5")).toEqual({
      ok: false,
      code: "invalid_asset_precision"
    });
  });

  it("refuses malformed text", () => {
    for (const text of ["", "abc", "-1", "1,5", "1.", ".5"]) {
      expect(parseAssetAmount(XLM, text)).toEqual({ ok: false, code: "invalid_amount" });
    }
  });

  it("formats with exactly the asset's decimals", () => {
    expect(formatAssetAmount(XLM, 35_000_000n)).toBe("3.5000000");
    expect(formatAssetAmount(XLM, 1n)).toBe("0.0000001");
    expect(formatAssetAmount({ code: "JPY", decimals: 0 }, 42n)).toBe("42");
  });
});

describe("explainability and reconciliation", () => {
  it("explains every line, the minimum and the totals", () => {
    const result = breakdown(1_000_000n, {
      lines: [
        { id: "protocol", label: "Protocol fee", basisPoints: 100, minimum: 50_000n },
        { id: "organizer", label: "Organizer fee", basisPoints: 250 }
      ]
    });
    expect(explainFees(result)).toEqual([
      "Protocol fee: 1.00% of 0.1000000 XLM = 0.0050000 XLM (rate gives 0.0010000 XLM, raised to the minimum)",
      "Organizer fee: 2.50% of 0.1000000 XLM = 0.0025000 XLM (rounded half up)",
      "Total fees: 0.0075000 XLM",
      "Net: 0.0925000 XLM"
    ]);
  });

  it("matches a stored settlement that agrees with the breakdown", () => {
    const result = breakdown(1_000_000_000n, MULTI_LINE);
    expect(
      reconcileFees(result, {
        gross: 1_000_000_000n,
        lines: { protocol: 10_000_000n, organizer: 25_000_000n },
        net: 965_000_000n
      })
    ).toEqual({ matches: true, mismatches: [] });
  });

  it("reports every field where a stored settlement disagrees", () => {
    const result = breakdown(1_000_000_000n, MULTI_LINE);
    const reconciliation = reconcileFees(result, {
      gross: 1_000_000_000n,
      lines: { protocol: 9_000_000n, legacy: 1n },
      net: 965_000_000n
    });
    expect(reconciliation.matches).toBe(false);
    expect(reconciliation.mismatches).toEqual([
      { field: "line:protocol", expected: 10_000_000n, actual: 9_000_000n },
      { field: "line:organizer", expected: 25_000_000n, actual: undefined },
      { field: "line:legacy", expected: undefined, actual: 1n }
    ]);
  });
});
