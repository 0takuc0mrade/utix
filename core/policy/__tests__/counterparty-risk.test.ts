import { describe, expect, it } from "vitest";
import {
  evaluateCounterpartyRisk,
  toPublicRiskSummary,
  type CounterpartyProfile
} from "../counterparty-risk";

const established: CounterpartyProfile = {
  accountAgeDays: 400,
  disputeCount: 0,
  flaggedByFraudControls: false,
  bulkTransferCount: 0
};

describe("evaluateCounterpartyRisk", () => {
  it("reports low risk for an established counterparty with no signals", () => {
    const report = evaluateCounterpartyRisk("GA-LOW", established);

    expect(report.state).toBe("low");
    expect(report.source).toBe("score");
    expect(report.score).toBe(0);
    expect(report.signals).toEqual([]);
  });

  it("reports medium risk when a single moderate signal fires", () => {
    const report = evaluateCounterpartyRisk("GA-MED", { ...established, disputeCount: 1 });

    expect(report.state).toBe("medium");
    expect(report.score).toBe(40);
    expect(report.signals.map((signal) => signal.id)).toEqual(["disputes"]);
  });

  it("reports high risk when signals combine past the high threshold", () => {
    const report = evaluateCounterpartyRisk("GA-HIGH", {
      accountAgeDays: 2,
      disputeCount: 3,
      flaggedByFraudControls: true,
      bulkTransferCount: 25
    });

    expect(report.state).toBe("high");
    expect(report.score).toBe(100);
  });

  it("reports unknown when there is no profile and no override", () => {
    const report = evaluateCounterpartyRisk("GA-UNKNOWN", null);

    expect(report.state).toBe("unknown");
    expect(report.source).toBe("no_profile");
    expect(report.score).toBeNull();
  });

  it("lets a maintainer override replace the scored state while keeping the score", () => {
    const report = evaluateCounterpartyRisk(
      "GA-OVERRIDE",
      { ...established, flaggedByFraudControls: true },
      { state: "low", setBy: "maintainer-1", reason: "Cleared after manual review" }
    );

    expect(report.state).toBe("low");
    expect(report.source).toBe("override");
    expect(report.score).toBe(50);
    expect(report.explanation).toContain("maintainer-1");
  });

  it("applies an override even when no profile exists", () => {
    const report = evaluateCounterpartyRisk("GA-NOPROFILE", null, {
      state: "high",
      setBy: "maintainer-2",
      reason: "Known bad actor"
    });

    expect(report.state).toBe("high");
    expect(report.source).toBe("override");
    expect(report.score).toBeNull();
  });
});

describe("toPublicRiskSummary", () => {
  it("exposes only the counterparty and state, never score or signals", () => {
    const report = evaluateCounterpartyRisk("GA-PUBLIC", {
      ...established,
      disputeCount: 2
    });

    expect(toPublicRiskSummary(report)).toEqual({ counterpartyId: "GA-PUBLIC", state: "medium" });
  });
});
