import { describe, expect, it } from "vitest";
import {
  executeIncidentDrill,
  formatDrillReport,
  PREDEFINED_DRILL_SCENARIOS,
  type DrillScenario
} from "../drill";

describe("Incident Drill Execution Suite", () => {
  it("executes the Horizon outage drill scenario end-to-end", async () => {
    const scenario = PREDEFINED_DRILL_SCENARIOS["drill-horizon-outage"];
    const result = await executeIncidentDrill(scenario);

    expect(result.passed).toBe(true);
    expect(result.phases.length).toBe(5);
    expect(result.phases.every(p => p.passed)).toBe(true);

    // Verify user impact report
    expect(result.userImpactReport.downtimeSeconds).toBe(180);
    expect(result.userImpactReport.affectedUsersCount).toBe(1420);
    expect(result.userImpactReport.recoveredOperationsCount).toBe(385);
    expect(result.userImpactReport.dataIntegrityVerified).toBe(true);

    // Verify audit receipt
    expect(result.auditReceipt).toHaveLength(64);
  });

  it("executes the ledger sequence drift drill scenario", async () => {
    const scenario = PREDEFINED_DRILL_SCENARIOS["drill-stale-ledger-drift"];
    const result = await executeIncidentDrill(scenario);

    expect(result.passed).toBe(true);
    expect(result.incidentContext.severity).toBe("high");
    expect(result.userImpactReport.affectedUsersCount).toBe(310);
  });

  it("executes data corruption restore invariant drill", async () => {
    const scenario = PREDEFINED_DRILL_SCENARIOS["drill-data-corruption-recovery"];
    const result = await executeIncidentDrill(scenario);

    expect(result.passed).toBe(true);
    expect(result.incidentContext.severity).toBe("critical");
    expect(result.userImpactReport.dataIntegrityVerified).toBe(true);
  });

  it("executes poisoned webhook signature flood drill", async () => {
    const scenario = PREDEFINED_DRILL_SCENARIOS["drill-poisoned-webhook-flood"];
    const result = await executeIncidentDrill(scenario);

    expect(result.passed).toBe(true);
    expect(result.phases.find(p => p.phaseName === "rollback_and_recovery")?.passed).toBe(true);
  });

  it("detects and flags failure when a mitigation step check fails", async () => {
    const failingScenario: DrillScenario = {
      id: "drill-horizon-outage",
      title: "Failing Drill Simulation",
      description: "Drill with failing mitigation check",
      simulatedSeverity: "critical",
      affectedSystems: ["test-system"],
      symptoms: ["database_unavailable"],
      mitigationActions: [
        {
          action: "Broken mitigation step",
          expectedDuration: 1,
          check: () => false // FAILS INTENTIONALLY
        }
      ],
      rollbackPlan: {
        targetVersion: "v1.0",
        backupLocation: "s3://backup",
        validationChecks: [{ name: "check1", check: () => true }]
      },
      simulatedImpact: {
        affectedUsers: 10,
        failedOperations: 5,
        downtimeSeconds: 30
      }
    };

    const result = await executeIncidentDrill(failingScenario);
    expect(result.passed).toBe(false);

    const mitigationPhase = result.phases.find(p => p.phaseName === "mitigation");
    expect(mitigationPhase).toBeDefined();
    expect(mitigationPhase?.passed).toBe(false);
  });

  it("formats human-readable drill execution report", async () => {
    const scenario = PREDEFINED_DRILL_SCENARIOS["drill-horizon-outage"];
    const result = await executeIncidentDrill(scenario);
    const formatted = formatDrillReport(result);

    expect(formatted).toContain("INCIDENT DRILL EXECUTION REPORT");
    expect(formatted).toContain("Scenario:          drill-horizon-outage");
    expect(formatted).toContain("[PASSED] ALL PHASES VERIFIED");
    expect(formatted).toContain("USER IMPACT REPORT:");
    expect(formatted).toContain("Estimated Downtime:    180 seconds");
  });
});
