/**
 * Deterministic fee calculation with explainable breakdowns (#182).
 *
 * This is the one place fee arithmetic lives. The same asset, amount and
 * schedule always produce the same breakdown, because:
 *
 * - amounts are `bigint` smallest units, never floats;
 * - each line's rate amount is `amount * basisPoints / 10000`, rounded half up
 *   to the smallest unit, independently of every other line;
 * - a line's minimum applies to any positive amount, and only then;
 * - no clock, randomness or ambient state is read.
 *
 * `calculateFees` has no side effects, so calling it is the preview a user sees
 * before final submission. `reconcileFees` then checks the stored settlement
 * against a breakdown, so the explanation and the record cannot drift apart.
 */

import { err, ok, type Result } from "@/core/result/result";
import type {
  FeeAsset,
  FeeBreakdown,
  FeeErrorCode,
  FeeInput,
  FeeLineItem,
  FeeMismatch,
  FeeReconciliation,
  FeeSchedule,
  StoredFeeSettlement
} from "./types";

export const BASIS_POINTS_DENOMINATOR = 10_000n;
export const MAX_ASSET_DECIMALS = 18;

const ASSET_CODE = /^[A-Za-z0-9]{1,12}$/;
const DECIMAL_AMOUNT = /^(\d+)(?:\.(\d+))?$/;

function validateAsset(asset: FeeAsset): FeeErrorCode | undefined {
  if (!asset || typeof asset.code !== "string" || !ASSET_CODE.test(asset.code)) return "invalid_asset";
  if (!Number.isInteger(asset.decimals) || asset.decimals < 0 || asset.decimals > MAX_ASSET_DECIMALS) {
    return "invalid_asset_precision";
  }
  return undefined;
}

function validateSchedule(schedule: FeeSchedule): boolean {
  if (!schedule || !Array.isArray(schedule.lines)) return false;
  const seen = new Set<string>();
  for (const line of schedule.lines) {
    if (typeof line.id !== "string" || line.id.length === 0 || seen.has(line.id)) return false;
    seen.add(line.id);
    if (!Number.isInteger(line.basisPoints) || line.basisPoints < 0 || line.basisPoints > 10_000) return false;
    if (line.minimum !== undefined && (typeof line.minimum !== "bigint" || line.minimum < 0n)) return false;
  }
  return true;
}

/**
 * Parses a decimal string such as `"12.5"` into smallest units for the asset.
 * More fractional digits than the asset has decimals is `invalid_asset_precision`:
 * the digits are refused, never rounded away.
 */
export function parseAssetAmount(asset: FeeAsset, text: string): Result<bigint, FeeErrorCode> {
  const assetError = validateAsset(asset);
  if (assetError) return err(assetError);
  const match = DECIMAL_AMOUNT.exec(typeof text === "string" ? text.trim() : "");
  if (!match) return err("invalid_amount");
  const [, whole, fraction = ""] = match;
  if (fraction.length > asset.decimals) return err("invalid_asset_precision");
  return ok(BigInt(whole + fraction.padEnd(asset.decimals, "0")));
}

/** Formats smallest units with exactly `asset.decimals` decimal places. */
export function formatAssetAmount(asset: FeeAsset, amount: bigint): string {
  const negative = amount < 0n;
  const digits = (negative ? -amount : amount).toString().padStart(asset.decimals + 1, "0");
  const split = digits.length - asset.decimals;
  const text = asset.decimals === 0 ? digits : `${digits.slice(0, split)}.${digits.slice(split)}`;
  return negative ? `-${text}` : text;
}

/** Computes the breakdown for one gross amount. Pure and deterministic. */
export function calculateFees(input: FeeInput): Result<FeeBreakdown, FeeErrorCode> {
  const assetError = validateAsset(input.asset);
  if (assetError) return err(assetError);
  if (typeof input.amount !== "bigint" || input.amount < 0n) return err("invalid_amount");
  if (!validateSchedule(input.schedule)) return err("invalid_fee_schedule");

  const lines: FeeLineItem[] = input.schedule.lines.map((line) => {
    const minimum = line.minimum ?? 0n;
    const rateAmount =
      (input.amount * BigInt(line.basisPoints) + BASIS_POINTS_DENOMINATOR / 2n) / BASIS_POINTS_DENOMINATOR;
    const floor = input.amount > 0n ? minimum : 0n;
    const amount = rateAmount > floor ? rateAmount : floor;
    return {
      id: line.id,
      label: line.label,
      basisPoints: line.basisPoints,
      rateAmount,
      minimum,
      amount,
      basis: amount === 0n ? "zero" : amount > rateAmount ? "minimum" : "rate"
    };
  });

  const totalFees = lines.reduce((sum, line) => sum + line.amount, 0n);
  if (totalFees > input.amount) return err("fees_exceed_amount");

  return ok({
    asset: input.asset,
    gross: input.amount,
    lines,
    totalFees,
    net: input.amount - totalFees,
    rounding: "half_up"
  });
}

/** One human-readable line per fee, then the totals. Stable for identical input. */
export function explainFees(breakdown: FeeBreakdown): string[] {
  const { asset } = breakdown;
  const money = (value: bigint): string => `${formatAssetAmount(asset, value)} ${asset.code}`;
  const lines = breakdown.lines.map((line) => {
    const rate = `${(line.basisPoints / 100).toFixed(2)}% of ${money(breakdown.gross)}`;
    const how =
      line.basis === "minimum"
        ? `rate gives ${money(line.rateAmount)}, raised to the minimum`
        : line.basis === "zero"
          ? "nothing charged"
          : "rounded half up";
    return `${line.label}: ${rate} = ${money(line.amount)} (${how})`;
  });
  lines.push(`Total fees: ${money(breakdown.totalFees)}`);
  lines.push(`Net: ${money(breakdown.net)}`);
  return lines;
}

/**
 * Compares a breakdown with the figures a settlement record stored. Any
 * difference, including a missing or extra line, is reported field by field.
 */
export function reconcileFees(breakdown: FeeBreakdown, stored: StoredFeeSettlement): FeeReconciliation {
  const mismatches: FeeMismatch[] = [];
  const compare = (field: string, expected: bigint | undefined, actual: bigint | undefined): void => {
    if (expected !== actual) mismatches.push({ field, expected, actual });
  };

  compare("gross", breakdown.gross, stored.gross);
  const expectedIds = new Set(breakdown.lines.map((line) => line.id));
  for (const line of breakdown.lines) {
    compare(`line:${line.id}`, line.amount, stored.lines[line.id]);
  }
  for (const id of Object.keys(stored.lines)) {
    if (!expectedIds.has(id)) compare(`line:${id}`, undefined, stored.lines[id]);
  }
  compare("net", breakdown.net, stored.net);

  return { matches: mismatches.length === 0, mismatches };
}
