/**
 * Risk-Scored Abuse Detection for Suspicious High-Impact Operations (#226).
 *
 * Implements explainable risk scoring and progressive step-up friction for
 * high-impact, potentially abusive, or destructive operations on Stellar accounts,
 * assets, Soroban contracts, and Utix export services.
 *
 * Key guarantees:
 * 1. Zero friction for legitimate low-risk operations (address checks, balance queries).
 * 2. Transparent, explainable risk signals explaining precisely why a score was assigned.
 * 3. Step-up friction (confirmation challenge, secondary approval) before hard blocking.
 * 4. Auditable decisions with maintainer override support.
 */

import { recordAudit } from "@/core/audit/audit";
import { emitTelemetry, newCorrelationId } from "@/core/telemetry/telemetry";

export type AbuseAction = "allow" | "step_up" | "review" | "block";

export type StepUpRequirement = "none" | "confirm_dialog" | "maintainer_approval" | "rate_limit_backoff";

export interface ExplainableRiskSignal {
  readonly id: string;
  readonly name: string;
  readonly points: number;
  readonly reason: string;
  readonly evidence?: Record<string, unknown>;
}

export interface AbuseEvaluationContext {
  readonly operation: string;
  readonly actor: { kind: string; id: string };
  readonly network?: "testnet" | "mainnet";
  readonly recentOperationCount?: number;
  readonly payload?: Record<string, unknown>;
  readonly clientSessionId?: string;
}

export interface AbuseAssessment {
  readonly evaluationId: string;
  readonly operation: string;
  readonly score: number; // 0 to 100
  readonly action: AbuseAction;
  readonly signals: readonly ExplainableRiskSignal[];
  readonly requiredStepUp: StepUpRequirement;
  readonly timestamp: string;
  readonly overridden?: {
    readonly originalAction: AbuseAction;
    readonly maintainerId: string;
    readonly reason: string;
    readonly at: string;
  };
}

// In-memory audit & evaluation cache for review and overrides
const assessmentStore = new Map<string, AbuseAssessment>();

// Known low-risk operations that are always allowed with 0 risk score
const ZERO_RISK_OPERATIONS = new Set([
  "address.validate",
  "balance.view",
  "trustline.check",
  "transaction.lookup",
  "ledger.lookup",
  "strkey.inspect",
  "payment_qr.generate"
]);

/**
 * Evaluates an incoming operation for abuse signals and computes an explainable risk score.
 */
export function evaluateAbuseRisk(context: AbuseEvaluationContext): AbuseAssessment {
  const evaluationId = `abuse-${newCorrelationId()}`;
  const now = new Date().toISOString();
  const signals: ExplainableRiskSignal[] = [];

  // 1. Fast-path: Low-risk routine read operations have 0 risk score
  if (ZERO_RISK_OPERATIONS.has(context.operation)) {
    const assessment: AbuseAssessment = {
      evaluationId,
      operation: context.operation,
      score: 0,
      action: "allow",
      signals: [],
      requiredStepUp: "none",
      timestamp: now
    };
    assessmentStore.set(evaluationId, assessment);
    return assessment;
  }

  // 2. High-Impact Operation Baseline Signals
  if (context.operation === "account.merge") {
    signals.push({
      id: "destructive_account_merge",
      name: "Destructive Account Merge",
      points: 45,
      reason: "Account merge permanently removes source account from ledger and transfers all XLM.",
      evidence: { targetAccount: context.payload?.destination }
    });

    // Stellar protocol rule: destination cannot be source account
    if (context.payload?.destination && context.payload.destination === context.actor.id) {
      signals.push({
        id: "self_merge_forbidden",
        name: "Forbidden Self-Merge Attempt",
        points: 40,
        reason: "Stellar protocol forbids merging an account into itself.",
        evidence: { destination: context.payload.destination, actor: context.actor.id }
      });
    }

    // Stellar protocol prerequisite: source account cannot have active subentries
    if (context.payload?.subentryCount !== undefined && Number(context.payload.subentryCount) > 0) {
      signals.push({
        id: "merge_subentry_liability",
        name: "Active Subentries Preclude Merge",
        points: 35,
        reason: "Stellar Account Merge requires 0 subentries; active trustlines or open offers must be cleared first.",
        evidence: { subentryCount: context.payload.subentryCount }
      });
    }
  }

  if (context.operation === "account.set_options") {
    const masterWeight = context.payload?.masterWeight;
    if (masterWeight === 0) {
      signals.push({
        id: "disabled_master_key",
        name: "Master Key Weight Zeroed",
        points: 45,
        reason: "Zeroing master key permanently disables direct signing by account master key (locks account if multisig is absent).",
        evidence: { masterWeight: 0 }
      });
    }

    // Stellar threshold ordering recommendation: low <= med <= high
    const low = typeof context.payload?.lowThreshold === "number" ? context.payload.lowThreshold : undefined;
    const med = typeof context.payload?.medThreshold === "number" ? context.payload.medThreshold : undefined;
    const high = typeof context.payload?.highThreshold === "number" ? context.payload.highThreshold : undefined;

    if (low !== undefined && med !== undefined && high !== undefined) {
      if (low > med || med > high) {
        signals.push({
          id: "inverted_threshold_ordering",
          name: "Inverted Threshold Configuration",
          points: 30,
          reason: "Threshold violation: Stellar documentation specifies Low <= Medium <= High threshold ordering.",
          evidence: { low, med, high }
        });
      }
    }
  }

  if (context.operation === "faucet.fund") {
    const recent = context.recentOperationCount ?? 0;
    if (recent >= 5) {
      signals.push({
        id: "faucet_burst_drain",
        name: "Faucet Rapid Request Burst",
        points: 50,
        reason: `Exceeded allowable testnet funding frequency (${recent} requests in window).`,
        evidence: { recentCount: recent }
      });
    } else if (recent >= 2) {
      signals.push({
        id: "faucet_repeat_request",
        name: "Faucet Rapid Successive Funding",
        points: 25,
        reason: "Successive faucet requests detected in short duration.",
        evidence: { recentCount: recent }
      });
    }
  }

  if (context.operation === "export.generate") {
    if (context.payload?.scope === "maintainer") {
      signals.push({
        id: "sensitive_bulk_export",
        name: "Maintainer Scope Data Export",
        points: 40,
        reason: "Exporting maintainer-scoped audit and operational datasets requires elevated review.",
        evidence: { scope: "maintainer" }
      });
    }
    const requestedRecords = Number(context.payload?.recordCount ?? 0);
    if (requestedRecords > 10_000) {
      signals.push({
        id: "massive_export_payload",
        name: "Excessive Export Record Count",
        points: 30,
        reason: `Requested export volume (${requestedRecords}) exceeds normal analytical limits.`,
        evidence: { requestedRecords }
      });
    }
  }

  if (context.operation === "ownership.transfer") {
    signals.push({
      id: "resource_ownership_transfer",
      name: "Resource Ownership Handover",
      points: 35,
      reason: "Irreversible handover of administrative resource control.",
      evidence: { resourceId: context.payload?.resourceId }
    });
  }

  if (context.operation === "xdr.inspect") {
    const payloadSize = Number(context.payload?.byteLength ?? 0);
    if (payloadSize > 256 * 1024) {
      signals.push({
        id: "oversized_xdr_payload",
        name: "Oversized XDR Payload",
        points: 45,
        reason: "XDR payload exceeds safe 256KB threshold (potential XDR bomb).",
        evidence: { byteLength: payloadSize }
      });
    }
  }

  // 3. Frequency & Velocity Anomaly Signals
  const recentOps = context.recentOperationCount ?? 0;
  if (recentOps >= 20) {
    signals.push({
      id: "excessive_burst_velocity",
      name: "Abnormal Request Velocity",
      points: 35,
      reason: `Client performed ${recentOps} operations in immediate observation window.`,
      evidence: { recentOps }
    });
  }

  // 4. Compute Aggregate Score (capped at 100)
  const totalScore = Math.min(
    100,
    signals.reduce((sum, s) => sum + s.points, 0)
  );

  // 5. Determine Action and Step-Up Requirements
  let action: AbuseAction = "allow";
  let requiredStepUp: StepUpRequirement = "none";

  if (totalScore >= 90) {
    action = "block";
    requiredStepUp = "rate_limit_backoff";
  } else if (totalScore >= 70) {
    action = "review";
    requiredStepUp = "maintainer_approval";
  } else if (totalScore >= 40) {
    action = "step_up";
    requiredStepUp = "confirm_dialog";
  }

  const assessment: AbuseAssessment = {
    evaluationId,
    operation: context.operation,
    score: totalScore,
    action,
    signals,
    requiredStepUp,
    timestamp: now
  };

  assessmentStore.set(evaluationId, assessment);

  // Record audit trail for any non-allow decision
  if (action !== "allow") {
    recordAudit({
      action: "abuse_evaluation",
      actor: context.actor,
      resourceType: "operation",
      resourceId: context.operation,
      details: {
        evaluationId,
        score: totalScore,
        action,
        signals: signals.map((s) => ({ id: s.id, points: s.points, reason: s.reason }))
      }
    });

    emitTelemetry({
      op: "security.abuse_detected",
      actorType: context.actor.kind === "maintainer" ? "maintainer" : "user",
      result: "success",
      latencyMs: 1,
      correlationId: evaluationId,
      timestamp: now,
      errorCode: action === "block" ? "abuse_blocked" : undefined
    });
  }

  return assessment;
}

/**
 * Retrieves a stored abuse assessment by ID.
 */
export function getAbuseAssessment(evaluationId: string): AbuseAssessment | undefined {
  return assessmentStore.get(evaluationId);
}

/**
 * Allows a maintainer to override an abuse assessment decision (e.g. approving false positive).
 */
export function overrideAbuseAssessment(
  evaluationId: string,
  newAction: AbuseAction,
  maintainerActor: { kind: string; id: string },
  reason: string
): AbuseAssessment | null {
  const existing = assessmentStore.get(evaluationId);
  if (!existing) return null;

  const overridden: AbuseAssessment = {
    ...existing,
    action: newAction,
    requiredStepUp: newAction === "allow" ? "none" : existing.requiredStepUp,
    overridden: {
      originalAction: existing.action,
      maintainerId: maintainerActor.id,
      reason,
      at: new Date().toISOString()
    }
  };

  assessmentStore.set(evaluationId, overridden);

  recordAudit({
    action: "abuse_override",
    actor: maintainerActor,
    resourceType: "abuse_assessment",
    resourceId: evaluationId,
    details: {
      previousAction: existing.action,
      newAction,
      reason
    }
  });

  return overridden;
}

/**
 * Test seam: resets assessment store.
 */
export function resetAbuseAssessmentStore(): void {
  assessmentStore.clear();
}
