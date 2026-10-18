import { describe, expect, it } from "vitest";
import { analyzeImpact, type DependencyNode, type ImpactReport } from "@/core/dependencies/graph";

const MAINTAINER = { role: "maintainer", userId: "ada" } as const;
const VIEWER = { role: "viewer" } as const;

const GRAPH: DependencyNode[] = [
  { id: "ref-1", kind: "external_reference", dependsOn: [] },
  { id: "event-1", kind: "event", dependsOn: ["ref-1"] },
  { id: "ticket-1", kind: "ticket", dependsOn: ["event-1"] },
  { id: "user-1", kind: "user", dependsOn: ["ticket-1"] },
  { id: "op-1", kind: "operation", dependsOn: ["ticket-1", "user-1"] }
];

function analyze(
  nodes: DependencyNode[],
  rootId: string,
  auth: Parameters<typeof analyzeImpact>[2] = MAINTAINER,
  direction?: "dependents" | "dependencies"
): ImpactReport {
  const result = analyzeImpact(nodes, rootId, auth, direction);
  if (!result.ok) throw new Error(`unexpected ${result.code}`);
  return result.value;
}

describe("analyzeImpact", () => {
  it("lists direct and indirect dependents with their depth", () => {
    const report = analyze(GRAPH, "event-1");
    expect(report.direct).toEqual([{ id: "ticket-1", kind: "ticket", depth: 1 }]);
    expect(report.indirect).toEqual([
      { id: "op-1", kind: "operation", depth: 2 },
      { id: "user-1", kind: "user", depth: 2 }
    ]);
    expect(report.cycles).toEqual([]);
    expect(report.missingReferences).toEqual([]);
  });

  it("walks the other way for dependencies", () => {
    const report = analyze(GRAPH, "user-1", MAINTAINER, "dependencies");
    expect(report.direct.map((entry) => entry.id)).toEqual(["ticket-1"]);
    expect(report.indirect.map((entry) => entry.id)).toEqual(["event-1", "ref-1"]);
  });

  it("terminates on cycles and reports them", () => {
    const cyclic: DependencyNode[] = [
      { id: "a", kind: "event", dependsOn: ["c"] },
      { id: "b", kind: "event", dependsOn: ["a"] },
      { id: "c", kind: "event", dependsOn: ["b"] }
    ];
    const report = analyze(cyclic, "a");
    expect(report.direct.map((entry) => entry.id)).toEqual(["b"]);
    expect(report.indirect.map((entry) => entry.id)).toEqual(["c"]);
    expect(report.cycles).toEqual([["a", "b", "c", "a"]]);
  });

  it("reports missing references on reachable resources only", () => {
    const nodes: DependencyNode[] = [
      ...GRAPH,
      { id: "ticket-2", kind: "ticket", dependsOn: ["event-1", "ghost-1"] },
      { id: "unrelated", kind: "ticket", dependsOn: ["ghost-2"] }
    ];
    expect(analyze(nodes, "event-1").missingReferences).toEqual([
      { from: "ticket-2", missingId: "ghost-1" }
    ]);
  });

  it("redacts restricted resources for unauthorized callers", () => {
    const nodes: DependencyNode[] = [
      ...GRAPH,
      { id: "user-secret", kind: "user", dependsOn: ["ticket-1"], restricted: true },
      { id: "op-secret", kind: "operation", dependsOn: ["user-secret", "ghost"], restricted: true }
    ];
    const redacted = analyze(nodes, "event-1", VIEWER);
    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain("secret");
    expect(redacted.redactedCount).toBe(2);
    expect(redacted.direct).toEqual([{ id: "ticket-1", kind: "ticket", depth: 1 }]);
    expect(redacted.indirect.filter((entry) => entry.kind === "redacted")).toHaveLength(2);
    expect(redacted.missingReferences).toEqual([{ from: "redacted:2", missingId: "ghost" }]);

    const full = analyze(nodes, "event-1", MAINTAINER);
    expect(full.redactedCount).toBe(0);
    expect(full.indirect.map((entry) => entry.id)).toContain("user-secret");
  });

  it("rejects unknown roots, restricted roots and unauthorized callers", () => {
    const nodes: DependencyNode[] = [...GRAPH, { id: "vault", kind: "user", dependsOn: [], restricted: true }];
    expect(analyzeImpact(nodes, "nope", MAINTAINER)).toEqual({ ok: false, code: "resource_not_found" });
    expect(analyzeImpact(nodes, "vault", VIEWER)).toEqual({ ok: false, code: "permission_denied" });
    expect(analyzeImpact(nodes, "event-1", { role: "service" })).toEqual({
      ok: false,
      code: "permission_denied"
    });
  });
});
