import { describe, expect, it } from "vitest";
import type { Result } from "@/core/result/result";
import {
  abandonOperation,
  abandonOperationAuthorized,
  createOperationStorage,
  decideStep,
  defaultIdempotencyKey,
  nextActionFor,
  operationMachine,
  resolveInterruptedStep,
  resolveInterruptedStepAuthorized,
  runOperation,
  type OperationDefinition,
  type OperationErrorCode,
  type OperationProgress,
  type OperationRecord,
  type OperationStorage,
  type StepCheckpoint,
  type StepDefinition,
  type StepOutcome,
  type StepRunInput,
  type StepStatus
} from "@/core/operations";

interface Ctx {
  readonly ticket: string;
}

interface Recorder {
  readonly calls: string[];
  readonly keys: string[];
  readonly attempts: number[];
}

function recorder(): Recorder {
  return { calls: [], keys: [], attempts: [] };
}

/** A clock that advances a second per call, so records are reproducible. */
function clock(startMs = 1_700_000_000_000): () => number {
  let current = startMs;
  return () => {
    current += 1000;
    return current;
  };
}

function options(storage: OperationStorage, seed: number = 0) {
  return {
    operationId: "op-1",
    context: { ticket: "T-1" },
    storage,
    now: clock(1_700_000_000_000 + seed * 60_000),
    newCorrelationId: () => "corr-1"
  };
}

function progress(result: Result<OperationProgress, OperationErrorCode>): OperationProgress {
  if (!result.ok) throw new Error(`expected the run to be stored, got ${result.code}`);
  return result.value;
}

function tracked(
  id: string,
  outcome: (input: StepRunInput<Ctx>) => StepOutcome,
  log: Recorder
): StepDefinition<Ctx> {
  return {
    id,
    run(input) {
      log.calls.push(id);
      log.keys.push(input.idempotencyKey);
      log.attempts.push(input.attempt);
      return outcome(input);
    }
  };
}

function checkpointOf(record: OperationRecord, id: string): StepCheckpoint | undefined {
  return record.steps.find((entry) => entry.id === id);
}

function statusOf(record: OperationRecord, id: string): StepStatus {
  return checkpointOf(record, id)?.status ?? "pending";
}

describe("runOperation", () => {
  it("runs every step in order, threads the previous output, and completes", async () => {
    const log = recorder();
    const storage = createOperationStorage();
    const definition: OperationDefinition<Ctx> = {
      kind: "ticket_flow",
      steps: [
        tracked("issue", () => ({ status: "succeeded", output: { ticketId: "TCK-9" } }), log),
        tracked(
          "submit",
          (input) => {
            expect(input.previous).toEqual({ ticketId: "TCK-9" });
            expect(input.context.ticket).toBe("T-1");
            return { status: "succeeded", committed: false };
          },
          log
        )
      ]
    };

    const result = progress(await runOperation(definition, options(storage)));

    expect(result.state).toBe("completed");
    expect(result.errorCode).toBeNull();
    expect(result.action).toBeNull();
    expect(log.calls).toEqual(["issue", "submit"]);
    expect(log.attempts).toEqual([1, 1]);
    expect(result.record.state).toBe("completed");
    expect(result.record.correlationId).toBe("corr-1");
    expect(statusOf(result.record, "submit")).toBe("succeeded");
    expect(storage.read("op-1")?.state).toBe("completed");
  });

  it("writes the checkpoint before the step runs, so a mid-step death is visible", async () => {
    const storage = createOperationStorage();
    const observed: StepStatus[] = [];
    const definition: OperationDefinition<Ctx> = {
      kind: "ticket_flow",
      steps: [
        {
          id: "submit",
          run: () => {
            const stored = storage.read("op-1");
            observed.push(
              stored ? statusOf(stored, "submit") : "pending"
            );
            return { status: "succeeded" };
          }
        }
      ]
    };

    await runOperation(definition, options(storage));

    expect(observed).toEqual(["running"]);
  });

  it("skips already-succeeded steps on a resume instead of replaying them", async () => {
    const log = recorder();
    const storage = createOperationStorage();
    const first: OperationDefinition<Ctx> = {
      kind: "ticket_flow",
      steps: [
        tracked("issue", () => ({ status: "succeeded", output: "issued" }), log),
        tracked(
          "submit",
          (input) =>
            input.attempt === 1
              ? { status: "interrupted", errorCode: "network" }
              : { status: "succeeded" },
          log
        )
      ]
    };

    const stalled = progress(await runOperation(first, options(storage)));
    expect(stalled.state).toBe("interrupted");
    expect(stalled.errorCode).toBe("network");
    expect(stalled.action?.code).toBe("retry_step");
    expect(log.calls).toEqual(["issue", "submit"]);

    const resumed = progress(await runOperation(first, options(storage, 1)));

    expect(resumed.state).toBe("completed");
    // `issue` is not run a second time, and `submit` is retried with the same key.
    expect(log.calls).toEqual(["issue", "submit", "submit"]);
    expect(log.keys[1]).toBe(log.keys[2]);
    expect(log.attempts).toEqual([1, 1, 2]);
  });

  it("does not re-run a step whose effect was submitted but not confirmed", async () => {
    const log = recorder();
    const storage = createOperationStorage();
    const definition: OperationDefinition<Ctx> = {
      kind: "ticket_flow",
      steps: [
        tracked(
          "submit",
          () => ({ status: "interrupted", errorCode: "confirmation_timeout", committed: true }),
          log
        ),
        tracked("confirm", () => ({ status: "succeeded" }), log)
      ]
    };

    const first = progress(await runOperation(definition, options(storage)));
    expect(first.state).toBe("interrupted");
    expect(first.action?.code).toBe("confirm_external_state");
    expect(first.action?.stepId).toBe("submit");
    expect(checkpointOf(first.record, "submit")?.sideEffectCommitted).toBe(true);

    const second = progress(await runOperation(definition, options(storage, 1)));

    expect(second.state).toBe("interrupted");
    expect(second.action?.code).toBe("confirm_external_state");
    // The step is never called again, so a submitted effect cannot be submitted twice.
    expect(log.calls).toEqual(["submit"]);
    expect(log.calls).not.toContain("confirm");
  });

  it("treats a failure that happened after the effect landed as an interruption", async () => {
    const storage = createOperationStorage();
    const definition: OperationDefinition<Ctx> = {
      kind: "ticket_flow",
      steps: [
        {
          id: "submit",
          run: () => ({ status: "failed", errorCode: "relay_unreachable", committed: true })
        }
      ]
    };

    const result = progress(await runOperation(definition, options(storage)));

    expect(result.state).toBe("interrupted");
    expect(result.action?.code).toBe("confirm_external_state");
    expect(result.record.state).toBe("interrupted");
  });

  it("marks a step that failed before any side effect as failed, and retries it safely", async () => {
    const log = recorder();
    const storage = createOperationStorage();
    let failFirst = true;
    const definition: OperationDefinition<Ctx> = {
      kind: "ticket_flow",
      steps: [
        {
          id: "submit",
          run: (input) => {
            log.calls.push("submit");
            log.keys.push(input.idempotencyKey);
            log.attempts.push(input.attempt);
            if (failFirst) {
              failFirst = false;
              return { status: "failed", errorCode: "insufficient_balance" };
            }
            return { status: "succeeded" };
          }
        }
      ]
    };

    const failed = progress(await runOperation(definition, options(storage)));
    expect(failed.state).toBe("failed");
    expect(failed.errorCode).toBe("insufficient_balance");
    expect(failed.action?.code).toBe("retry_step");

    const retried = progress(await runOperation(definition, options(storage, 1)));
    expect(retried.state).toBe("completed");
    expect(log.attempts).toEqual([1, 2]);
    expect(log.keys[0]).toBe(log.keys[1]);
  });

  it("turns a thrown step into a retryable interruption with the same idempotency key", async () => {
    const storage = createOperationStorage();
    const keys: string[] = [];
    const attempts: number[] = [];
    let crash = true;
    const definition: OperationDefinition<Ctx> = {
      kind: "ticket_flow",
      steps: [
        {
          id: "submit",
          run: (input) => {
            keys.push(input.idempotencyKey);
            attempts.push(input.attempt);
            if (crash) {
              crash = false;
              throw new Error("tab closed");
            }
            return { status: "succeeded" };
          }
        }
      ]
    };

    const crashed = progress(await runOperation(definition, options(storage)));
    expect(crashed.state).toBe("interrupted");
    expect(crashed.errorCode).toBe("step_threw");
    expect(crashed.record.lastErrorCode).toBe("step_threw");

    const resumed = progress(await runOperation(definition, options(storage, 1)));
    expect(resumed.state).toBe("completed");
    expect(keys[0]).toBe(defaultIdempotencyKey("op-1", "submit"));
    expect(keys[0]).toBe(keys[1]);
    expect(attempts).toEqual([1, 2]);
  });

  it("is a no-op once the operation is completed", async () => {
    const log = recorder();
    const storage = createOperationStorage();
    const definition: OperationDefinition<Ctx> = {
      kind: "ticket_flow",
      steps: [tracked("issue", () => ({ status: "succeeded" }), log)]
    };

    progress(await runOperation(definition, options(storage)));
    const again = progress(await runOperation(definition, options(storage, 1)));

    expect(again.state).toBe("completed");
    expect(log.calls).toEqual(["issue"]);
  });

  it("leaves an abandoned operation alone", async () => {
    const log = recorder();
    const storage = createOperationStorage();
    const definition: OperationDefinition<Ctx> = {
      kind: "ticket_flow",
      steps: [
        tracked("issue", () => ({ status: "succeeded" }), log),
        tracked("submit", () => ({ status: "interrupted", errorCode: "network" }), log)
      ]
    };

    await runOperation(definition, options(storage));
    const abandoned = abandonOperation("op-1", {
      storage,
      actor: "maintainer:ana",
      reason: "duplicate request"
    });
    expect(abandoned.ok).toBe(true);
    if (abandoned.ok) expect(abandoned.value.state).toBe("abandoned");

    const again = progress(await runOperation(definition, options(storage, 1)));
    expect(again.state).toBe("abandoned");
    expect(log.calls).toEqual(["issue", "submit"]);
  });

  it("rejects definitions that cannot be replayed deterministically", async () => {
    const storage = createOperationStorage();
    const noSteps = await runOperation({ kind: "ticket_flow", steps: [] }, options(storage));
    expect(noSteps.ok).toBe(false);
    if (!noSteps.ok) expect(noSteps.code).toBe("invalid_operation");

    const duplicated = await runOperation(
      {
        kind: "ticket_flow",
        steps: [
          { id: "submit", run: () => ({ status: "succeeded" }) },
          { id: "submit", run: () => ({ status: "succeeded" }) }
        ]
      },
      options(storage)
    );
    expect(duplicated.ok).toBe(false);
    if (!duplicated.ok) expect(duplicated.code).toBe("invalid_operation");

    const seeded = createOperationStorage();
    await runOperation(
      { kind: "ticket_flow", steps: [{ id: "submit", run: () => ({ status: "succeeded" }) }] },
      options(seeded)
    );
    const mismatchedKind = await runOperation(
      { kind: "other_flow", steps: [{ id: "submit", run: () => ({ status: "succeeded" }) }] },
      options(seeded)
    );
    expect(mismatchedKind.ok).toBe(false);
    if (!mismatchedKind.ok) expect(mismatchedKind.code).toBe("invalid_operation");
  });

  it("reports a storage failure instead of pretending the step ran", async () => {
    const failing: OperationStorage = {
      read: () => undefined,
      write: () => {
        throw new Error("quota exceeded");
      },
      remove: () => undefined,
      list: () => []
    };
    const result = await runOperation(
      { kind: "ticket_flow", steps: [{ id: "issue", run: () => ({ status: "succeeded" }) }] },
      options(failing)
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("storage_error");
  });
});

describe("authorized recovery decisions", () => {
  it("fails closed without changing the checkpoint", async () => {
    const storage = createOperationStorage();
    const definition: OperationDefinition<Ctx> = {
      kind: "ticket_flow",
      steps: [{ id: "submit", run: () => ({ status: "interrupted", errorCode: "timeout", committed: true }) }]
    };
    await runOperation(definition, options(storage));
    const before = storage.read("op-1");

    expect(resolveInterruptedStepAuthorized(
      { role: "viewer", userId: "eve" }, "op-1", "submit", "applied", { storage }
    )).toEqual({ ok: false, code: "permission_denied" });
    expect(abandonOperationAuthorized({ role: "service" }, "op-1", { storage })).toEqual({
      ok: false,
      code: "permission_denied"
    });
    expect(storage.read("op-1")).toEqual(before);
  });

  it("allows a maintainer to resolve and resume", async () => {
    const storage = createOperationStorage();
    const definition: OperationDefinition<Ctx> = {
      kind: "ticket_flow",
      steps: [{ id: "submit", run: () => ({ status: "interrupted", errorCode: "timeout", committed: true }) }]
    };
    await runOperation(definition, options(storage));

    const resolved = resolveInterruptedStepAuthorized(
      { role: "maintainer", userId: "ada" }, "op-1", "submit", "applied", { storage }
    );
    expect(resolved.ok && resolved.value.steps[0].status).toBe("succeeded");
    expect(progress(await runOperation(definition, options(storage, 1))).state).toBe("completed");
  });
});

describe("resolveInterruptedStep", () => {
  it('marks a confirmed effect as applied and lets the flow continue', async () => {
    const log = recorder();
    const storage = createOperationStorage();
    const definition: OperationDefinition<Ctx> = {
      kind: "ticket_flow",
      steps: [
        tracked("issue", () => ({ status: "succeeded" }), log),
        tracked(
          "submit",
          () => ({ status: "interrupted", errorCode: "confirmation_timeout", committed: true }),
          log
        ),
        tracked("confirm", () => ({ status: "succeeded" }), log)
      ]
    };

    await runOperation(definition, options(storage));
    const resolved = resolveInterruptedStep("op-1", "submit", "applied", {
      storage,
      actor: "maintainer:ana",
      now: clock(1_700_000_500_000)
    });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.value.state).toBe("running");
      expect(statusOf(resolved.value, "submit")).toBe("succeeded");
    }

    const finished = progress(await runOperation(definition, options(storage, 2)));
    expect(finished.state).toBe("completed");
    expect(log.calls).toEqual(["issue", "submit", "confirm"]);
  });

  it("re-opens a step that did not land, so it is retried with the same key", async () => {
    const log = recorder();
    const storage = createOperationStorage();
    const definition: OperationDefinition<Ctx> = {
      kind: "ticket_flow",
      steps: [
        tracked(
          "submit",
          () => ({ status: "interrupted", errorCode: "confirmation_timeout", committed: true }),
          log
        )
      ]
    };

    await runOperation(definition, options(storage));
    const resolved = resolveInterruptedStep("op-1", "submit", "not_applied", {
      storage,
      actor: "maintainer:ana",
      now: clock(1_700_000_500_000)
    });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(statusOf(resolved.value, "submit")).toBe("pending");
      expect(checkpointOf(resolved.value, "submit")?.sideEffectCommitted).toBe(false);
    }

    // Stub the step so the retry succeeds; the record is what is under test.
    const retry: OperationDefinition<Ctx> = {
      kind: "ticket_flow",
      steps: [tracked("submit", () => ({ status: "succeeded" }), log)]
    };
    const finished = progress(await runOperation(retry, options(storage, 2)));
    expect(finished.state).toBe("completed");
    expect(log.keys[0]).toBe(log.keys[1]);
    expect(log.attempts).toEqual([1, 2]);
  });

  it("refuses to resolve an unknown operation, an unknown step, or a finished one", async () => {
    const empty = createOperationStorage();
    const unknown = resolveInterruptedStep("nope", "issue", "applied", { storage: empty });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.code).toBe("unknown_operation");

    const finished = createOperationStorage();
    await runOperation(
      { kind: "ticket_flow", steps: [{ id: "issue", run: () => ({ status: "succeeded" }) }] },
      options(finished)
    );
    const terminal = resolveInterruptedStep("op-1", "issue", "applied", { storage: finished });
    expect(terminal.ok).toBe(false);
    if (!terminal.ok) expect(terminal.code).toBe("terminal_operation");

    const stalled = createOperationStorage();
    await runOperation(
      {
        kind: "ticket_flow",
        steps: [
          { id: "issue", run: () => ({ status: "succeeded" }) },
          { id: "submit", run: () => ({ status: "interrupted", errorCode: "network" }) }
        ]
      },
      options(stalled)
    );
    const missingStep = resolveInterruptedStep("op-1", "ghost", "applied", { storage: stalled });
    expect(missingStep.ok).toBe(false);
    if (!missingStep.ok) expect(missingStep.code).toBe("unknown_step");
  });
});

describe("decideStep", () => {
  const base: StepCheckpoint = {
    id: "submit",
    status: "pending",
    attempt: 0,
    idempotencyKey: "operation:op-1:step:submit",
    sideEffectCommitted: false,
    updatedAt: "2026-01-01T00:00:00.000Z"
  };

  it("skips finished steps, confirms submitted ones, and runs the rest", () => {
    expect(decideStep({ ...base, status: "succeeded" })).toBe("skip");
    expect(decideStep({ ...base, status: "skipped" })).toBe("skip");
    expect(decideStep({ ...base, status: "interrupted", sideEffectCommitted: true })).toBe("confirm");
    expect(decideStep({ ...base, status: "running" })).toBe("run");
    expect(decideStep({ ...base, status: "failed" })).toBe("run");
    expect(decideStep({ ...base, status: "interrupted" })).toBe("run");
  });

  it("keeps the operation machine's terminal states closed and `failed` retryable", () => {
    expect(operationMachine.isTerminal("completed")).toBe(true);
    expect(operationMachine.isTerminal("abandoned")).toBe(true);
    expect(operationMachine.isTerminal("failed")).toBe(false);
    expect(operationMachine.resolve("failed", "retry").ok).toBe(true);
    expect(operationMachine.resolve("completed", "retry").ok).toBe(false);
    expect(operationMachine.resolve("pending", "complete").ok).toBe(false);
  });
});

describe("nextActionFor", () => {
  it("reports nothing to do for a finished operation and a retry step otherwise", async () => {
    const storage = createOperationStorage();
    const definition: OperationDefinition<Ctx> = {
      kind: "ticket_flow",
      steps: [{ id: "issue", run: () => ({ status: "interrupted", errorCode: "network" }) }]
    };

    const stalled = progress(await runOperation(definition, options(storage)));
    const action = nextActionFor(stalled.record);
    expect(action?.code).toBe("retry_step");
    expect(action?.idempotencyKey).toBe(defaultIdempotencyKey("op-1", "issue"));

    const done = progress(
      await runOperation(
        { kind: "ticket_flow", steps: [{ id: "issue", run: () => ({ status: "succeeded" }) }] },
        options(storage, 5)
      )
    );
    expect(nextActionFor(done.record)).toBeNull();
  });
});
