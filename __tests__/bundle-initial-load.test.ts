import { describe, expect, it } from "vitest";
import {
  checkBudgets,
  loadExceptions,
  loadBaseline,
  analyzeRouteInitialLoad,
  formatReport,
  DEFAULT_BUDGET_KB,
  ROUTE_INITIAL_LOAD_BUDGET_KB
} from "@/scripts/bundle-budget.mjs";

describe("Initial-Load Performance Budgets & SDK Exception Path (#159)", () => {
  const sampleExceptions = {
    "xdr-inspector": {
      budgetKB: 350,
      justification: "Deep recursive XDR parser and Soroban contract type schemas",
      approved: true
    },
    "soroban-decoder": {
      budgetKB: 300,
      justification: "Full Soroban ScVal decoding and contract auth types",
      approved: true
    }
  };

  const sampleBaseline = {
    "address-validator": { totalSize: 102400, sizeKB: 100 },
    "_route_initial_load": { totalSize: 184320, sizeKB: 180 }
  };

  it("approves standard feature within normal budget", () => {
    const featureSizes = {
      "address-validator": { totalSize: 110 * 1024, chunks: [] }
    };
    const routeInitialLoad = { totalSize: 150 * 1024, sizeKB: 150, chunks: [] };

    const { results, routeResult, hasViolations } = checkBudgets(
      featureSizes,
      routeInitialLoad,
      sampleBaseline,
      sampleExceptions
    );

    expect(hasViolations).toBe(false);
    expect(results[0].status).toBe("OK");
    expect(results[0].withinBudget).toBe(true);
    expect(routeResult.status).toBe("OK");
  });

  it("flags violation when tool exceeds budget without approved exception", () => {
    const featureSizes = {
      "random-heavy-tool": { totalSize: 180 * 1024, chunks: [] } // Exceeds default 150 KB
    };
    const routeInitialLoad = { totalSize: 150 * 1024, sizeKB: 150, chunks: [] };

    const { results, hasViolations } = checkBudgets(
      featureSizes,
      routeInitialLoad,
      sampleBaseline,
      sampleExceptions
    );

    expect(hasViolations).toBe(true);
    expect(results[0].status).toBe("EXCEEDED");
    expect(results[0].withinBudget).toBe(false);
  });

  it("approves SDK-heavy feature that exceeds standard budget via documented exception path", () => {
    const featureSizes = {
      "xdr-inspector": { totalSize: 280 * 1024, chunks: [] } // 280 KB > 150 KB standard, but < 350 KB exception ceiling
    };
    const routeInitialLoad = { totalSize: 150 * 1024, sizeKB: 150, chunks: [] };

    const { results, hasViolations } = checkBudgets(
      featureSizes,
      routeInitialLoad,
      sampleBaseline,
      sampleExceptions
    );

    expect(hasViolations).toBe(false);
    expect(results[0].status).toBe("EXCEPTION_APPROVED");
    expect(results[0].withinBudget).toBe(true);
    expect(results[0].isException).toBe(true);
    expect(results[0].justification).toContain("Deep recursive XDR parser");
  });

  it("rejects feature that exceeds its approved exception ceiling", () => {
    const featureSizes = {
      "xdr-inspector": { totalSize: 380 * 1024, chunks: [] } // 380 KB > 350 KB exception ceiling!
    };
    const routeInitialLoad = { totalSize: 150 * 1024, sizeKB: 150, chunks: [] };

    const { results, hasViolations } = checkBudgets(
      featureSizes,
      routeInitialLoad,
      sampleBaseline,
      sampleExceptions
    );

    expect(hasViolations).toBe(true);
    expect(results[0].status).toContain("EXCEEDED");
    expect(results[0].withinBudget).toBe(false);
  });

  it("enforces route-level initial-load budget limit", () => {
    const featureSizes = {
      "address-validator": { totalSize: 100 * 1024, chunks: [] }
    };
    // Exceeds 220 KB route initial-load budget
    const heavyRouteInitialLoad = { totalSize: 260 * 1024, sizeKB: 260, chunks: [] };

    const { routeResult, hasViolations } = checkBudgets(
      featureSizes,
      heavyRouteInitialLoad,
      sampleBaseline,
      sampleExceptions
    );

    expect(hasViolations).toBe(true);
    expect(routeResult.status).toBe("EXCEEDED");
    expect(routeResult.withinBudget).toBe(false);
  });

  it("loads documented exceptions catalog from repository file", () => {
    const exceptions = loadExceptions();
    expect(exceptions["xdr-inspector"]).toBeDefined();
    expect(exceptions["xdr-inspector"].approved).toBe(true);
    expect(exceptions["xdr-inspector"].budgetKB).toBeGreaterThan(DEFAULT_BUDGET_KB);
  });

  it("formats comprehensive report containing route and exception information", () => {
    const results = [
      {
        feature: "xdr-inspector",
        sizeKB: 280,
        budgetKB: 350,
        isException: true,
        justification: "Soroban bindings",
        status: "EXCEPTION_APPROVED",
        delta: 0,
        baselineSizeKB: 280,
        withinBudget: true
      }
    ];
    const routeResult = {
      name: "Route Initial-Load (/tools/[slug])",
      sizeKB: 180,
      budgetKB: ROUTE_INITIAL_LOAD_BUDGET_KB,
      baselineSizeKB: 180,
      delta: 0,
      status: "OK",
      withinBudget: true
    };

    const report = formatReport(results, routeResult, false);
    expect(report).toContain("UTIX INITIAL-LOAD & FEATURE BUNDLE BUDGET REPORT");
    expect(report).toContain("ROUTE INITIAL-LOAD COSTS");
    expect(report).toContain("Exception Approved: Soroban bindings");
  });
});
