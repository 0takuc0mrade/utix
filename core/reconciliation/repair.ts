/**
 * Dry-run-first repair for reconciliation drift.
 *
 * The engine (`reconciliation.ts`) only reports. This module turns a report
 * into a repair **plan** and, separately and only on explicit request,
 * **applies** it. The two steps are deliberately split:
 *
 * 1. `planRepairs(report, snapshot)` is pure. It describes every write it would
 *    make — target, before, after, whether it can be undone — and lists the
 *    findings it refuses to touch, with the reason. Nothing is written, so a
 *    plan is safe to produce in CI, in a PR comment, or on every scheduled run.
 * 2. `applyRepairPlan(plan, deps)` executes an approved plan. It refuses unless
 *    the caller holds `admin:recovery`, echoes the plan id back as
 *    confirmation, and the plan is unexpired and untampered. It then re-reads
 *    the source of truth, re-plans, and refuses with `plan_stale` if any
 *    approved action no longer matches what the dry run saw — so an apply can
 *    never act on drift that has since moved.
 *
 * The module itself owns no storage. Writes go through injected
 * `RepairHandlers`, one per action kind, each with an `apply` and (for a
 * reversible action) a `revert`. A handler that throws stops the run and every
 * already-applied action is reverted in reverse order. After a successful run
 * the source is read a third time and each repaired finding is checked to be
 * gone, so "applied" and "fixed" are reported separately.
 *
 * The ledger is never written. Every action repairs a cached or derived record
 * toward the source of truth, never the other way round.
 */

import { recordAudit, type AuditActor } from "@/core/audit/audit";
import type { AuthContext } from "@/core/auth/middleware";
import { hasPermission, type Permission } from "@/core/auth/types";
import { canonicalJson } from "@/core/ledger/ledger";
import { sha256Hex } from "@/core/ledger/sha256";
import {
  reconcile,
  type ReconciliationFinding,
  type ReconciliationInput,
  type ReconciliationReport,
  type StoredBalance
} from "@/core/reconciliation/reconciliation";
import { err, ok, type Result } from "@/core/result/result";
import { emitTelemetry, newCorrelationId } from "@/core/telemetry/telemetry";
import type { JobPayload } from "@/core/workers/queue";

/** Repairing rewrites stored records, so it is a maintainer-only operation. */
export const REPAIR_PERMISSION: Permission = "admin:recovery";

/** A plan older than this must be regenerated; the state it saw has aged. */
export const REPAIR_PLAN_TTL_MS = 15 * 60_000;

/** Upper bound on actions one apply may execute. Larger drift is an incident. */
export const REPAIR_DEFAULT_MAX_ACTIONS = 50;

export type RepairActionKind =
  | "recache_balance"
  | "drop_balance_line"
  | "dedupe_balance_lines"
  | "dead_letter_job"
  | "cancel_duplicate_job"
  | "requeue_job"
  | "sweep_idempotency"
  | "purge_envelope"
  | "drop_notification"
  | "collapse_notification";

/**
 * How each invariant is repaired. `manual` means a human must act, because the
 * correct repair needs information the snapshot does not hold. Every declared
 * invariant must appear here; `npm run verify:reconciliation` enforces it.
 */
export const REPAIR_STRATEGIES: Readonly<Record<string, RepairActionKind | "manual">> = {
  "balance.ledger_entry_present": "drop_balance_line",
  "balance.amount_agrees": "recache_balance",
  "balance.single_line_per_asset": "dedupe_balance_lines",
  "worker_job.state_declared": "manual",
  "worker_job.budget_consistent": "dead_letter_job",
  "worker_job.dedupe_unique": "cancel_duplicate_job",
  "worker_job.progress": "requeue_job",
  "idempotency.claim_fresh": "sweep_idempotency",
  "export_envelope.count_matches": "manual",
  "export_envelope.retention": "purge_envelope",
  "notification.state_declared": "drop_notification",
  "notification.identity_unique": "collapse_notification",
  "operation.settles": "manual"
};

export type RepairValue = string | number | null;

export interface RepairAction {
  /** Stable across plans of the same state: `${kind}:${target}`. */
  readonly id: string;
  readonly kind: RepairActionKind;
  /** The findings this action resolves. */
  readonly findingIds: readonly string[];
  readonly invariant: string;
  readonly subject: string;
  /** Raw identity a handler needs to locate the record. */
  readonly target: Readonly<Record<string, string>>;
  /** The record as the dry run saw it. Re-checked before any write. */
  readonly before: Readonly<Record<string, RepairValue>>;
  /** The record as it will be after the action. */
  readonly after: Readonly<Record<string, RepairValue>>;
  /** Lifecycle event the handler should apply, when the move is a transition. */
  readonly lifecycleEvent?: string;
  readonly reversible: boolean;
  readonly risk: "low" | "medium" | "high";
  /** How to undo it by hand if the automatic revert is not available. */
  readonly rollback: string;
}

export interface ManualFollowUp {
  readonly findingId: string;
  readonly invariant: string;
  /** Why this finding was not planned for automatic repair. */
  readonly reason: string;
  readonly repair: string;
}

export interface RepairPlan {
  readonly planId: string;
  /** The dry-run report the plan was derived from. */
  readonly runId: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  /** A plan never writes; only `applyRepairPlan` does. */
  readonly dryRun: true;
  readonly actions: readonly RepairAction[];
  readonly manual: readonly ManualFollowUp[];
  /** Digest of the actions; an edited plan is refused. */
  readonly fingerprint: string;
  readonly summary: {
    readonly actions: number;
    readonly reversible: number;
    readonly irreversible: number;
    readonly manual: number;
  };
}

export interface PlanOptions {
  /** Injected clock for `createdAt` and expiry. Defaults to the snapshot's `now`. */
  now?: number;
  ttlMs?: number;
  planId?: string;
}

// --- planning --------------------------------------------------------------

function balanceKey(entry: { account: string; asset: string }): string {
  return `${entry.account}|${entry.asset}`;
}

function newest(lines: readonly StoredBalance[]): StoredBalance {
  // Lines without cachedAt sort oldest; a tie keeps the first line seen.
  return lines.reduce((best, line) => {
    const at = line.cachedAt ? Date.parse(line.cachedAt) : Number.NEGATIVE_INFINITY;
    const bestAt = best.cachedAt ? Date.parse(best.cachedAt) : Number.NEGATIVE_INFINITY;
    return at > bestAt ? line : best;
  });
}

function oldestJob(jobs: readonly JobPayload[]): JobPayload {
  return jobs.reduce((best, job) => (Date.parse(job.enqueuedAt) < Date.parse(best.enqueuedAt) ? job : best));
}

interface PlanContext {
  readonly input: ReconciliationInput;
  readonly report: ReconciliationReport;
  /** Job ids that some other finding will already move to a terminal state. */
  readonly terminalJobs: ReadonlySet<string>;
}

type Planned = { actions: RepairAction[] } | { manual: string };

type Strategy = (finding: ReconciliationFinding, context: PlanContext) => Planned;

const manual = (reason: string): Planned => ({ manual: reason });

function action(fields: Omit<RepairAction, "id"> & { idTarget: string }): RepairAction {
  const { idTarget, ...rest } = fields;
  return { id: `${fields.kind}:${idTarget}`, ...rest };
}

const strategies: Record<RepairActionKind, Strategy> = {
  drop_balance_line: (finding, { input }) => {
    // Dropping a line on the evidence of an *absent* ledger entry is only safe
    // when the ledger was demonstrably read for this account.
    if (finding.rootCause?.code !== "trustline_removed") {
      return manual(
        `refusing to drop a cached balance without proof the ledger was read for the account (cause: ${finding.rootCause?.code ?? "unknown"})`
      );
    }
    const line = input.storedBalances.find((entry) => balanceKey(entry) === finding.recordId);
    if (!line) return manual("the stored line could not be located in the snapshot");
    return {
      actions: [
        action({
          kind: "drop_balance_line",
          idTarget: balanceKey(line),
          findingIds: [finding.id],
          invariant: finding.invariant,
          subject: finding.subject,
          target: { account: line.account, asset: line.asset },
          before: { balance: line.balance, cachedAt: line.cachedAt ?? null },
          after: { balance: null },
          reversible: true,
          risk: "medium",
          rollback: "Restore the cached line from `before`; the next balance view re-reads the ledger anyway."
        })
      ]
    };
  },

  recache_balance: (finding, { input }) => {
    const ledger = input.ledgerBalances.find((entry) => balanceKey(entry) === finding.recordId);
    const lines = input.storedBalances.filter((entry) => balanceKey(entry) === finding.recordId);
    if (!ledger || lines.length === 0) return manual("the stored or ledger line could not be located in the snapshot");
    // With duplicate lines the dedupe action decides which line survives; a
    // recache of an arbitrary one would race it.
    if (lines.length > 1) return manual("the asset is held on more than one line; dedupe it first, then re-plan");
    const line = lines[0];
    return {
      actions: [
        action({
          kind: "recache_balance",
          idTarget: balanceKey(line),
          findingIds: [finding.id],
          invariant: finding.invariant,
          subject: finding.subject,
          target: { account: line.account, asset: line.asset },
          before: { balance: line.balance, cachedAt: line.cachedAt ?? null },
          after: { balance: ledger.balance, reference: ledger.reference, cachedAt: new Date(input.now).toISOString() },
          reversible: true,
          risk: "low",
          rollback: "Write `before.balance` back; the ledger stays authoritative, so this only restores the stale view."
        })
      ]
    };
  },

  dedupe_balance_lines: (finding, { input }) => {
    const lines = input.storedBalances.filter((entry) => balanceKey(entry) === finding.recordId);
    if (lines.length < 2) return manual("the duplicate lines could not be located in the snapshot");
    const keep = newest(lines);
    return {
      actions: [
        action({
          kind: "dedupe_balance_lines",
          idTarget: finding.recordId,
          findingIds: [finding.id],
          invariant: finding.invariant,
          subject: finding.subject,
          target: { account: keep.account, asset: keep.asset },
          before: {
            lines: lines.length,
            balances: lines.map((line) => line.balance).join(","),
            cachedAt: lines.map((line) => line.cachedAt ?? "").join(",")
          },
          after: { lines: 1, balance: keep.balance, cachedAt: keep.cachedAt ?? null },
          reversible: true,
          risk: "low",
          rollback: "Re-insert the removed lines listed in `before`; then fix the write site before re-running."
        })
      ]
    };
  },

  dead_letter_job: (finding, { input }) => {
    const job = input.jobs.find((entry) => entry.id === finding.recordId);
    if (!job) return manual("the job could not be located in the snapshot");
    return {
      actions: [
        action({
          kind: "dead_letter_job",
          idTarget: job.id,
          findingIds: [finding.id],
          invariant: finding.invariant,
          subject: finding.subject,
          target: { jobId: job.id },
          before: { status: job.status, attempts: job.attempts, maxAttempts: job.maxAttempts },
          after: { status: "dead_lettered" },
          lifecycleEvent: "dead_letter",
          // dead_lettered is terminal in the worker_job lifecycle.
          reversible: false,
          risk: "medium",
          rollback: "Not revertible through the lifecycle. Re-enqueue a new job with the same params if the work is still wanted."
        })
      ]
    };
  },

  cancel_duplicate_job: (finding, { input, terminalJobs }) => {
    const job = input.jobs.find((entry) => entry.id === finding.recordId);
    if (!job || job.dedupeKey === undefined) return manual("the job could not be located in the snapshot");
    const group = input.jobs.filter(
      (entry) => entry.dedupeKey === job.dedupeKey && (entry.status === "queued" || entry.status === "retrying")
    );
    const keep = oldestJob(group);
    // Every job but the oldest is cancelled. Several findings for one key plan
    // the same actions; ids collapse them.
    const actions = group
      .filter((entry) => entry.id !== keep.id && !terminalJobs.has(entry.id))
      .map((entry) =>
        action({
          kind: "cancel_duplicate_job",
          idTarget: entry.id,
          findingIds: [finding.id],
          invariant: finding.invariant,
          subject: finding.subject,
          target: { jobId: entry.id, keepJobId: keep.id },
          before: { status: entry.status, dedupeKey: entry.dedupeKey ?? null },
          after: { status: "dead_lettered" },
          lifecycleEvent: "dead_letter",
          reversible: false,
          risk: "low",
          rollback: `Not revertible through the lifecycle. The surviving job ${keep.id} carries the same work.`
        })
      );
    return actions.length ? { actions } : manual("every duplicate is already being moved to a terminal state");
  },

  requeue_job: (finding, { input, terminalJobs }) => {
    const job = input.jobs.find((entry) => entry.id === finding.recordId);
    if (!job) return manual("the job could not be located in the snapshot");
    if (terminalJobs.has(job.id)) return manual("the job is also being dead-lettered or cancelled by this plan");
    // A stalled scheduler is not fixed by poking each job; it would just stall again.
    if (finding.rootCause?.code === "scheduler_not_draining") {
      return manual("no worker is draining the queue; restart the scheduler instead of requeueing jobs one by one");
    }
    return {
      actions: [
        action({
          kind: "requeue_job",
          idTarget: job.id,
          findingIds: [finding.id],
          invariant: finding.invariant,
          subject: finding.subject,
          target: { jobId: job.id },
          before: { status: job.status, nextAttemptAt: job.nextAttemptAt ?? null },
          after: { status: "queued", nextAttemptAt: new Date(input.now).toISOString() },
          lifecycleEvent: job.status === "retrying" ? "retry" : undefined,
          reversible: true,
          risk: "low",
          rollback: "Restore `before.nextAttemptAt`; the job has not run yet, so there is no side effect to undo."
        })
      ]
    };
  },

  sweep_idempotency: (finding, { input }) => {
    const record = input.idempotencyRecords.find((entry) => entry.key === finding.recordId);
    if (!record) return manual("the record could not be located in the snapshot");
    const expiresAt = Date.parse(record.expiresAt);
    if (!(Number.isFinite(expiresAt) && input.now > expiresAt)) {
      // An unexpired in-flight claim may belong to work that is still running.
      return manual("the claim has not expired and its work may still be running; abandon it only after confirming");
    }
    return {
      actions: [
        action({
          kind: "sweep_idempotency",
          idTarget: record.key,
          findingIds: [finding.id],
          invariant: finding.invariant,
          subject: finding.subject,
          target: { key: record.key },
          before: { status: record.status, expiresAt: record.expiresAt },
          after: { status: null },
          // A replay must be a real outcome or absent: never restored.
          reversible: false,
          risk: "low",
          rollback: "None needed: the record was already expired and could not be replayed."
        })
      ]
    };
  },

  purge_envelope: (finding, { input }) => {
    const envelope = input.exportEnvelopes.find((entry) => entry.correlationId === finding.recordId);
    if (!envelope) return manual("the envelope could not be located in the snapshot");
    return {
      actions: [
        action({
          kind: "purge_envelope",
          idTarget: envelope.correlationId,
          findingIds: [finding.id],
          invariant: finding.invariant,
          subject: finding.subject,
          target: { correlationId: envelope.correlationId },
          before: { expiresAt: envelope.expiresAt, recordCount: envelope.recordCount },
          after: { state: "purged" },
          lifecycleEvent: "purge",
          reversible: false,
          risk: "medium",
          rollback: "Regenerate the export under a fresh idempotency key if a consumer still needs it."
        })
      ]
    };
  },

  drop_notification: (finding, { input }) => {
    const entries = input.notifications.filter((entry) => entry.id === finding.recordId);
    if (entries.length === 0) return manual("the notification could not be located in the snapshot");
    return {
      actions: entries.map((entry) =>
        action({
          kind: "drop_notification",
          idTarget: `${entry.recipient}|${entry.id}`,
          findingIds: [finding.id],
          invariant: finding.invariant,
          subject: finding.subject,
          target: { recipient: entry.recipient, id: entry.id },
          before: { state: String(entry.state) },
          after: { state: null },
          reversible: false,
          risk: "medium",
          rollback: "Republish through the notification workflow; the entry's undeclared state is not restored."
        })
      )
    };
  },

  collapse_notification: (finding, { input }) => {
    const groups = new Map<string, number>();
    for (const entry of input.notifications.filter((item) => item.id === finding.recordId)) {
      groups.set(entry.recipient, (groups.get(entry.recipient) ?? 0) + 1);
    }
    const actions = [...groups]
      .filter(([, copies]) => copies > 1)
      .map(([recipient, copies]) =>
        action({
          kind: "collapse_notification",
          idTarget: `${recipient}|${finding.recordId}`,
          findingIds: [finding.id],
          invariant: finding.invariant,
          subject: finding.subject,
          target: { recipient, id: finding.recordId },
          before: { copies },
          after: { copies: 1 },
          reversible: false,
          risk: "low",
          rollback: "None needed: the removed copies were identical by id."
        })
      );
    return actions.length ? { actions } : manual("the duplicate entries could not be located in the snapshot");
  }
};

function fingerprintOf(actions: readonly RepairAction[]): string {
  return sha256Hex(
    canonicalJson(actions.map(({ id, kind, target, before, after, lifecycleEvent, reversible }) => ({
      id,
      kind,
      target,
      before,
      after,
      lifecycleEvent: lifecycleEvent ?? null,
      reversible
    })))
  );
}

/**
 * Turns a dry-run report into a plan. Pure: reads the report and the snapshot
 * it was produced from, writes nothing.
 */
export function planRepairs(
  report: ReconciliationReport,
  input: ReconciliationInput,
  options: PlanOptions = {}
): RepairPlan {
  const now = options.now ?? input.now;
  const terminalJobs = new Set(
    report.findings.filter((entry) => entry.invariant === "worker_job.budget_consistent").map((entry) => entry.recordId)
  );
  const context: PlanContext = { input, report, terminalJobs };

  const actions = new Map<string, RepairAction>();
  const manualFollowUps: ManualFollowUp[] = [];
  const seenFindings = new Set<string>();

  for (const finding of report.findings) {
    // Repeated duplicates share one finding id; plan each identity once.
    if (seenFindings.has(finding.id)) continue;
    seenFindings.add(finding.id);

    const strategy = REPAIR_STRATEGIES[finding.invariant];
    const followUp = (reason: string) =>
      manualFollowUps.push({ findingId: finding.id, invariant: finding.invariant, reason, repair: finding.repair });

    if (strategy === undefined || strategy === "manual") {
      followUp("this invariant has no safe automatic repair");
      continue;
    }
    // A scrubbed identity cannot be matched back to a record, and a record with
    // a secret pasted into its key is an incident, not a cache repair.
    if (finding.recordId.includes("[REDACTED]")) {
      followUp("the record identity contains a redacted secret; handle it as a security incident");
      continue;
    }

    const planned = strategies[strategy](finding, context);
    if ("manual" in planned) {
      followUp(planned.manual);
      continue;
    }
    for (const entry of planned.actions) {
      const existing = actions.get(entry.id);
      actions.set(
        entry.id,
        existing ? { ...existing, findingIds: [...new Set([...existing.findingIds, ...entry.findingIds])] } : entry
      );
    }
  }

  const list = [...actions.values()].sort((a, b) => a.id.localeCompare(b.id));
  const reversible = list.filter((entry) => entry.reversible).length;
  return {
    planId: options.planId ?? newCorrelationId(),
    runId: report.runId,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + (options.ttlMs ?? REPAIR_PLAN_TTL_MS)).toISOString(),
    dryRun: true,
    actions: list,
    manual: manualFollowUps,
    fingerprint: fingerprintOf(list),
    summary: {
      actions: list.length,
      reversible,
      irreversible: list.length - reversible,
      manual: manualFollowUps.length
    }
  };
}

/** A stable rendering of a plan for a PR comment or a maintainer review. */
export function formatRepairPlan(plan: RepairPlan): string {
  const lines = [
    `repair plan ${plan.planId} for run ${plan.runId} (dry run, expires ${plan.expiresAt})`,
    `  ${plan.summary.actions} action(s): ${plan.summary.reversible} reversible, ` +
      `${plan.summary.irreversible} irreversible; ${plan.summary.manual} manual follow-up(s)`,
    ""
  ];
  if (plan.actions.length === 0 && plan.manual.length === 0) {
    lines.push("  nothing to repair");
    return lines.join("\n");
  }
  for (const entry of plan.actions) {
    lines.push(`  [${entry.risk}] ${entry.kind} ${entry.id}${entry.reversible ? "" : " (irreversible)"}`);
    lines.push(`      before ${canonicalJson(entry.before)}`);
    lines.push(`      after  ${canonicalJson(entry.after)}`);
    lines.push(`      rollback: ${entry.rollback}`);
  }
  for (const entry of plan.manual) {
    lines.push(`  [manual] ${entry.invariant} ${entry.findingId}`);
    lines.push(`      reason: ${entry.reason}`);
  }
  return lines.join("\n");
}

// --- applying --------------------------------------------------------------

export interface RepairHandler {
  /** Performs the write. Throws on failure; the run then rolls back. */
  apply(action: RepairAction): void;
  /** Undoes `apply` using `action.before`. Required for reversible kinds. */
  revert?(action: RepairAction): void;
}

export type RepairHandlers = Partial<Record<RepairActionKind, RepairHandler>>;

export type RepairErrorCode =
  | "repair_denied"
  | "confirmation_required"
  | "plan_tampered"
  | "plan_expired"
  | "nothing_selected"
  | "blast_radius_exceeded"
  | "handler_missing"
  | "snapshot_unavailable"
  | "plan_stale"
  | "repair_failed";

export interface RepairFailureDetail {
  readonly failedAction?: string;
  readonly message?: string;
  /** Actions whose `before` no longer matches the source (for `plan_stale`). */
  readonly stale?: readonly string[];
  /** Action kinds with no handler (for `handler_missing`). */
  readonly missing?: readonly string[];
  readonly rolledBack?: readonly string[];
  /** Actions that were applied and could not be reverted: inspect by hand. */
  readonly rollbackFailed?: readonly string[];
}

export interface JournalEntry {
  readonly action: RepairAction;
  readonly appliedAt: string;
}

export interface RepairOutcome {
  readonly planId: string;
  readonly correlationId: string;
  readonly applied: readonly string[];
  readonly skipped: readonly { readonly id: string; readonly reason: string }[];
  /** What was applied, in order. Feed it to `rollbackRepair` to undo. */
  readonly journal: readonly JournalEntry[];
  /** Findings confirmed gone by a post-apply reconciliation. */
  readonly verified: readonly string[];
  /** Findings an applied action targeted that a fresh run still reports. */
  readonly stillDrifting: readonly string[];
  /** False when the verification read failed; the repair itself succeeded. */
  readonly verificationRan: boolean;
}

export interface ApplyDeps {
  /** Reads the source of truth and the projections fresh. Never cached. */
  read: () => ReconciliationInput;
  handlers: RepairHandlers;
  auth: AuthContext;
  /** Must equal `plan.planId`: the caller has seen the dry run it approves. */
  confirm: string;
  /** Apply only these action ids. Defaults to every action in the plan. */
  only?: readonly string[];
  /** Irreversible actions are skipped unless this is set. */
  allowIrreversible?: boolean;
  maxActions?: number;
  now?: () => number;
}

/** Fails closed: a role the RBAC table does not know cannot repair. */
function mayRepair(auth: AuthContext): boolean {
  try {
    return hasPermission(auth.role, REPAIR_PERMISSION);
  } catch {
    return false;
  }
}

function auditActor(auth: AuthContext): AuditActor {
  if (auth.role === "maintainer") return { kind: "maintainer", id: auth.userId ?? "maintainer" };
  if (auth.role === "service") return { kind: "system", id: auth.userId ?? "service" };
  return { kind: "user", id: auth.userId ?? auth.role };
}

function sameValues(left: Readonly<Record<string, RepairValue>>, right: Readonly<Record<string, RepairValue>>): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

/** Fields stamped from the clock at plan time; they differ on every re-plan. */
const CLOCK_FIELDS = new Set(["cachedAt", "nextAttemptAt"]);

function withoutClock(values: Readonly<Record<string, RepairValue>>): Record<string, RepairValue> {
  return Object.fromEntries(Object.entries(values).filter(([key]) => !CLOCK_FIELDS.has(key)));
}

/**
 * The fresh plan must want the same write from the same state: an unchanged
 * `before` proves the record has not moved, an unchanged `after` proves the
 * source of truth has not (a recache would otherwise write an old ledger value).
 */
function stillApplies(approved: RepairAction, current: RepairAction | undefined): boolean {
  return (
    current !== undefined &&
    sameValues(current.target, approved.target) &&
    sameValues(current.before, approved.before) &&
    sameValues(withoutClock(current.after), withoutClock(approved.after))
  );
}

function primitives(record: Readonly<Record<string, RepairValue>>): Record<string, RepairValue> {
  return { ...record };
}

/**
 * Applies an approved plan. Every precondition is checked before the first
 * write; any failure after it rolls the run back.
 */
export function applyRepairPlan(
  plan: RepairPlan,
  deps: ApplyDeps
): Result<RepairOutcome, RepairErrorCode, RepairFailureDetail> {
  const clock = deps.now ?? Date.now;
  const correlationId = newCorrelationId();
  const actor = auditActor(deps.auth);

  const refuse = (
    code: RepairErrorCode,
    detail?: RepairFailureDetail
  ): Result<RepairOutcome, RepairErrorCode, RepairFailureDetail> => {
    recordAudit({
      action: "reconciliation.repaired",
      actor,
      scope: "maintainer",
      target: { kind: "repair_plan", id: plan.planId },
      reason: "apply_refused",
      outcome: "denied",
      errorCode: code,
      after: { actions: plan.actions.length },
      at: new Date(clock()).toISOString(),
      correlationId
    });
    emitTelemetry({
      op: "reconciliation.repair",
      actorType: actor.kind === "user" ? "user" : "system",
      result: "failure",
      correlationId,
      errorCode: code,
      payload: { planned: plan.actions.length }
    });
    return err(code, detail);
  };

  // 1. Who, and did they look at the dry run.
  if (!mayRepair(deps.auth)) return refuse("repair_denied");
  if (deps.confirm !== plan.planId) return refuse("confirmation_required");

  // 2. Is this the plan the dry run produced, and is it still fresh.
  if (plan.dryRun !== true || fingerprintOf(plan.actions) !== plan.fingerprint) return refuse("plan_tampered");
  if (clock() > Date.parse(plan.expiresAt)) return refuse("plan_expired");

  // 3. What exactly will run.
  const wanted = deps.only ? new Set(deps.only) : undefined;
  const skipped: { id: string; reason: string }[] = [];
  const selected: RepairAction[] = [];
  for (const entry of plan.actions) {
    if (wanted && !wanted.has(entry.id)) continue;
    if (!entry.reversible && !deps.allowIrreversible) {
      skipped.push({ id: entry.id, reason: "irreversible; pass allowIrreversible to include it" });
      continue;
    }
    selected.push(entry);
  }
  if (wanted) {
    const known = new Set(plan.actions.map((entry) => entry.id));
    for (const id of wanted) if (!known.has(id)) skipped.push({ id, reason: "not in the plan" });
  }
  if (selected.length === 0) return refuse("nothing_selected");
  if (selected.length > (deps.maxActions ?? REPAIR_DEFAULT_MAX_ACTIONS)) return refuse("blast_radius_exceeded");

  const missing = [
    ...new Set(
      selected
        .filter((entry) => {
          const handler = deps.handlers[entry.kind];
          return !handler || (entry.reversible && !handler.revert);
        })
        .map((entry) => entry.kind)
    )
  ];
  if (missing.length) return refuse("handler_missing", { missing });

  // 4. Has the world moved since the dry run. Re-read, re-plan, compare.
  let fresh: ReconciliationInput;
  try {
    fresh = deps.read();
  } catch {
    return refuse("snapshot_unavailable");
  }
  if (!fresh || typeof fresh.now !== "number") return refuse("snapshot_unavailable");
  const replanned = new Map(planRepairs(reconcile(fresh), fresh).actions.map((entry) => [entry.id, entry]));
  const stale = selected
    .filter((entry) => !stillApplies(entry, replanned.get(entry.id)))
    .map((entry) => entry.id);
  if (stale.length) return refuse("plan_stale", { stale });

  // 5. Apply, journaling as we go; undo everything on the first failure.
  const journal: JournalEntry[] = [];
  for (const entry of selected) {
    try {
      deps.handlers[entry.kind]!.apply(entry);
      journal.push({ action: entry, appliedAt: new Date(clock()).toISOString() });
    } catch (error) {
      const undone = revertJournal(journal, deps.handlers);
      for (const reverted of undone.rolledBack) auditAction(reverted, actor, correlationId, clock, "reverted");
      return refuse("repair_failed", {
        failedAction: entry.id,
        message: error instanceof Error ? error.message.slice(0, 160) : "handler failed",
        rolledBack: undone.rolledBack.map((item) => item.id),
        rollbackFailed: undone.rollbackFailed.map((item) => item.id)
      });
    }
  }
  for (const entry of journal) auditAction(entry.action, actor, correlationId, clock, "applied");

  // 6. Did it work. A failed verification read does not undo a good repair.
  const targeted = [...new Set(journal.flatMap((entry) => entry.action.findingIds))];
  let verified: string[] = [];
  let stillDrifting: string[] = [];
  let verificationRan = false;
  try {
    const after = deps.read();
    const remaining = new Set(reconcile(after).findings.map((entry) => entry.id));
    verified = targeted.filter((id) => !remaining.has(id));
    stillDrifting = targeted.filter((id) => remaining.has(id));
    verificationRan = true;
  } catch {
    verificationRan = false;
  }

  emitTelemetry({
    op: "reconciliation.repair",
    actorType: actor.kind === "user" ? "user" : "system",
    result: stillDrifting.length === 0 && verificationRan ? "success" : "failure",
    correlationId,
    errorCode: !verificationRan ? "verification_unavailable" : stillDrifting.length ? "drift_remains" : undefined,
    payload: {
      applied: journal.length,
      skipped: skipped.length,
      verified: verified.length,
      stillDrifting: stillDrifting.length
    }
  });

  return ok({
    planId: plan.planId,
    correlationId,
    applied: journal.map((entry) => entry.action.id),
    skipped,
    journal,
    verified,
    stillDrifting,
    verificationRan
  });
}

function auditAction(
  entry: RepairAction,
  actor: AuditActor,
  correlationId: string,
  clock: () => number,
  reason: "applied" | "reverted"
): void {
  recordAudit({
    action: "reconciliation.repaired",
    actor,
    scope: "maintainer",
    target: { kind: entry.subject, id: entry.id },
    reason: `${entry.kind}.${reason}`,
    before: primitives(reason === "applied" ? entry.before : entry.after),
    after: primitives(reason === "applied" ? entry.after : entry.before),
    at: new Date(clock()).toISOString(),
    correlationId
  });
}

function revertJournal(
  journal: readonly JournalEntry[],
  handlers: RepairHandlers
): { rolledBack: RepairAction[]; rollbackFailed: RepairAction[] } {
  const rolledBack: RepairAction[] = [];
  const rollbackFailed: RepairAction[] = [];
  for (const entry of [...journal].reverse()) {
    const handler = handlers[entry.action.kind];
    if (!entry.action.reversible || !handler?.revert) {
      rollbackFailed.push(entry.action);
      continue;
    }
    try {
      handler.revert(entry.action);
      rolledBack.push(entry.action);
    } catch {
      rollbackFailed.push(entry.action);
    }
  }
  return { rolledBack, rollbackFailed };
}

export type RollbackErrorCode = "repair_denied" | "rollback_incomplete";

/**
 * Undoes a completed repair from its journal, newest action first. Irreversible
 * actions are reported, not attempted; their `rollback` text says what to do.
 */
export function rollbackRepair(
  outcome: RepairOutcome,
  deps: { handlers: RepairHandlers; auth: AuthContext; now?: () => number }
): Result<{ rolledBack: string[]; manual: string[] }, RollbackErrorCode, { rolledBack: string[]; failed: string[] }> {
  if (!mayRepair(deps.auth)) return err("repair_denied");
  const clock = deps.now ?? Date.now;
  const actor = auditActor(deps.auth);
  const reversible = outcome.journal.filter((entry) => entry.action.reversible);
  const manualIds = outcome.journal.filter((entry) => !entry.action.reversible).map((entry) => entry.action.id);

  const { rolledBack, rollbackFailed } = revertJournal(reversible, deps.handlers);
  for (const entry of rolledBack) auditAction(entry, actor, outcome.correlationId, clock, "reverted");

  if (rollbackFailed.length) {
    return err("rollback_incomplete", {
      rolledBack: rolledBack.map((entry) => entry.id),
      failed: rollbackFailed.map((entry) => entry.id)
    });
  }
  return ok({ rolledBack: rolledBack.map((entry) => entry.id), manual: manualIds });
}

// --- workflow --------------------------------------------------------------

export interface RepairWorkflowDeps {
  read: () => ReconciliationInput;
  handlers: RepairHandlers;
  now?: () => number;
}

/**
 * The two-step workflow a CLI or an admin view drives: `dryRun()` reads once,
 * reports and plans; `apply()` takes that plan back with explicit confirmation.
 * There is deliberately no single call that plans and applies.
 */
export function createRepairWorkflow(deps: RepairWorkflowDeps) {
  return {
    dryRun(): Result<{ report: ReconciliationReport; plan: RepairPlan }, "snapshot_unavailable"> {
      let input: ReconciliationInput;
      try {
        input = deps.read();
      } catch {
        return err("snapshot_unavailable");
      }
      if (!input || typeof input.now !== "number") return err("snapshot_unavailable");
      const now = deps.now?.() ?? input.now;
      const report = reconcile({ ...input, now });
      return ok({ report, plan: planRepairs(report, { ...input, now }, { now }) });
    },
    apply(plan: RepairPlan, options: Omit<ApplyDeps, "read" | "handlers" | "now">) {
      return applyRepairPlan(plan, { ...options, read: deps.read, handlers: deps.handlers, now: deps.now });
    },
    rollback(outcome: RepairOutcome, auth: AuthContext) {
      return rollbackRepair(outcome, { handlers: deps.handlers, auth, now: deps.now });
    }
  };
}
