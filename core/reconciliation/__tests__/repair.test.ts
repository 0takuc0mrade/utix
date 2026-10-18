import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAuditTrail } from "@/core/audit/audit";
import type { AuthContext } from "@/core/auth/middleware";
import { reconcile, type ReconciliationInput } from "@/core/reconciliation/reconciliation";
import {
  applyRepairPlan,
  createRepairWorkflow,
  formatRepairPlan,
  planRepairs,
  REPAIR_STRATEGIES,
  RECONCILIATION_INVARIANTS,
  rollbackRepair,
  type RepairAction,
  type RepairHandlers,
  type RepairPlan
} from "@/core/reconciliation";
import type { JobPayload } from "@/core/workers/queue";
import { setTelemetrySink, type TelemetryEvent } from "@/core/telemetry/telemetry";

const NOW = 1_770_000_000_000;
const MAINTAINER: AuthContext = { role: "maintainer", userId: "ada" };

function job(overrides: Partial<JobPayload> = {}): JobPayload {
  return {
    id: "job-1",
    operation: "demo.run",
    params: {},
    maxAttempts: 3,
    attempts: 0,
    status: "queued",
    enqueuedAt: new Date(NOW).toISOString(),
    correlationId: "corr-1",
    ...overrides
  };
}

function snapshot(overrides: Partial<ReconciliationInput> = {}): ReconciliationInput {
  return {
    storedBalances: [],
    ledgerBalances: [],
    jobs: [],
    notifications: [],
    idempotencyRecords: [],
    exportEnvelopes: [],
    operations: [],
    now: NOW,
    ...overrides
  };
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] extends readonly (infer U)[] ? U[] : T[K] };

/**
 * An in-memory source of truth plus projections. `read()` hands out a copy, so
 * the engine never sees the live arrays; handlers are the only writers.
 */
function createStore(initial: ReconciliationInput) {
  const state = structuredClone(initial) as Mutable<ReconciliationInput>;
  const writes: string[] = [];
  const read = vi.fn(() => structuredClone(state) as ReconciliationInput);

  const byKey = (target: Readonly<Record<string, string>>) => (line: { account: string; asset: string }) =>
    line.account === target.account && line.asset === target.asset;

  const handlers: RepairHandlers = {
    recache_balance: {
      apply: (action) => {
        writes.push(action.id);
        const line = state.storedBalances.find(byKey(action.target))!;
        Object.assign(line, { balance: action.after.balance, cachedAt: action.after.cachedAt });
      },
      revert: (action) => {
        writes.push(`revert:${action.id}`);
        const line = state.storedBalances.find(byKey(action.target))!;
        Object.assign(line, { balance: action.before.balance, cachedAt: action.before.cachedAt ?? undefined });
      }
    },
    drop_balance_line: {
      apply: (action) => {
        writes.push(action.id);
        state.storedBalances = state.storedBalances.filter((line) => !byKey(action.target)(line));
      },
      revert: (action) => {
        writes.push(`revert:${action.id}`);
        state.storedBalances.push({
          account: action.target.account,
          asset: action.target.asset,
          balance: String(action.before.balance)
        });
      }
    },
    requeue_job: {
      apply: (action) => {
        writes.push(action.id);
        const entry = state.jobs.find((item) => item.id === action.target.jobId)!;
        entry.status = "queued";
        entry.nextAttemptAt = String(action.after.nextAttemptAt);
      },
      revert: (action) => {
        writes.push(`revert:${action.id}`);
        const entry = state.jobs.find((item) => item.id === action.target.jobId)!;
        entry.status = action.before.status as JobPayload["status"];
        entry.nextAttemptAt = action.before.nextAttemptAt === null ? undefined : String(action.before.nextAttemptAt);
      }
    },
    dead_letter_job: {
      apply: (action) => {
        writes.push(action.id);
        state.jobs.find((item) => item.id === action.target.jobId)!.status = "dead_lettered";
      }
    }
  };

  return { state, read, handlers, writes };
}

function drifted(): ReconciliationInput {
  return snapshot({
    storedBalances: [
      { account: "G1", asset: "USDC", balance: "10.50", cachedAt: new Date(NOW - 3_600_000).toISOString() },
      { account: "G1", asset: "EURC", balance: "4" },
      { account: "G2", asset: "XLM", balance: "100" }
    ],
    ledgerBalances: [
      { account: "G1", asset: "USDC", balance: "10.51", reference: "ledger:100" },
      { account: "G1", asset: "XLM", balance: "2", reference: "ledger:100" },
      { account: "G2", asset: "XLM", balance: "100", reference: "ledger:100" }
    ],
    jobs: [
      job({ id: "job-moving" }),
      job({
        id: "job-stuck",
        status: "retrying",
        attempts: 1,
        nextAttemptAt: new Date(NOW - 3_600_000).toISOString()
      }),
      job({
        id: "job-exhausted",
        status: "retrying",
        attempts: 3,
        lastError: { code: "horizon_timeout", message: "timeout" }
      })
    ],
    staleAfterMs: 60_000
  });
}

describe("reconciliation repair plan", () => {
  beforeEach(() => {
    setTelemetrySink({ emit: () => undefined });
    getAuditTrail().reset();
  });

  it("declares a strategy for every invariant", () => {
    expect(Object.keys(REPAIR_STRATEGIES).sort()).toEqual(RECONCILIATION_INVARIANTS.map((entry) => entry.id).sort());
  });

  it("never writes during planning", () => {
    const input = Object.freeze(drifted());
    const before = JSON.stringify(input);
    const plan = planRepairs(reconcile(input), input);

    expect(JSON.stringify(input)).toBe(before);
    expect(plan.dryRun).toBe(true);
    expect(plan.summary.actions).toBeGreaterThan(0);
  });

  it("describes each write with before, after and reversibility", () => {
    const input = drifted();
    const plan = planRepairs(reconcile(input), input);
    const byKind = Object.fromEntries(plan.actions.map((entry) => [entry.kind, entry]));

    expect(byKind.recache_balance).toMatchObject({
      target: { account: "G1", asset: "USDC" },
      before: { balance: "10.50" },
      after: { balance: "10.51", reference: "ledger:100" },
      reversible: true
    });
    // EURC is absent while the ledger reports another G1 asset: trustline removed.
    expect(byKind.drop_balance_line).toMatchObject({ target: { account: "G1", asset: "EURC" }, reversible: true });
    expect(byKind.requeue_job).toMatchObject({ target: { jobId: "job-stuck" }, lifecycleEvent: "retry" });
    expect(byKind.dead_letter_job).toMatchObject({ target: { jobId: "job-exhausted" }, reversible: false });
    expect(plan.summary).toMatchObject({ actions: 4, reversible: 3, irreversible: 1 });
  });

  it("does not requeue a job it is also dead-lettering", () => {
    const input = snapshot({
      jobs: [
        job({ id: "job-a" }),
        job({ id: "job-x", status: "retrying", attempts: 3, nextAttemptAt: new Date(NOW - 3_600_000).toISOString() })
      ],
      staleAfterMs: 60_000
    });
    const plan = planRepairs(reconcile(input), input);
    expect(plan.actions.map((entry) => entry.kind)).toEqual(["dead_letter_job"]);
    expect(plan.manual.map((entry) => entry.reason).join(" ")).toContain("also being dead-lettered");
  });

  it("refuses to drop balances when the ledger read came back empty", () => {
    const input = snapshot({ storedBalances: [{ account: "G1", asset: "USDC", balance: "1" }] });
    const plan = planRepairs(reconcile(input), input);
    expect(plan.actions).toHaveLength(0);
    expect(plan.manual[0]).toMatchObject({ invariant: "balance.ledger_entry_present" });
    expect(plan.manual[0].reason).toContain("ledger_read_empty");
  });

  it("refuses to requeue jobs one by one when the scheduler is stalled", () => {
    const old = new Date(NOW - 3_600_000).toISOString();
    const input = snapshot({
      jobs: [job({ id: "job-a", enqueuedAt: old }), job({ id: "job-b", enqueuedAt: old })],
      staleAfterMs: 60_000
    });
    const plan = planRepairs(reconcile(input), input);
    expect(plan.actions).toHaveLength(0);
    expect(plan.manual).toHaveLength(2);
    expect(plan.manual[0].reason).toContain("restart the scheduler");
  });

  it("cancels every duplicate but the oldest pending job once", () => {
    const input = snapshot({
      jobs: [
        job({ id: "job-new", dedupeKey: "daily", enqueuedAt: new Date(NOW - 1_000).toISOString() }),
        job({ id: "job-old", dedupeKey: "daily", enqueuedAt: new Date(NOW - 2_000).toISOString() }),
        job({ id: "job-newest", dedupeKey: "daily", enqueuedAt: new Date(NOW).toISOString() })
      ]
    });
    const plan = planRepairs(reconcile(input), input);
    expect(plan.actions.map((entry) => entry.target.jobId).sort()).toEqual(["job-new", "job-newest"]);
    expect(plan.actions.every((entry) => entry.target.keepJobId === "job-old")).toBe(true);
  });

  it("routes invariants without a safe repair to manual follow-up", () => {
    const input = snapshot({
      jobs: [job({ id: "job-legacy", status: "pending" as JobPayload["status"] })],
      operations: [
        { id: "op-1", op: "horizon.request", state: "started", startedAt: new Date(NOW - 600_000).toISOString(), correlationId: "c" }
      ],
      staleAfterMs: 60_000
    });
    const plan = planRepairs(reconcile(input), input);
    expect(plan.actions).toHaveLength(0);
    expect(plan.manual.map((entry) => entry.invariant).sort()).toEqual(["operation.settles", "worker_job.state_declared"]);
  });

  it("never plans a write against a redacted identity", () => {
    const secret = `S${"A".repeat(55)}`;
    const input = snapshot({
      storedBalances: [{ account: secret, asset: "USDC", balance: "1" }],
      ledgerBalances: [{ account: secret, asset: "USDC", balance: "2", reference: "l" }]
    });
    const plan = planRepairs(reconcile(input), input);
    expect(plan.actions).toHaveLength(0);
    expect(plan.manual[0].reason).toContain("security incident");
    expect(JSON.stringify(plan)).not.toContain(secret);
  });

  it("renders a reviewable plan", () => {
    const input = drifted();
    const text = formatRepairPlan(planRepairs(reconcile(input), input));
    expect(text).toContain("dry run");
    expect(text).toContain("recache_balance:G1|USDC");
    expect(text).toContain("(irreversible)");
    expect(text).toContain("rollback:");
    expect(formatRepairPlan(planRepairs(reconcile(snapshot()), snapshot()))).toContain("nothing to repair");
  });
});

describe("reconciliation repair apply", () => {
  let events: TelemetryEvent[];

  beforeEach(() => {
    events = [];
    setTelemetrySink({ emit: (event) => events.push(event) });
    getAuditTrail().reset();
  });

  function prepared() {
    const store = createStore(drifted());
    const workflow = createRepairWorkflow({ read: store.read, handlers: store.handlers, now: () => NOW });
    const dry = workflow.dryRun();
    if (!dry.ok) throw new Error("dry run failed");
    return { store, workflow, plan: dry.value.plan, report: dry.value.report };
  }

  it("applies reversible actions, skips irreversible ones by default, and verifies the fix", () => {
    const { store, workflow, plan } = prepared();
    const result = workflow.apply(plan, { auth: MAINTAINER, confirm: plan.planId });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.applied.sort()).toEqual([
      "drop_balance_line:G1|EURC",
      "recache_balance:G1|USDC",
      "requeue_job:job-stuck"
    ]);
    expect(result.value.skipped).toEqual([
      { id: "dead_letter_job:job-exhausted", reason: expect.stringContaining("irreversible") }
    ]);
    expect(result.value.verificationRan).toBe(true);
    expect(result.value.stillDrifting).toEqual([]);
    expect(result.value.verified).toContain("balance.amount_agrees:G1|USDC");
    expect(store.state.storedBalances.find((line) => line.asset === "USDC")?.balance).toBe("10.51");

    // A fresh dry run now only sees what was deliberately left alone.
    const after = reconcile(store.read());
    expect(after.findings.map((entry) => entry.invariant)).toEqual(["worker_job.budget_consistent"]);

    const audit = getAuditTrail().all().filter((event) => event.action === "reconciliation.repaired");
    expect(audit).toHaveLength(3);
    expect(audit.every((event) => event.outcome === "allowed" && event.correlationId === result.value.correlationId)).toBe(true);
    expect(events.find((event) => event.op === "reconciliation.repair")).toMatchObject({ result: "success" });
  });

  it("applies irreversible actions only when explicitly allowed", () => {
    const { store, workflow, plan } = prepared();
    const result = workflow.apply(plan, {
      auth: MAINTAINER,
      confirm: plan.planId,
      only: ["dead_letter_job:job-exhausted"],
      allowIrreversible: true
    });
    expect(result.ok && result.value.applied).toEqual(["dead_letter_job:job-exhausted"]);
    expect(store.state.jobs.find((entry) => entry.id === "job-exhausted")?.status).toBe("dead_lettered");
  });

  it("requires the maintainer permission and the plan id as confirmation", () => {
    const { store, workflow, plan } = prepared();
    expect(workflow.apply(plan, { auth: { role: "viewer", userId: "u" }, confirm: plan.planId })).toMatchObject({
      ok: false,
      code: "repair_denied"
    });
    expect(workflow.apply(plan, { auth: MAINTAINER, confirm: "yes" })).toMatchObject({
      ok: false,
      code: "confirmation_required"
    });
    // An unknown role fails closed rather than throwing.
    expect(
      workflow.apply(plan, { auth: { role: "root" } as unknown as AuthContext, confirm: plan.planId })
    ).toMatchObject({ ok: false, code: "repair_denied" });
    expect(store.writes).toEqual([]);

    const refused = getAuditTrail().all().filter((event) => event.action === "reconciliation.repaired");
    expect(refused).toHaveLength(3);
    expect(refused.map((event) => event.errorCode)).toEqual(["repair_denied", "confirmation_required", "repair_denied"]);
  });

  it("refuses an edited plan", () => {
    const { store, workflow, plan } = prepared();
    const edited: RepairPlan = {
      ...plan,
      actions: plan.actions.map((entry) =>
        entry.kind === "recache_balance" ? { ...entry, after: { ...entry.after, balance: "999" } } : entry
      )
    };
    expect(workflow.apply(edited, { auth: MAINTAINER, confirm: plan.planId })).toMatchObject({
      ok: false,
      code: "plan_tampered"
    });
    expect(store.writes).toEqual([]);
  });

  it("refuses an expired plan", () => {
    const store = createStore(drifted());
    const input = store.read();
    const plan = planRepairs(reconcile(input), input, { now: NOW, ttlMs: 1_000 });
    const result = applyRepairPlan(plan, {
      read: store.read,
      handlers: store.handlers,
      auth: MAINTAINER,
      confirm: plan.planId,
      now: () => NOW + 2_000
    });
    expect(result).toMatchObject({ ok: false, code: "plan_expired" });
  });

  it("refuses a stale plan when the source moved after the dry run", () => {
    const { store, workflow, plan } = prepared();
    // Someone re-cached the USDC line between the dry run and the apply.
    store.state.storedBalances[0].balance = "10.49";

    const result = workflow.apply(plan, { auth: MAINTAINER, confirm: plan.planId });
    expect(result).toMatchObject({ ok: false, code: "plan_stale" });
    if (!result.ok) expect(result.detail?.stale).toEqual(["recache_balance:G1|USDC"]);
    expect(store.writes).toEqual([]);
  });

  it("refuses a stale plan when the ledger moved after the dry run", () => {
    const { store, workflow, plan } = prepared();
    // The record is untouched, but the source of truth closed a new ledger.
    store.state.ledgerBalances[0] = { ...store.state.ledgerBalances[0], balance: "10.52", reference: "ledger:101" };

    const result = workflow.apply(plan, { auth: MAINTAINER, confirm: plan.planId });
    expect(result).toMatchObject({ ok: false, code: "plan_stale" });
    if (!result.ok) expect(result.detail?.stale).toEqual(["recache_balance:G1|USDC"]);
    expect(store.writes).toEqual([]);
  });

  it("accepts a re-plan that differs only in clock-stamped fields", () => {
    const store = createStore(drifted());
    const input = store.read();
    const plan = planRepairs(reconcile(input), input, { now: NOW });
    const result = applyRepairPlan(plan, {
      // The source is read later, so recache and requeue stamp a later time.
      read: () => ({ ...store.read(), now: NOW + 30_000 }),
      handlers: store.handlers,
      auth: MAINTAINER,
      confirm: plan.planId,
      now: () => NOW + 30_000
    });
    expect(result.ok).toBe(true);
  });

  it("refuses a stale plan when the drift was already fixed", () => {
    const { store, workflow, plan } = prepared();
    store.state.storedBalances[0].balance = "10.51";
    expect(workflow.apply(plan, { auth: MAINTAINER, confirm: plan.planId })).toMatchObject({
      ok: false,
      code: "plan_stale"
    });
  });

  it("refuses before any write when a handler is missing", () => {
    const store = createStore(drifted());
    const workflow = createRepairWorkflow({
      read: store.read,
      handlers: { recache_balance: store.handlers.recache_balance },
      now: () => NOW
    });
    const dry = workflow.dryRun();
    if (!dry.ok) throw new Error("dry run failed");
    const result = workflow.apply(dry.value.plan, { auth: MAINTAINER, confirm: dry.value.plan.planId });
    expect(result).toMatchObject({ ok: false, code: "handler_missing" });
    expect(store.writes).toEqual([]);
  });

  it("refuses more actions than the blast-radius cap", () => {
    const { workflow, plan } = prepared();
    expect(workflow.apply(plan, { auth: MAINTAINER, confirm: plan.planId, maxActions: 1 })).toMatchObject({
      ok: false,
      code: "blast_radius_exceeded"
    });
  });

  it("refuses when the source of truth cannot be re-read", () => {
    const { store, plan } = prepared();
    const result = applyRepairPlan(plan, {
      read: () => {
        throw new Error("horizon down");
      },
      handlers: store.handlers,
      auth: MAINTAINER,
      confirm: plan.planId,
      now: () => NOW
    });
    expect(result).toMatchObject({ ok: false, code: "snapshot_unavailable" });
    expect(store.writes).toEqual([]);
  });

  it("rolls back every applied action when a handler fails mid-run", () => {
    const { store, plan } = prepared();
    const original = structuredClone(store.state);
    const handlers: RepairHandlers = {
      ...store.handlers,
      requeue_job: {
        apply: () => {
          throw new Error("queue unavailable");
        },
        revert: () => undefined
      }
    };

    const result = applyRepairPlan(plan, { read: store.read, handlers, auth: MAINTAINER, confirm: plan.planId, now: () => NOW });
    expect(result).toMatchObject({ ok: false, code: "repair_failed" });
    if (result.ok) return;
    expect(result.detail?.failedAction).toBe("requeue_job:job-stuck");
    expect(result.detail?.rolledBack?.sort()).toEqual(["drop_balance_line:G1|EURC", "recache_balance:G1|USDC"]);
    expect(result.detail?.rollbackFailed).toEqual([]);
    // Reverted in reverse order, and the balances are back where they were.
    expect(store.writes.filter((entry) => entry.startsWith("revert:"))).toEqual([
      "revert:recache_balance:G1|USDC",
      "revert:drop_balance_line:G1|EURC"
    ]);
    expect(store.state.storedBalances.map((line) => [line.asset, line.balance]).sort()).toEqual(
      original.storedBalances.map((line) => [line.asset, line.balance]).sort()
    );
  });

  it("rolls back a completed repair from its journal", () => {
    const { store, workflow, plan } = prepared();
    const applied = workflow.apply(plan, { auth: MAINTAINER, confirm: plan.planId });
    if (!applied.ok) throw new Error("apply failed");

    const undone = workflow.rollback(applied.value, MAINTAINER);
    expect(undone.ok).toBe(true);
    // The drift is back, which is the point: rollback restores the projection.
    expect(reconcile(store.read()).findings.map((entry) => entry.id)).toEqual(
      expect.arrayContaining(["balance.amount_agrees:G1|USDC", "worker_job.progress:job-stuck"])
    );
    expect(rollbackRepair(applied.value, { handlers: store.handlers, auth: { role: "viewer" } })).toEqual({
      ok: false,
      code: "repair_denied"
    });
  });

  it("reports drift that survives a repair instead of claiming success", () => {
    const { store, plan } = prepared();
    const handlers: RepairHandlers = {
      ...store.handlers,
      // A handler that "succeeds" without writing, e.g. a cache that ignores the write.
      recache_balance: { apply: () => undefined, revert: () => undefined }
    };
    const result = applyRepairPlan(plan, { read: store.read, handlers, auth: MAINTAINER, confirm: plan.planId, now: () => NOW });
    expect(result.ok && result.value.stillDrifting).toEqual(["balance.amount_agrees:G1|USDC"]);
    expect(events.find((event) => event.op === "reconciliation.repair")).toMatchObject({
      result: "failure",
      errorCode: "drift_remains"
    });
  });

  it("reads the source once for the dry run and twice for the apply", () => {
    const { store, workflow, plan } = prepared();
    expect(store.read).toHaveBeenCalledTimes(1);
    workflow.apply(plan, { auth: MAINTAINER, confirm: plan.planId });
    // Once to re-check the plan, once to verify the result.
    expect(store.read).toHaveBeenCalledTimes(3);
  });

  it("applies only the selected actions", () => {
    const { store, workflow, plan } = prepared();
    const only = [plan.actions.find((entry: RepairAction) => entry.kind === "recache_balance")!.id, "missing:id"];
    const result = workflow.apply(plan, { auth: MAINTAINER, confirm: plan.planId, only });
    expect(result.ok && result.value.applied).toEqual(["recache_balance:G1|USDC"]);
    expect(result.ok && result.value.skipped).toEqual([{ id: "missing:id", reason: "not in the plan" }]);
    expect(store.writes).toEqual(["recache_balance:G1|USDC"]);
  });
});
