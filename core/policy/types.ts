/**
 * Policy Simulation Types and Interfaces (#234)
 *
 * Defines models for policy evaluation, side-effect detection,
 * rollback constraints, and preview reports for high-impact or irreversible changes.
 */

export type PolicyScope =
  | "accounts"
  | "transactions"
  | "soroban"
  | "quota"
  | "network"
  | "global";

export type PolicyImpactSeverity = "low" | "medium" | "high" | "critical";

export type SideEffectType =
  | "threshold_breach"
  | "fee_limit_exceeded"
  | "operation_disallowed"
  | "signer_weight_insufficient"
  | "quota_throttled"
  | "irreversible_state_transition"
  | "storage_eviction"
  | "deprecated_behavior";

export interface PolicyRule {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly parameter: string;
  readonly currentValue: unknown;
  readonly proposedValue: unknown;
  readonly isIrreversible?: boolean;
}

export interface PolicyDefinition {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly scope: PolicyScope;
  readonly version: number;
  readonly rules: readonly PolicyRule[];
  readonly parameters?: {
    readonly maxBaseFeeStroops?: number;
    readonly minMasterWeight?: number;
    readonly disallowedOperations?: readonly string[];
    readonly maxAccountSubentries?: number;
    readonly requireSorobanSimulation?: boolean;
    readonly emergencyFreeze?: boolean;
    readonly [key: string]: unknown;
  };
}

export interface SimulationTargetRecord {
  readonly id: string;
  readonly type: "account" | "transaction" | "job" | "quota" | "contract";
  readonly attributes: Record<string, unknown>;
}

export interface SimulationSideEffect {
  readonly ruleId: string;
  readonly targetId: string;
  readonly entityType: SimulationTargetRecord["type"];
  readonly severity: PolicyImpactSeverity;
  readonly impactType: SideEffectType;
  readonly description: string;
  readonly beforeValue?: unknown;
  readonly afterValue?: unknown;
}

export interface RollbackConstraint {
  readonly constraintId: string;
  readonly description: string;
  readonly reversible: boolean;
  readonly requiresSnapshot: boolean;
  readonly prerequisites: readonly string[];
  readonly recoveryGuidance: string;
}

export interface AffectedEntitySummary {
  readonly entityType: SimulationTargetRecord["type"];
  readonly totalEvaluated: number;
  readonly affectedCount: number;
  readonly unaffectedCount: number;
}

export interface PolicySimulationReport {
  readonly simulationId: string;
  readonly policyId: string;
  readonly simulatedAt: string;
  readonly isReadOnlyVerified: boolean;
  readonly overallRiskLevel: PolicyImpactSeverity;
  readonly totalEvaluated: number;
  readonly totalAffected: number;
  readonly entitySummaries: readonly AffectedEntitySummary[];
  readonly sideEffects: readonly SimulationSideEffect[];
  readonly rollbackConstraints: readonly RollbackConstraint[];
  readonly operationalWarnings: readonly string[];
  readonly executionPlan: {
    readonly recommendedAction: "proceed" | "proceed_with_caution" | "block";
    readonly gatingReasons: readonly string[];
  };
}

export interface SimulationOptions {
  readonly now?: Date | number;
  readonly maxSideEffects?: number;
  readonly strictMode?: boolean;
}
