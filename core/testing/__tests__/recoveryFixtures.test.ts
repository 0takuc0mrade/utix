import { describe, expect, it } from "vitest";
import {
  decideStep,
  nextActionFor,
  resolveInterruptedStepAuthorized,
  runOperation,
  type OperationDefinition
} from "@/core/operations";
import {
  createFaultingOperationStorage,
  generateRecoveryFixtureCorpus,
  generateRecoveryPathFixture
} from "@/core/testing/recoveryFixtures";

describe("recovery fixture generators", () => {
  it("is seeded, serializable, and covers every recovery path", () => {
    const first = generateRecoveryFixtureCorpus(42);
    const again = generateRecoveryFixtureCorpus(42);
    expect(JSON.stringify(first)).toBe(JSON.stringify(again));
    expect(first.map(({ scenario }) => scenario)).toEqual([
      "normal", "pre_effect_failure", "retry", "ambiguous_commit", "authorization_denied"
    ]);
  });

  it.each(generateRecoveryFixtureCorpus(7))("matches the $scenario recovery contract", (fixture) => {
    const checkpoint = fixture.record.steps[0];
    const decision = fixture.record.state === "completed" ? "complete" : decideStep(checkpoint);
    expect(decision).toBe(fixture.expected.decision);
    expect(nextActionFor(fixture.record)?.code ?? null).toBe(fixture.expected.action);
  });

  it("drives the real authorization denial without mutating the fixture", () => {
    const fixture = generateRecoveryPathFixture({ scenario: "authorization_denied", seed: 9 });
    const storage = createFaultingOperationStorage(fixture.record, "remove");
    const before = JSON.stringify(storage.read(fixture.record.id));
    expect(resolveInterruptedStepAuthorized(
      fixture.auth, fixture.record.id, "external-effect", "applied", { storage }
    )).toEqual({ ok: false, code: "permission_denied" });
    expect(JSON.stringify(storage.read(fixture.record.id))).toBe(before);
  });

  it("drives a checkpoint write failure through the real runner", async () => {
    const storage = createFaultingOperationStorage(undefined, "write");
    const definition: OperationDefinition<null> = {
      kind: "fixture",
      steps: [{ id: "external-effect", run: () => ({ status: "succeeded" }) }]
    };
    await expect(runOperation(definition, {
      operationId: "faulting-write",
      context: null,
      storage,
      now: () => 1_700_000_000_000,
      newCorrelationId: () => "corr-fixture"
    })).resolves.toEqual({ ok: false, code: "storage_error" });
  });

  it("rejects unknown scenarios instead of silently generating misleading data", () => {
    expect(() => generateRecoveryPathFixture({ scenario: "typo" as never })).toThrow(TypeError);
  });
});
