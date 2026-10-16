import { describe, expect, it } from "vitest";
import { PolicySimulator } from "../simulation";
import type { PolicyDefinition, SimulationTargetRecord } from "../types";

describe("PolicySimulator", () => {
  const sampleRecords: readonly SimulationTargetRecord[] = [
    {
      id: "tx-100",
      type: "transaction",
      attributes: {
        feeStroops: 500,
        operations: ["payment", "setOptions"]
      }
    },
    {
      id: "tx-200",
      type: "transaction",
      attributes: {
        feeStroops: 2000,
        operations: ["accountMerge"]
      }
    },
    {
      id: "acc-GAAA",
      type: "account",
      attributes: {
        masterWeight: 0,
        subentryCount: 15
      }
    },
    {
      id: "acc-GBBB",
      type: "account",
      attributes: {
        masterWeight: 10,
        subentryCount: 2
      }
    },
    {
      id: "contract-1",
      type: "contract",
      attributes: {
        simulationPassed: false
      }
    },
    {
      id: "quota-user-1",
      type: "quota",
      attributes: {
        requestsPerMinute: 120
      }
    }
  ];

  it("evaluates a policy in read-only mode without mutating target records", () => {
    const policy: PolicyDefinition = {
      id: "pol-test-1",
      name: "Standard Guardrails",
      description: "Applies basic fee and weight constraints",
      scope: "global",
      version: 1,
      rules: [],
      parameters: {
        maxBaseFeeStroops: 1000,
        minMasterWeight: 1
      }
    };

    const recordsClone = JSON.parse(JSON.stringify(sampleRecords));
    const report = PolicySimulator.simulate(policy, sampleRecords);

    expect(report.isReadOnlyVerified).toBe(true);
    expect(sampleRecords).toEqual(recordsClone);
    expect(report.totalEvaluated).toBe(sampleRecords.length);
  });

  it("detects fee limits and disallowed operations on transactions", () => {
    const policy: PolicyDefinition = {
      id: "pol-fee-and-ops",
      name: "Strict Transaction Policy",
      description: "Caps fees and disallows account merges",
      scope: "transactions",
      version: 1,
      rules: [],
      parameters: {
        maxBaseFeeStroops: 1000,
        disallowedOperations: ["accountMerge"]
      }
    };

    const report = PolicySimulator.simulate(policy, sampleRecords);

    const feeSideEffects = report.sideEffects.filter(
      (s) => s.impactType === "fee_limit_exceeded"
    );
    expect(feeSideEffects).toHaveLength(1);
    expect(feeSideEffects[0].targetId).toBe("tx-200");

    const disallowedSideEffects = report.sideEffects.filter(
      (s) => s.impactType === "operation_disallowed"
    );
    expect(disallowedSideEffects.some((s) => s.targetId === "tx-200")).toBe(true);
  });

  it("detects signer weight and subentry threshold breaches on accounts", () => {
    const policy: PolicyDefinition = {
      id: "pol-acc-limits",
      name: "Account Security Policy",
      description: "Ensures active master key and caps subentries",
      scope: "accounts",
      version: 1,
      rules: [],
      parameters: {
        minMasterWeight: 1,
        maxAccountSubentries: 10
      }
    };

    const report = PolicySimulator.simulate(policy, sampleRecords);

    const weightSideEffects = report.sideEffects.filter(
      (s) => s.impactType === "signer_weight_insufficient"
    );
    expect(weightSideEffects).toHaveLength(1);
    expect(weightSideEffects[0].targetId).toBe("acc-GAAA");
    expect(weightSideEffects[0].severity).toBe("critical"); // weight 0 is critical

    const subentrySideEffects = report.sideEffects.filter(
      (s) => s.impactType === "threshold_breach"
    );
    expect(subentrySideEffects).toHaveLength(1);
    expect(subentrySideEffects[0].targetId).toBe("acc-GAAA");
  });

  it("flags Soroban simulation requirements and quota throttling", () => {
    const policy: PolicyDefinition = {
      id: "pol-soroban-quota",
      name: "Soroban and Quota Limits",
      description: "Requires simulation and sets rate limit",
      scope: "global",
      version: 1,
      rules: [],
      parameters: {
        requireSorobanSimulation: true,
        rateLimitPerMinute: 60
      }
    };

    const report = PolicySimulator.simulate(policy, sampleRecords);

    const contractSideEffect = report.sideEffects.find((s) => s.targetId === "contract-1");
    expect(contractSideEffect?.impactType).toBe("operation_disallowed");

    const quotaSideEffect = report.sideEffects.find((s) => s.targetId === "quota-user-1");
    expect(quotaSideEffect?.impactType).toBe("quota_throttled");
  });

  it("identifies irreversible rules and enforces rollback constraints", () => {
    const policy: PolicyDefinition = {
      id: "pol-destructive",
      name: "Irreversible Schema Cleanup",
      description: "Purges deprecated subentry records permanently",
      scope: "global",
      version: 2,
      rules: [
        {
          id: "purge_old_data",
          name: "Purge Stale Data",
          description: "Permanent truncation of historical records",
          parameter: "purge_enabled",
          currentValue: false,
          proposedValue: true,
          isIrreversible: true
        }
      ]
    };

    const report = PolicySimulator.simulate(policy, sampleRecords);

    expect(report.overallRiskLevel).toBe("critical");
    expect(report.executionPlan.recommendedAction).toBe("block");

    const irreversibleConstraint = report.rollbackConstraints.find(
      (c) => c.constraintId === "irreversible_mutations"
    );
    expect(irreversibleConstraint).toBeDefined();
    expect(irreversibleConstraint?.reversible).toBe(false);
    expect(irreversibleConstraint?.requiresSnapshot).toBe(true);
  });

  it("handles emergency freeze with critical risk and blocking recommendations", () => {
    const policy: PolicyDefinition = {
      id: "pol-freeze",
      name: "Emergency Circuit Breaker",
      description: "Halts all operations during incident",
      scope: "global",
      version: 1,
      rules: [],
      parameters: {
        emergencyFreeze: true
      }
    };

    const report = PolicySimulator.simulate(policy, sampleRecords);

    expect(report.overallRiskLevel).toBe("critical");
    expect(report.executionPlan.recommendedAction).toBe("block");
    expect(report.operationalWarnings.some((w) => w.includes("EMERGENCY FREEZE"))).toBe(true);
  });

  it("returns proceed for benign low-risk policies", () => {
    const policy: PolicyDefinition = {
      id: "pol-safe",
      name: "Benign Policy",
      description: "Very relaxed limits",
      scope: "global",
      version: 1,
      rules: [],
      parameters: {
        maxBaseFeeStroops: 50000,
        minMasterWeight: 0,
        maxAccountSubentries: 100,
        rateLimitPerMinute: 1000
      }
    };

    const report = PolicySimulator.simulate(policy, sampleRecords);

    expect(report.overallRiskLevel).toBe("low");
    expect(report.totalAffected).toBe(0);
    expect(report.executionPlan.recommendedAction).toBe("proceed");
  });
});
