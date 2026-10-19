import { describe, expect, it } from "vitest";
import { runPolicySimulation } from "../maintainerSimulation";
import type { PolicyDefinition, SimulationTargetRecord } from "../types";

const MAINTAINER = { role: "maintainer", userId: "ada" } as const;

const POLICY: PolicyDefinition = {
  id: "pol-1",
  name: "Fee cap",
  description: "Caps transaction fees",
  scope: "transactions",
  version: 2,
  rules: [],
  parameters: { maxBaseFeeStroops: 1000, disallowedOperations: ["accountMerge"] }
};

function tx(id: string, feeStroops: number, operations: string[] = ["payment"]): SimulationTargetRecord {
  return { id, type: "transaction", attributes: { feeStroops, operations } };
}

const RECORDS = [tx("tx-1", 100), tx("tx-2", 200), tx("tx-3", 300), tx("tx-4", 400)];

function run(request: Parameters<typeof runPolicySimulation>[1], auth = MAINTAINER) {
  const result = runPolicySimulation(auth, request);
  if (!result.ok) throw new Error(`unexpected ${result.code}`);
  return result.value;
}

describe("runPolicySimulation", () => {
  it("reports no impact when no record is affected", () => {
    const result = run({ policy: POLICY, records: RECORDS });
    expect(result.outcome).toBe("no_impact");
    expect(result.examples).toEqual([]);
    expect(result.report.totalAffected).toBe(0);
    expect(result.summary).toContain("0 of 4");
  });

  it("explains broad impact with ranked, capped examples", () => {
    const records = [tx("tx-1", 5000), tx("tx-2", 4000, ["accountMerge"]), tx("tx-3", 3000), tx("tx-4", 10)];
    const result = run({ policy: POLICY, records, maxExamples: 2 });

    expect(result.outcome).toBe("broad_impact");
    expect(result.report.totalAffected).toBe(3);
    expect(result.examples.map((example) => example.id)).toEqual(["tx-2", "tx-1"]);
    expect(result.examples[0]).toMatchObject({ severity: "critical", entityType: "transaction" });
    expect(result.examples[0].reasons).toHaveLength(2);
    expect(result.omittedExamples).toBe(1);
  });

  it("reports limited impact for a small share of records", () => {
    const records = Array.from({ length: 10 }, (_, i) => tx(`tx-${i}`, i === 0 ? 9000 : 10));
    expect(run({ policy: POLICY, records }).outcome).toBe("limited_impact");
  });

  it("simulates only the selected records and lists unknown ids", () => {
    const records = [tx("tx-1", 5000), tx("tx-2", 10)];
    const result = run({ policy: POLICY, records, recordIds: ["tx-2", "tx-9"] });
    expect(result.report.totalEvaluated).toBe(1);
    expect(result.outcome).toBe("no_impact");
    expect(result.unmatchedRecordIds).toEqual(["tx-9"]);
  });

  it("does not mutate the policy or the records", () => {
    const records = [tx("tx-1", 5000)];
    const before = JSON.stringify({ POLICY, records });
    run({ policy: POLICY, records });
    expect(JSON.stringify({ POLICY, records })).toBe(before);
  });

  it("returns an identical preview when a dry run is retried", () => {
    const request = { policy: POLICY, records: [tx("tx-1", 5000)], now: 1_700_000_000_000 };
    expect(run(request)).toEqual(run(request));
  });

  it("rejects an invalid policy with every problem listed", () => {
    const bad = { ...POLICY, id: "", version: 0, parameters: { maxBaseFeeStroops: -1 } };
    const result = runPolicySimulation(MAINTAINER, { policy: bad, records: RECORDS });
    expect(result).toMatchObject({ ok: false, code: "invalid_policy" });
    expect(!result.ok && result.detail).toHaveLength(3);
  });

  it("rejects invalid records", () => {
    const records = [tx("tx-1", 1), tx("tx-1", 2), { id: "x", type: "ticket", attributes: {} }] as never;
    const result = runPolicySimulation(MAINTAINER, { policy: POLICY, records });
    expect(result).toMatchObject({ ok: false, code: "invalid_records" });
    expect(!result.ok && result.detail).toEqual(['duplicate record id "tx-1"', 'record "x" has an unknown type']);
  });

  it("rejects malformed preview bounds without evaluating", () => {
    const duplicateSelection = runPolicySimulation(MAINTAINER, {
      policy: POLICY,
      records: RECORDS,
      recordIds: ["tx-1", "tx-1"],
      maxExamples: -1
    });
    expect(duplicateSelection).toMatchObject({ ok: false, code: "invalid_records" });
    expect(!duplicateSelection.ok && duplicateSelection.detail).toEqual([
      "recordIds must not contain duplicates",
      "maxExamples must be a non-negative integer"
    ]);
  });

  it("denies roles without config access", () => {
    for (const role of ["viewer", "service"] as const) {
      expect(runPolicySimulation({ role }, { policy: POLICY, records: RECORDS })).toEqual({
        ok: false,
        code: "permission_denied"
      });
    }
  });
});
