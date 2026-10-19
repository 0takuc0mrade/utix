/**
 * Policy Simulation Preview Engine (#234)
 *
 * Implements read-only preview of proposed policy modifications before committing
 * irreversible or high-impact operational changes across Stellar accounts,
 * transactions, Soroban contract calls, and worker quotas.
 */

import type {
  AffectedEntitySummary,
  PolicyDefinition,
  PolicyImpactSeverity,
  PolicySimulationReport,
  RollbackConstraint,
  SimulationOptions,
  SimulationSideEffect,
  SimulationTargetRecord
} from "./types.ts";

export class PolicySimulator {
  /**
   * Previews the impact of a proposed policy against a snapshot of target records.
   * Guarantees read-only behavior: neither policy nor target records are mutated.
   */
  public static simulate(
    policy: PolicyDefinition,
    targetRecords: readonly SimulationTargetRecord[],
    options?: SimulationOptions
  ): PolicySimulationReport {
    const timestamp = options?.now instanceof Date
      ? options.now.toISOString()
      : typeof options?.now === "number"
        ? new Date(options.now).toISOString()
        : new Date().toISOString();

    // Derive the id from the injected evaluation time. Retrying the same dry
    // run against the same snapshot can therefore be compared byte-for-byte.
    const simulationId = `sim-${policy.id}-v${policy.version}-${new Date(timestamp).getTime().toString(16)}`;
    const sideEffects: SimulationSideEffect[] = [];
    const affectedRecordIds = new Set<string>();

    const byTypeCounts: Record<
      SimulationTargetRecord["type"],
      { total: number; affected: number }
    > = {
      account: { total: 0, affected: 0 },
      transaction: { total: 0, affected: 0 },
      job: { total: 0, affected: 0 },
      quota: { total: 0, affected: 0 },
      contract: { total: 0, affected: 0 }
    };

    // 1. Scan and evaluate records against policy rules and parameters
    for (const record of targetRecords) {
      if (!byTypeCounts[record.type]) {
        byTypeCounts[record.type] = { total: 0, affected: 0 };
      }
      byTypeCounts[record.type].total += 1;

      let recordAffected = false;

      // Evaluation based on record type and policy parameters
      if (record.type === "transaction") {
        const fee = Number(record.attributes.feeStroops ?? 0);
        const maxFee = policy.parameters?.maxBaseFeeStroops;
        if (typeof maxFee === "number" && fee > maxFee) {
          recordAffected = true;
          sideEffects.push({
            ruleId: "max_base_fee",
            targetId: record.id,
            entityType: "transaction",
            severity: "high",
            impactType: "fee_limit_exceeded",
            description: `Transaction fee (${fee} stroops) exceeds proposed max base fee limit (${maxFee} stroops)`,
            beforeValue: fee,
            afterValue: maxFee
          });
        }

        const opTypes = Array.isArray(record.attributes.operations)
          ? (record.attributes.operations as string[])
          : [];
        const disallowed = policy.parameters?.disallowedOperations ?? [];
        for (const op of opTypes) {
          if (disallowed.includes(op)) {
            recordAffected = true;
            sideEffects.push({
              ruleId: "disallowed_operations",
              targetId: record.id,
              entityType: "transaction",
              severity: "critical",
              impactType: "operation_disallowed",
              description: `Transaction contains disallowed operation "${op}" under proposed policy`,
              beforeValue: op,
              afterValue: "BLOCKED"
            });
          }
        }
      } else if (record.type === "account") {
        const masterWeight = Number(record.attributes.masterWeight ?? 0);
        const minWeight = policy.parameters?.minMasterWeight;
        if (typeof minWeight === "number" && masterWeight < minWeight) {
          recordAffected = true;
          sideEffects.push({
            ruleId: "min_master_weight",
            targetId: record.id,
            entityType: "account",
            severity: masterWeight === 0 ? "critical" : "high",
            impactType: "signer_weight_insufficient",
            description: `Account master key weight (${masterWeight}) is below minimum requirement (${minWeight})`,
            beforeValue: masterWeight,
            afterValue: minWeight
          });
        }

        const subentries = Number(record.attributes.subentryCount ?? 0);
        const maxSubentries = policy.parameters?.maxAccountSubentries;
        if (typeof maxSubentries === "number" && subentries > maxSubentries) {
          recordAffected = true;
          sideEffects.push({
            ruleId: "max_subentries",
            targetId: record.id,
            entityType: "account",
            severity: "medium",
            impactType: "threshold_breach",
            description: `Account subentries count (${subentries}) exceeds limit (${maxSubentries})`,
            beforeValue: subentries,
            afterValue: maxSubentries
          });
        }
      } else if (record.type === "contract") {
        const hasSimulation = Boolean(record.attributes.simulationPassed);
        if (policy.parameters?.requireSorobanSimulation && !hasSimulation) {
          recordAffected = true;
          sideEffects.push({
            ruleId: "soroban_simulation_required",
            targetId: record.id,
            entityType: "contract",
            severity: "high",
            impactType: "operation_disallowed",
            description: `Contract invocation lacks verified Soroban simulation under strict policy`,
            beforeValue: false,
            afterValue: true
          });
        }
      } else if (record.type === "quota") {
        const currentRate = Number(record.attributes.requestsPerMinute ?? 0);
        const rateLimit = Number(policy.parameters?.rateLimitPerMinute ?? Infinity);
        if (currentRate > rateLimit) {
          recordAffected = true;
          sideEffects.push({
            ruleId: "quota_rate_limit",
            targetId: record.id,
            entityType: "quota",
            severity: "medium",
            impactType: "quota_throttled",
            description: `Quota usage (${currentRate}/min) will be throttled by new limit (${rateLimit}/min)`,
            beforeValue: currentRate,
            afterValue: rateLimit
          });
        }
      }

      // Check explicit rules marked on policy
      for (const rule of policy.rules) {
        if (rule.isIrreversible) {
          recordAffected = true;
          sideEffects.push({
            ruleId: rule.id,
            targetId: record.id,
            entityType: record.type,
            severity: "critical",
            impactType: "irreversible_state_transition",
            description: `Rule "${rule.name}" commits irreversible change: ${rule.description}`,
            beforeValue: rule.currentValue,
            afterValue: rule.proposedValue
          });
        }
      }

      if (recordAffected) {
        affectedRecordIds.add(record.id);
        byTypeCounts[record.type].affected += 1;
      }
    }

    // 2. Evaluate Rollback Constraints
    const rollbackConstraints: RollbackConstraint[] = [];
    const hasIrreversibleRule = policy.rules.some((r) => r.isIrreversible);
    const hasEmergencyFreeze = Boolean(policy.parameters?.emergencyFreeze);

    if (hasEmergencyFreeze) {
      rollbackConstraints.push({
        constraintId: "emergency_freeze_constraint",
        description: "Emergency freeze blocks ledger writes and requires manual maintainer unfreeze signature",
        reversible: true,
        requiresSnapshot: true,
        prerequisites: ["Quorum authorization", "Pending operations drain verification"],
        recoveryGuidance: "Execute maintenance unfreeze runbook with dual-maintainer token"
      });
    }

    if (hasIrreversibleRule) {
      rollbackConstraints.push({
        constraintId: "irreversible_mutations",
        description: "Policy introduces irreversible schema or key updates that cannot be undone without restore",
        reversible: false,
        requiresSnapshot: true,
        prerequisites: ["Full ledger checkpoint snapshot", "Maintainer consensus sign-off"],
        recoveryGuidance: "Rollback requires full database and ledger checkpoint recovery via core/recovery runbook"
      });
    } else {
      rollbackConstraints.push({
        constraintId: "standard_reversion",
        description: "Policy parameters can be safely reverted by applying previous version configuration",
        reversible: true,
        requiresSnapshot: false,
        prerequisites: ["Maintainer configuration update access"],
        recoveryGuidance: "Re-apply previous policy configuration definition"
      });
    }

    // 3. Calculate Overall Risk Level
    let overallRiskLevel: PolicyImpactSeverity = "low";
    const criticalCount = sideEffects.filter((s) => s.severity === "critical").length;
    const highCount = sideEffects.filter((s) => s.severity === "high").length;
    const totalRecords = targetRecords.length;
    const affectedPercentage = totalRecords > 0 ? (affectedRecordIds.size / totalRecords) * 100 : 0;

    if (criticalCount > 0 || hasIrreversibleRule || hasEmergencyFreeze) {
      overallRiskLevel = "critical";
    } else if (highCount > 0 || affectedPercentage > 30) {
      overallRiskLevel = "high";
    } else if (sideEffects.length > 0 || affectedPercentage > 0) {
      overallRiskLevel = "medium";
    }

    // 4. Generate Operational Warnings & Execution Plan
    const operationalWarnings: string[] = [];
    const gatingReasons: string[] = [];

    if (hasEmergencyFreeze) {
      operationalWarnings.push("EMERGENCY FREEZE ACTIVE: All public mutations will be rejected immediately.");
      gatingReasons.push("Emergency freeze flag set");
    }
    if (criticalCount > 0) {
      operationalWarnings.push(`${criticalCount} critical side effect(s) detected across target records.`);
      gatingReasons.push(`${criticalCount} critical invariant violations would be triggered`);
    }
    if (hasIrreversibleRule) {
      operationalWarnings.push("IRREVERSIBLE CHANGES: This policy cannot be cleanly rolled back without restoring backups.");
      gatingReasons.push("Irreversible policy rule present");
    }
    if (affectedPercentage > 50) {
      operationalWarnings.push(`High impact: ${affectedPercentage.toFixed(1)}% of all evaluated entities are affected.`);
    }

    let recommendedAction: "proceed" | "proceed_with_caution" | "block" = "proceed";
    if (overallRiskLevel === "critical") {
      recommendedAction = "block";
    } else if (overallRiskLevel === "high") {
      recommendedAction = "proceed_with_caution";
    }

    const entitySummaries: AffectedEntitySummary[] = Object.entries(byTypeCounts).map(
      ([type, counts]) => ({
        entityType: type as SimulationTargetRecord["type"],
        totalEvaluated: counts.total,
        affectedCount: counts.affected,
        unaffectedCount: counts.total - counts.affected
      })
    );

    return {
      simulationId,
      policyId: policy.id,
      simulatedAt: timestamp,
      isReadOnlyVerified: true,
      overallRiskLevel,
      totalEvaluated: targetRecords.length,
      totalAffected: affectedRecordIds.size,
      entitySummaries,
      sideEffects,
      rollbackConstraints,
      operationalWarnings,
      executionPlan: {
        recommendedAction,
        gatingReasons
      }
    };
  }
}
