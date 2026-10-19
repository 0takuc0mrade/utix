import type {
  OperationRecord,
  OperationStorage,
  RecoveryActionCode,
  StepDecision,
  StepStatus
} from "@/core/operations";
import type { AuthContext } from "@/core/auth/middleware";

export const RECOVERY_FIXTURE_SCENARIOS = [
  "normal",
  "pre_effect_failure",
  "retry",
  "ambiguous_commit",
  "authorization_denied"
] as const;

export type RecoveryFixtureScenario = typeof RECOVERY_FIXTURE_SCENARIOS[number];

export interface RecoveryPathFixture {
  readonly scenario: RecoveryFixtureScenario;
  readonly auth: AuthContext;
  readonly record: OperationRecord;
  readonly expected: {
    readonly decision: StepDecision | "complete";
    readonly action: RecoveryActionCode | null;
    readonly mayResolve: boolean;
  };
}

export interface RecoveryFixtureOptions {
  readonly scenario: RecoveryFixtureScenario;
  /** Any integer; equal seeds produce equal JSON fixtures. */
  readonly seed?: number;
}

function seeded(seed: number): () => number {
  let state = (Number.isFinite(seed) ? Math.trunc(seed) : 1) >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
}

/** Generates plain-data fixtures; no timers, randomness, storage, or network. */
export function generateRecoveryPathFixture({ scenario, seed = 1 }: RecoveryFixtureOptions): RecoveryPathFixture {
  if (!RECOVERY_FIXTURE_SCENARIOS.includes(scenario)) {
    throw new TypeError(`unknown recovery fixture scenario: ${String(scenario)}`);
  }
  const next = seeded(seed);
  const suffix = next().toString(16).padStart(8, "0");
  const at = new Date(1_700_000_000_000 + (next() % 86_400_000)).toISOString();
  const operationId = `fixture-${suffix}`;

  const stateByScenario = {
    normal: "completed",
    pre_effect_failure: "failed",
    retry: "interrupted",
    ambiguous_commit: "interrupted",
    authorization_denied: "interrupted"
  } as const;
  const statusByScenario: Record<RecoveryFixtureScenario, StepStatus> = {
    normal: "succeeded",
    pre_effect_failure: "failed",
    retry: "interrupted",
    ambiguous_commit: "interrupted",
    authorization_denied: "interrupted"
  };
  const committed = scenario === "normal" || scenario === "ambiguous_commit" || scenario === "authorization_denied";
  const decision = scenario === "normal" ? "complete" : committed ? "confirm" : "run";

  return {
    scenario,
    auth: scenario === "authorization_denied"
      ? { role: "viewer", userId: `viewer-${suffix}` }
      : { role: "maintainer", userId: `maintainer-${suffix}` },
    record: {
      id: operationId,
      kind: "fixture_external_effect",
      state: stateByScenario[scenario],
      correlationId: `corr-${suffix}`,
      createdAt: at,
      updatedAt: at,
      lastErrorCode: scenario === "normal" ? undefined : scenario,
      steps: [{
        id: "external-effect",
        status: statusByScenario[scenario],
        attempt: scenario === "retry" ? 2 : 1,
        idempotencyKey: `operation:${operationId}:step:external-effect`,
        sideEffectCommitted: committed,
        updatedAt: at,
        errorCode: scenario === "normal" ? undefined : scenario
      }]
    },
    expected: {
      decision,
      action: scenario === "normal" ? null : committed ? "confirm_external_state" : "retry_step",
      mayResolve: scenario !== "authorization_denied"
    }
  };
}

export function generateRecoveryFixtureCorpus(seed = 1): readonly RecoveryPathFixture[] {
  return RECOVERY_FIXTURE_SCENARIOS.map((scenario, index) =>
    generateRecoveryPathFixture({ scenario, seed: seed + index })
  );
}

export type StorageFailurePoint = "read" | "write" | "remove" | "list";

/** A deterministic adapter for exercising checkpoint persistence failures. */
export function createFaultingOperationStorage(
  initial: OperationRecord | undefined,
  failure: StorageFailurePoint
): OperationStorage {
  let value = initial;
  const fault = (point: StorageFailurePoint): void => {
    if (point === failure) throw new Error(`fixture_${point}_failure`);
  };
  return {
    read() { fault("read"); return value; },
    write(record) { fault("write"); value = record; },
    remove() { fault("remove"); value = undefined; },
    list() { fault("list"); return value ? [value] : []; }
  };
}
