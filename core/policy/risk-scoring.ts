/**
 * Explainable risk scoring for suspicious high-impact actions (#276).
 *
 * Evaluates actions (transfers, redemptions, bulk operations) against
 * configurable risk signals and produces a composite score (0-100) with
 * a per-signal breakdown explaining why the score is what it is.
 *
 * Signals are additive with configurable weights. The final score is
 * clamped to [0, 100] and mapped to a risk level.
 */

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface RiskSignal {
  /** Signal identifier. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Score contribution (0-100). */
  score: number;
  /** Why this signal fired. */
  explanation: string;
}

export interface RiskAssessment {
  /** Composite score 0-100. */
  score: number;
  /** Risk level based on score. */
  level: RiskLevel;
  /** Individual signals that contributed to the score. */
  signals: RiskSignal[];
  /** Human-readable summary of the assessment. */
  explanation: string;
  /** ISO timestamp of the assessment. */
  assessedAt: string;
}

export interface RiskSignalInput {
  /** Unique signal ID. */
  id: string;
  /** Display name. */
  name: string;
  /** Whether this signal fired (condition matched). */
  fired: boolean;
  /** Score contribution when fired (0-100). */
  maxScore: number;
  /** Explanation template. */
  explanation: string;
  /** Additional context for the explanation. */
  context?: Record<string, unknown>;
}

export interface RiskScoringConfig {
  /** Score thresholds for risk levels. */
  thresholds: {
    medium: number;
    high: number;
    critical: number;
  };
}

const DEFAULT_CONFIG: RiskScoringConfig = {
  thresholds: {
    medium: 30,
    high: 60,
    critical: 80,
  },
};

/**
 * Evaluate risk signals and produce an explainable assessment.
 */
export function assessRisk(
  signals: RiskSignalInput[],
  config: RiskScoringConfig = DEFAULT_CONFIG,
): RiskAssessment {
  const firedSignals: RiskSignal[] = [];
  let totalScore = 0;

  for (const signal of signals) {
    if (!signal.fired) continue;

    const score = Math.min(signal.maxScore, 100);
    totalScore += score;

    // Build explanation from context
    let explanation = signal.explanation;
    if (signal.context) {
      for (const [key, value] of Object.entries(signal.context)) {
        explanation = explanation.replace(`{${key}}`, String(value));
      }
    }

    firedSignals.push({
      id: signal.id,
      name: signal.name,
      score,
      explanation,
    });
  }

  const clampedScore = Math.min(totalScore, 100);
  const level = getRiskLevel(clampedScore, config);
  const explanation = buildExplanation(clampedScore, level, firedSignals);

  return {
    score: clampedScore,
    level,
    signals: firedSignals,
    explanation,
    assessedAt: new Date().toISOString(),
  };
}

function getRiskLevel(score: number, config: RiskScoringConfig): RiskLevel {
  if (score >= config.thresholds.critical) return 'critical';
  if (score >= config.thresholds.high) return 'high';
  if (score >= config.thresholds.medium) return 'medium';
  return 'low';
}

function buildExplanation(score: number, level: RiskLevel, signals: RiskSignal[]): string {
  if (signals.length === 0) {
    return `Risk score ${score}/100 (${level}) — no risk signals fired.`;
  }

  const signalSummary = signals
    .map((s) => `${s.name} (+${s.score})`)
    .join(', ');

  return `Risk score ${score}/100 (${level}) based on: ${signalSummary}.`;
}

/**
 * Common risk signal definitions for ticketing operations.
 */
export const RISK_SIGNALS = {
  highValueTransfer: (threshold: number): Omit<RiskSignalInput, 'fired'> => ({
    id: 'high_value_transfer',
    name: 'High-value transfer',
    maxScore: 30,
    explanation: 'Transfer amount exceeds normal threshold of {threshold}',
    context: { threshold },
  }),
  rapidSuccession: (count: number, windowMs: number): Omit<RiskSignalInput, 'fired'> => ({
    id: 'rapid_succession',
    name: 'Rapid succession',
    maxScore: 25,
    explanation: '{count} actions within {windowMs}ms',
    context: { count, windowMs },
  }),
  newAccount: (ageDays: number): Omit<RiskSignalInput, 'fired'> => ({
    id: 'new_account',
    name: 'New account',
    maxScore: 15,
    explanation: 'Account age is only {ageDays} days',
    context: { ageDays },
  }),
  unusualLocation: (currentCountry: string, usualCountry: string): Omit<RiskSignalInput, 'fired'> => ({
    id: 'unusual_location',
    name: 'Unusual location',
    maxScore: 20,
    explanation: 'Action from {currentCountry}, usual location is {usualCountry}',
    context: { currentCountry, usualCountry },
  }),
  bulkOperation: (itemCount: number): Omit<RiskSignalInput, 'fired'> => ({
    id: 'bulk_operation',
    name: 'Bulk operation',
    maxScore: 20,
    explanation: 'Operation affects {itemCount} items',
    context: { itemCount },
  }),
} as const;
