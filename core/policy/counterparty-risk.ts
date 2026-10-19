/**
 * Counterparty risk scoring for issuers, organizers and transfer participants.
 *
 * Profile signals are fed through the shared `assessRisk` engine so the score is
 * reproducible from the documented inputs below. Users only ever see the coarse
 * state; the score, thresholds and signal breakdown stay behind the maintainer view.
 */
import { assessRisk, type RiskLevel, type RiskSignal, type RiskSignalInput } from "./risk-scoring";

export type CounterpartyRiskState = "low" | "medium" | "high" | "unknown";

export interface CounterpartyProfile {
  /** Account age in whole days, or `null` when the age could not be determined. */
  readonly accountAgeDays: number | null;
  readonly disputeCount: number;
  readonly flaggedByFraudControls: boolean;
  readonly bulkTransferCount: number;
}

/** A maintainer decision that replaces the scored state until it is removed. */
export interface CounterpartyRiskOverride {
  readonly state: Exclude<CounterpartyRiskState, "unknown">;
  readonly setBy: string;
  readonly reason: string;
}

export interface CounterpartyRiskReport {
  readonly counterpartyId: string;
  readonly state: CounterpartyRiskState;
  readonly source: "score" | "override" | "no_profile";
  /** Maintainer-only detail: never returned by `toPublicRiskSummary`. */
  readonly score: number | null;
  readonly signals: readonly RiskSignal[];
  readonly explanation: string;
}

export interface PublicCounterpartyRisk {
  readonly counterpartyId: string;
  readonly state: CounterpartyRiskState;
}

export const NEW_ACCOUNT_THRESHOLD_DAYS = 30;
export const BULK_TRANSFER_THRESHOLD = 10;

const SIGNAL_WEIGHTS = {
  newAccount: 15,
  dispute: 40,
  fraudFlag: 50,
  bulkTransfers: 20
} as const;

function toState(level: RiskLevel): Exclude<CounterpartyRiskState, "unknown"> {
  return level === "critical" ? "high" : level;
}

function buildSignals(profile: CounterpartyProfile): RiskSignalInput[] {
  const newAccount = profile.accountAgeDays !== null && profile.accountAgeDays < NEW_ACCOUNT_THRESHOLD_DAYS;
  return [
    {
      id: "new_account",
      name: "New account",
      fired: newAccount,
      maxScore: SIGNAL_WEIGHTS.newAccount,
      explanation: "Account age is only {ageDays} days",
      context: { ageDays: profile.accountAgeDays ?? 0 }
    },
    {
      id: "disputes",
      name: "Open disputes",
      fired: profile.disputeCount > 0,
      maxScore: SIGNAL_WEIGHTS.dispute,
      explanation: "{disputeCount} disputes on record",
      context: { disputeCount: profile.disputeCount }
    },
    {
      id: "fraud_flag",
      name: "Fraud control flag",
      fired: profile.flaggedByFraudControls,
      maxScore: SIGNAL_WEIGHTS.fraudFlag,
      explanation: "Flagged by fraud controls"
    },
    {
      id: "bulk_transfers",
      name: "Bulk transfers",
      fired: profile.bulkTransferCount >= BULK_TRANSFER_THRESHOLD,
      maxScore: SIGNAL_WEIGHTS.bulkTransfers,
      explanation: "{bulkTransferCount} bulk transfers in the review window",
      context: { bulkTransferCount: profile.bulkTransferCount }
    }
  ];
}

/**
 * Scores a counterparty. A missing profile is `unknown`, and a maintainer override
 * wins over the score while still reporting the underlying score for review.
 */
export function evaluateCounterpartyRisk(
  counterpartyId: string,
  profile: CounterpartyProfile | null,
  override?: CounterpartyRiskOverride
): CounterpartyRiskReport {
  const assessment = profile ? assessRisk(buildSignals(profile)) : null;

  if (override) {
    return {
      counterpartyId,
      state: override.state,
      source: "override",
      score: assessment?.score ?? null,
      signals: assessment?.signals ?? [],
      explanation: `Manually set to ${override.state} by ${override.setBy}: ${override.reason}`
    };
  }

  if (!assessment) {
    return {
      counterpartyId,
      state: "unknown",
      source: "no_profile",
      score: null,
      signals: [],
      explanation: "No risk profile is available for this counterparty."
    };
  }

  return {
    counterpartyId,
    state: toState(assessment.level),
    source: "score",
    score: assessment.score,
    signals: assessment.signals,
    explanation: assessment.explanation
  };
}

/** The only view a non-maintainer receives: no score, thresholds or signals. */
export function toPublicRiskSummary(report: CounterpartyRiskReport): PublicCounterpartyRisk {
  return { counterpartyId: report.counterpartyId, state: report.state };
}
