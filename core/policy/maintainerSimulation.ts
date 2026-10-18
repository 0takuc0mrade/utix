/**
 * Maintainer policy simulation tool (#189).
 *
 * Wraps the read-only `PolicySimulator` (#234) with what a maintainer-facing
 * entry point needs: a permission gate, validation of the policy and of the
 * selected records, and an explanation of the outcome, with the affected
 * records grouped, ranked and capped to a few examples.
 *
 * Nothing is written. The policy and the records are only read, so running a
 * simulation against production data cannot change it.
 */

import type { AuthContext } from "@/core/auth/middleware";
import { hasPermission, type Permission } from "@/core/auth/types";
import { err, ok, type Result } from "@/core/result/result";
import { PolicySimulator } from "./simulation.ts";
import type {
  PolicyDefinition,
  PolicyImpactSeverity,
  PolicySimulationReport,
  SimulationTargetRecord
} from "./types.ts";

export const POLICY_SIMULATION_PERMISSION: Permission = "admin:config";

export const DEFAULT_MAX_EXAMPLES = 5;

/** Share of evaluated records above which an impact counts as broad. */
export const BROAD_IMPACT_RATIO = 0.3;

const SCOPES = ["accounts", "transactions", "soroban", "quota", "network", "global"];
const RECORD_TYPES = ["account", "transaction", "job", "quota", "contract"];
const NON_NEGATIVE_PARAMETERS = ["maxBaseFeeStroops", "minMasterWeight", "maxAccountSubentries"];
const SEVERITY_RANK: Record<PolicyImpactSeverity, number> = { low: 0, medium: 1, high: 2, critical: 3 };

export type PolicySimulationErrorCode = "permission_denied" | "invalid_policy" | "invalid_records";

export type PolicyOutcome = "no_impact" | "limited_impact" | "broad_impact";

export interface MaintainerSimulationRequest {
  readonly policy: PolicyDefinition;
  readonly records: readonly SimulationTargetRecord[];
  /** Simulate against only these records. Defaults to all of `records`. */
  readonly recordIds?: readonly string[];
  readonly maxExamples?: number;
  readonly now?: Date | number;
}

export interface AffectedRecordExample {
  readonly id: string;
  readonly entityType: SimulationTargetRecord["type"];
  /** The worst severity among this record's side effects. */
  readonly severity: PolicyImpactSeverity;
  readonly reasons: readonly string[];
}

export interface MaintainerSimulationResult {
  readonly report: PolicySimulationReport;
  readonly outcome: PolicyOutcome;
  readonly summary: string;
  /** The most severe affected records, at most `maxExamples`. */
  readonly examples: readonly AffectedRecordExample[];
  readonly omittedExamples: number;
  /** Requested `recordIds` that matched no record. */
  readonly unmatchedRecordIds: readonly string[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function policyIssues(policy: unknown): string[] {
  if (!isObject(policy)) return ["policy must be an object"];
  const issues: string[] = [];
  if (!isNonEmptyString(policy.id)) issues.push("policy.id must be a non-empty string");
  if (!isNonEmptyString(policy.name)) issues.push("policy.name must be a non-empty string");
  if (!SCOPES.includes(policy.scope as string)) issues.push(`policy.scope must be one of ${SCOPES.join(", ")}`);
  if (!Number.isInteger(policy.version) || (policy.version as number) < 1) {
    issues.push("policy.version must be a positive integer");
  }
  if (!Array.isArray(policy.rules)) {
    issues.push("policy.rules must be an array");
  } else {
    const seen = new Set<unknown>();
    for (const rule of policy.rules) {
      const id = isObject(rule) ? rule.id : undefined;
      if (!isNonEmptyString(id)) issues.push("every rule needs a non-empty id");
      else if (seen.has(id)) issues.push(`duplicate rule id "${id}"`);
      seen.add(id);
    }
  }
  if (policy.parameters !== undefined) {
    if (!isObject(policy.parameters)) {
      issues.push("policy.parameters must be an object");
    } else {
      for (const name of NON_NEGATIVE_PARAMETERS) {
        const value = policy.parameters[name];
        if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
          issues.push(`parameters.${name} must be a non-negative number`);
        }
      }
      const ops = policy.parameters.disallowedOperations;
      if (ops !== undefined && (!Array.isArray(ops) || !ops.every(isNonEmptyString))) {
        issues.push("parameters.disallowedOperations must be an array of non-empty strings");
      }
    }
  }
  return issues;
}

function recordIssues(records: unknown): string[] {
  if (!Array.isArray(records)) return ["records must be an array"];
  const issues: string[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    const id = isObject(record) ? record.id : undefined;
    if (!isNonEmptyString(id)) {
      issues.push("every record needs a non-empty id");
      continue;
    }
    if (seen.has(id)) issues.push(`duplicate record id "${id}"`);
    seen.add(id);
    if (!RECORD_TYPES.includes((record as Record<string, unknown>).type as string)) {
      issues.push(`record "${id}" has an unknown type`);
    }
    if (!isObject((record as Record<string, unknown>).attributes)) {
      issues.push(`record "${id}" needs an attributes object`);
    }
  }
  return issues;
}

function buildExamples(report: PolicySimulationReport): AffectedRecordExample[] {
  const byRecord = new Map<string, AffectedRecordExample>();
  for (const effect of report.sideEffects) {
    const existing = byRecord.get(effect.targetId);
    const reasons = [...(existing?.reasons ?? [])];
    if (!reasons.includes(effect.description)) reasons.push(effect.description);
    byRecord.set(effect.targetId, {
      id: effect.targetId,
      entityType: effect.entityType,
      severity:
        existing && SEVERITY_RANK[existing.severity] >= SEVERITY_RANK[effect.severity]
          ? existing.severity
          : effect.severity,
      reasons
    });
  }
  return [...byRecord.values()].sort(
    (a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || (a.id < b.id ? -1 : 1)
  );
}

export function runPolicySimulation(
  auth: AuthContext,
  request: MaintainerSimulationRequest
): Result<MaintainerSimulationResult, PolicySimulationErrorCode, readonly string[]> {
  if (!hasPermission(auth.role, POLICY_SIMULATION_PERMISSION)) return err("permission_denied");

  const policyProblems = policyIssues(request.policy);
  if (policyProblems.length > 0) return err("invalid_policy", policyProblems);
  const recordProblems = recordIssues(request.records);
  if (recordProblems.length > 0) return err("invalid_records", recordProblems);

  const wanted = request.recordIds ? new Set(request.recordIds) : undefined;
  const selected = wanted ? request.records.filter((record) => wanted.has(record.id)) : request.records;
  const unmatchedRecordIds = wanted
    ? [...wanted].filter((id) => !request.records.some((record) => record.id === id))
    : [];

  const report = PolicySimulator.simulate(request.policy, selected, { now: request.now });
  const ratio = report.totalEvaluated > 0 ? report.totalAffected / report.totalEvaluated : 0;
  const outcome: PolicyOutcome =
    report.totalAffected === 0 ? "no_impact" : ratio > BROAD_IMPACT_RATIO ? "broad_impact" : "limited_impact";

  const all = buildExamples(report);
  const maxExamples = Math.max(0, request.maxExamples ?? DEFAULT_MAX_EXAMPLES);
  const examples = all.slice(0, maxExamples);

  return ok({
    report,
    outcome,
    summary:
      `Policy "${request.policy.name}" v${request.policy.version} affects ${report.totalAffected} of ` +
      `${report.totalEvaluated} evaluated record(s) (${outcome.replace("_", " ")}); ` +
      `risk ${report.overallRiskLevel}, recommended action: ${report.executionPlan.recommendedAction}.`,
    examples,
    omittedExamples: all.length - examples.length,
    unmatchedRecordIds
  });
}
