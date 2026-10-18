/**
 * Types for the deterministic fee calculation module (#182).
 *
 * Every amount is a `bigint` count of the asset's smallest unit (stroops for a
 * 7-decimal Stellar asset). Nothing in this module passes through `Number`.
 */

export interface FeeAsset {
  /** Stellar asset code: 1 to 12 alphanumeric characters. */
  readonly code: string;
  /** Number of decimal places of the asset, an integer from 0 to 18. */
  readonly decimals: number;
}

export type FeeErrorCode =
  | "invalid_asset"
  | "invalid_asset_precision"
  | "invalid_amount"
  | "invalid_fee_schedule"
  | "fees_exceed_amount";

/** One named fee, charged as a rate in basis points with an optional floor. */
export interface FeeLineDefinition {
  /** Stable identifier, e.g. `protocol` or `organizer`. Unique within a schedule. */
  readonly id: string;
  readonly label: string;
  /** Rate in basis points: an integer from 0 (free) to 10000 (100%). */
  readonly basisPoints: number;
  /** Floor in smallest units, applied to any positive amount. Defaults to 0. */
  readonly minimum?: bigint;
}

export interface FeeSchedule {
  readonly lines: readonly FeeLineDefinition[];
}

export interface FeeInput {
  readonly asset: FeeAsset;
  /** Gross amount in smallest units. Must not be negative. */
  readonly amount: bigint;
  readonly schedule: FeeSchedule;
}

/**
 * How a line's final amount was reached:
 * - `rate`: the rounded rate amount was charged;
 * - `minimum`: the rate amount was below the floor, so the floor was charged;
 * - `zero`: nothing was charged.
 */
export type FeeBasis = "rate" | "minimum" | "zero";

export interface FeeLineItem {
  readonly id: string;
  readonly label: string;
  readonly basisPoints: number;
  /** The rate amount after rounding, before the minimum is considered. */
  readonly rateAmount: bigint;
  readonly minimum: bigint;
  /** The amount actually charged for this line. */
  readonly amount: bigint;
  readonly basis: FeeBasis;
}

export interface FeeBreakdown {
  readonly asset: FeeAsset;
  readonly gross: bigint;
  readonly lines: readonly FeeLineItem[];
  readonly totalFees: bigint;
  /** `gross - totalFees`. */
  readonly net: bigint;
  /** Each line's rate amount is rounded half up to the smallest unit. */
  readonly rounding: "half_up";
}

/** The fee figures a settlement record stores, keyed by line id. */
export interface StoredFeeSettlement {
  readonly gross: bigint;
  readonly lines: Readonly<Record<string, bigint>>;
  readonly net: bigint;
}

export interface FeeMismatch {
  /** `gross`, `net` or `line:<id>`. */
  readonly field: string;
  readonly expected: bigint | undefined;
  readonly actual: bigint | undefined;
}

export interface FeeReconciliation {
  readonly matches: boolean;
  readonly mismatches: readonly FeeMismatch[];
}
