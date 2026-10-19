/**
 * Feature-Flag Rollout Guard with Automatic Rollback Verification (#223).
 *
 * Provides safe scoping, active health monitoring, automated kill-switch
 * tripping, and post-rollback state verification for high-risk protocol changes
 * and experimental feature slices.
 *
 * Guarantees:
 * 1. Risky features are strictly scoped by percentage, network, and risk tier.
 * 2. Anomaly/error thresholds automatically trigger instantaneous rollback.
 * 3. Automatic rollback verification runs immediately to ensure no orphaned,
 *    inconsistent, or corrupt state is left behind.
 * 4. Actionable audit trail and telemetry events emitted for every guard action.
 */

import { recordAudit } from "@/core/audit/audit";
import {
  configureRollout,
  isFeatureEnabled,
  triggerEmergencyDisable,
  type FeatureFlag,
  type RolloutConfig,
  type RolloutContext
} from "@/core/feature-flags/flags";
import { emitTelemetry, newCorrelationId } from "@/core/telemetry/telemetry";

export type RiskTier = "low" | "medium" | "high" | "critical";

export interface RolloutGuardScope {
  readonly flag: FeatureFlag;
  readonly riskTier: RiskTier;
  readonly percentage: number;
  readonly allowedNetworks?: readonly ("testnet" | "mainnet")[];
  readonly allowlist?: readonly string[];
  readonly blocklist?: readonly string[];
  readonly errorThresholdPercent?: number; // default: 20%
  readonly maxConsecutiveFailures?: number; // default: 3 for high/critical, 5 for medium
  readonly minSamples?: number; // default: 5
}

export interface StateConsistencyCheck<T = unknown> {
  readonly name: string;
  readonly description: string;
  readonly check: (state: T) => { valid: boolean; violation?: string };
  readonly remediate?: (state: T) => { remediated: boolean; details?: string };
}

export interface RolloutGuardOptions<T = unknown> {
  readonly stateProvider?: () => T;
  readonly consistencyChecks?: readonly StateConsistencyCheck<T>[];
  readonly onRollback?: (report: RollbackVerificationReport) => void;
  readonly now?: () => Date;
}

export interface RollbackVerificationReport {
  readonly guardId: string;
  readonly flag: FeatureFlag;
  readonly rollbackTriggered: boolean;
  readonly triggerReason: string;
  readonly triggeredBy: string;
  readonly triggeredAt: string;
  readonly postRollbackFlagDisabled: boolean;
  readonly stateConsistent: boolean;
  readonly violations: readonly string[];
  readonly remediationsApplied: readonly string[];
  readonly correlationId: string;
}

export interface GuardMetrics {
  readonly successes: number;
  readonly failures: number;
  readonly consecutiveFailures: number;
  readonly total: number;
  readonly errorRatePercent: number;
}

export class RolloutGuard<T = unknown> {
  public readonly id: string;
  public readonly scope: RolloutGuardScope;
  private readonly options: RolloutGuardOptions<T>;
  private successes = 0;
  private failures = 0;
  private consecutiveFailures = 0;
  private tripped = false;
  private lastReport: RollbackVerificationReport | null = null;

  constructor(scope: RolloutGuardScope, options?: RolloutGuardOptions<T>) {
    this.id = `guard-${scope.flag}-${Date.now()}`;
    this.scope = {
      errorThresholdPercent: 20,
      minSamples: 5,
      maxConsecutiveFailures: scope.riskTier === "critical" || scope.riskTier === "high" ? 3 : 5,
      ...scope
    };
    this.options = options ?? {};

    // Apply baseline rollout configuration
    const rolloutCfg: RolloutConfig = {
      percentage: this.scope.percentage,
      allowedNetworks: this.scope.allowedNetworks,
      allowlist: this.scope.allowlist,
      blocklist: this.scope.blocklist,
      errorThresholdPercent: this.scope.errorThresholdPercent,
      minErrorSamples: this.scope.minSamples
    };
    configureRollout(this.scope.flag, rolloutCfg);
  }

  /**
   * Evaluates if the guarded feature flag is active for the context.
   */
  public isEnabled(context?: RolloutContext): boolean {
    if (this.tripped) return false;
    return isFeatureEnabled(this.scope.flag, context);
  }

  /**
   * Records a successful operation under this guarded rollout.
   */
  public recordSuccess(): void {
    if (this.tripped) return;
    this.successes += 1;
    this.consecutiveFailures = 0;
  }

  /**
   * Records an operational failure. If failure thresholds or consecutive
   * failure limits are breached, automatically triggers rollback & verification.
   */
  public recordFailure(reason = "Operational failure"): RollbackVerificationReport | null {
    if (this.tripped) return this.lastReport;

    this.failures += 1;
    this.consecutiveFailures += 1;

    const total = this.successes + this.failures;
    const errorRate = (this.failures / total) * 100;

    const breachedConsecutive = this.consecutiveFailures >= (this.scope.maxConsecutiveFailures ?? 3);
    const breachedRate = total >= (this.scope.minSamples ?? 5) && errorRate >= (this.scope.errorThresholdPercent ?? 20);

    if (breachedConsecutive || breachedRate) {
      const triggerReason = breachedConsecutive
        ? `Consecutive failures threshold (${this.consecutiveFailures}) breached: ${reason}`
        : `Error rate threshold (${errorRate.toFixed(1)}%) breached: ${reason}`;

      return this.executeRollback(triggerReason, "automated_rollout_guard");
    }

    return null;
  }

  /**
   * Manually triggers immediate rollback and post-rollback verification.
   */
  public manualRollback(reason: string, actor = "maintainer"): RollbackVerificationReport {
    return this.executeRollback(reason, actor);
  }

  /**
   * Core rollback execution and state verification engine.
   */
  private executeRollback(reason: string, actor: string): RollbackVerificationReport {
    this.tripped = true;
    const now = (this.options.now ? this.options.now() : new Date()).toISOString();
    const correlationId = newCorrelationId();

    // 1. Immediately kill-switch the flag
    triggerEmergencyDisable(this.scope.flag, {
      reason,
      actor,
      now: new Date(now)
    });

    // 2. Run post-rollback state verification
    const violations: string[] = [];
    const remediations: string[] = [];

    const state = this.options.stateProvider ? this.options.stateProvider() : undefined;
    if (state !== undefined && this.options.consistencyChecks) {
      for (const check of this.options.consistencyChecks) {
        const result = check.check(state);
        if (!result.valid) {
          violations.push(`${check.name}: ${result.violation ?? "Invariant violated"}`);
          if (check.remediate) {
            const remResult = check.remediate(state);
            if (remResult.remediated) {
              remediations.push(`${check.name}: ${remResult.details ?? "Remediated successfully"}`);
            }
          }
        }
      }
    }

    // Flag must evaluate to false after rollback
    const postRollbackDisabled = !isFeatureEnabled(this.scope.flag);

    const report: RollbackVerificationReport = {
      guardId: this.id,
      flag: this.scope.flag,
      rollbackTriggered: true,
      triggerReason: reason,
      triggeredBy: actor,
      triggeredAt: now,
      postRollbackFlagDisabled: postRollbackDisabled,
      stateConsistent: violations.length === remediations.length,
      violations,
      remediationsApplied: remediations,
      correlationId
    };

    this.lastReport = report;

    // 3. Emit structured telemetry
    emitTelemetry({
      op: "rollout_guard.rollback",
      actorType: actor === "automated_rollout_guard" ? "system" : "maintainer",
      result: report.stateConsistent ? "success" : "failure",
      latencyMs: 1,
      correlationId,
      timestamp: now,
      errorCode: report.stateConsistent ? undefined : "inconsistent_state_post_rollback"
    });

    // 4. Record audit trail
    recordAudit({
      action: "emergency_disable",
      actor: { kind: actor === "automated_rollout_guard" ? "system" : "maintainer", id: actor },
      resourceType: "feature_flag",
      resourceId: this.scope.flag,
      details: {
        guardId: this.id,
        reason,
        violationsCount: violations.length,
        remediationsCount: remediations.length,
        stateConsistent: report.stateConsistent
      }
    });

    if (this.options.onRollback) {
      this.options.onRollback(report);
    }

    return report;
  }

  /**
   * Returns current health metrics for this guarded rollout.
   */
  public getMetrics(): GuardMetrics {
    const total = this.successes + this.failures;
    const errorRate = total > 0 ? (this.failures / total) * 100 : 0;
    return {
      successes: this.successes,
      failures: this.failures,
      consecutiveFailures: this.consecutiveFailures,
      total,
      errorRatePercent: errorRate
    };
  }

  /**
   * Returns whether this guard has been tripped.
   */
  public isTripped(): boolean {
    return this.tripped;
  }

  /**
   * Retrieves the most recent rollback verification report, if any.
   */
  public getLastRollbackReport(): RollbackVerificationReport | null {
    return this.lastReport;
  }
}

/**
 * Factory helper for instantiating a RolloutGuard.
 */
export function createRolloutGuard<T = unknown>(
  scope: RolloutGuardScope,
  options?: RolloutGuardOptions<T>
): RolloutGuard<T> {
  return new RolloutGuard<T>(scope, options);
}
