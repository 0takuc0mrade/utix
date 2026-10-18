/**
 * Read-only reconciliation between stored records, derived balances and
 * external settlement references.
 *
 * Utix stores a lot of small records — jobs, notifications, export envelopes,
 * idempotency claims — and it also *shows* numbers it read from a Stellar
 * ledger. Reconciliation is the process of checking that the stored world
 * still agrees with itself and with the ledger references it was derived from.
 * Nothing here mutates anything:
 *
 * - every check is a pure function of the supplied snapshot;
 * - the snapshot is treated as immutable, so a dry run in CI cannot alter the
 *   state it is inspecting;
 * - drift is reported with **repair guidance**, never applied. A repair that
 *   changes production data is a separate, reviewed operation
 *   (`core/reconciliation/repair.ts`), which plans from this report and
 *   re-checks it before anything is written;
 * - each finding carries a **root-cause hint** derived from evidence in the
 *   same snapshot, so a report says *why* a record probably drifted, not only
 *   *that* it did.
 *
 * Findings fall into four kinds, because they need four different responses:
 *
 * | Kind          | Means                                            |
 * |---------------|--------------------------------------------------|
 * | `missing`     | a record exists on one side and not the other    |
 * | `duplicate`   | two records claim the same identity              |
 * | `stale`       | a record is still open long past its deadline    |
 * | `inconsistent`| two fields of the same record disagree           |
 */

import { operationMachine, notificationMachine, workerJobMachine } from "@/core/lifecycle/records";
import type { IdempotencyRecord } from "@/core/idempotency/idempotency";
import type { ExportEnvelope } from "@/core/export/exporter";
import type { JobPayload } from "@/core/workers/queue";
import type { Notification } from "@/core/notifications/types";
import { emitTelemetry, newCorrelationId, redact } from "@/core/telemetry/telemetry";

export type FindingKind = "missing" | "duplicate" | "stale" | "inconsistent";
export type FindingSeverity = "info" | "warning" | "critical";

/** One declared invariant. Exported so docs and the CLI can never drift. */
export interface ReconciliationInvariant {
  readonly id: string;
  readonly statement: string;
  readonly kind: FindingKind;
  /** What a human should do about a violation. Never applied automatically. */
  readonly repair: string;
}

export const RECONCILIATION_INVARIANTS: readonly ReconciliationInvariant[] = [
  {
    id: "balance.ledger_entry_present",
    statement: "Every balance shown to a user has a matching ledger entry.",
    kind: "missing",
    repair:
      "Re-read the account from Horizon for this asset. If the ledger has no entry, drop the cached line and re-run the balance view; if it does, re-cache it. Never edit the stored amount by hand."
  },
  {
    id: "balance.amount_agrees",
    statement: "A stored balance equals the ledger balance for the same account and asset.",
    kind: "inconsistent",
    repair:
      "Treat the ledger as authoritative and re-cache the line. Investigate the window between the last cache and the ledger close before assuming a bug in either side."
  },
  {
    id: "balance.single_line_per_asset",
    statement: "An account has at most one stored balance line per asset.",
    kind: "duplicate",
    repair:
      "Keep the newest line per (account, asset), delete the rest, and add a uniqueness guard at the write site that produced the duplicate."
  },
  {
    id: "worker_job.state_declared",
    statement: "Every job status is a state the worker_job lifecycle declares.",
    kind: "inconsistent",
    repair:
      "Do not invent a status. Add the missing state to the lifecycle table if it is genuinely needed, or move the job to the nearest declared state by replaying its last known event."
  },
  {
    id: "worker_job.budget_consistent",
    statement: "A job that has used its whole retry budget is terminal.",
    kind: "inconsistent",
    repair:
      "Dead-letter the job with its last error context instead of letting it run again, or raise maxAttempts deliberately and record why."
  },
  {
    id: "worker_job.dedupe_unique",
    statement: "At most one pending job shares a dedupe key.",
    kind: "duplicate",
    repair:
      "Keep the oldest pending job and cancel the others, then check the two enqueue paths that used the same dedupe key without an idempotency key."
  },
  {
    id: "worker_job.progress",
    statement: "A pending job runs within its retry deadline.",
    kind: "stale",
    repair:
      "Call processJob(id) to run it, or retryJob(id) to reset its backoff. A job past the deadline is a scheduling gap, not a handler bug."
  },
  {
    id: "idempotency.claim_fresh",
    statement: "An in-flight claim is settled before its TTL and expired records are swept.",
    kind: "stale",
    repair:
      "Run idempotency.sweep() and abandon claims whose work never started. Do not hand-edit a record; a replay must be either a real outcome or absent."
  },
  {
    id: "export_envelope.count_matches",
    statement: "An envelope's recordCount equals the records it carries.",
    kind: "inconsistent",
    repair:
      "Regenerate the export with a fresh idempotency key and treat the stored envelope as untrustworthy; a truncated envelope looks valid to a consumer."
  },
  {
    id: "export_envelope.retention",
    statement: "An envelope past its expiry is not still marked generated.",
    kind: "stale",
    repair:
      "Purge the artifact through the export_envelope lifecycle (expire, then purge) and confirm no consumer is serving the stored copy."
  },
  {
    id: "notification.state_declared",
    statement: "Every notification state is declared by the notification lifecycle.",
    kind: "inconsistent",
    repair:
      "Drop the unread entry and let the workflow republish it. An undeclared state usually means a write site bypassed the lifecycle table."
  },
  {
    id: "notification.identity_unique",
    statement: "A notification id appears once per recipient.",
    kind: "duplicate",
    repair:
      "Keep the newest entry and delete the rest, then publish through a single path so a dedupe key cannot be claimed twice."
  },
  {
    id: "operation.settles",
    statement: "A measured operation record reaches a terminal state.",
    kind: "stale",
    repair:
      "An operation left `started` was cut off mid-flight. Re-run the read-only operation to produce a fresh terminal record; there is nothing to repair in place."
  }
] as const;

const INVARIANT_INDEX = new Map(RECONCILIATION_INVARIANTS.map((entry) => [entry.id, entry]));

/**
 * Why a record probably drifted. Derived only from evidence in the snapshot, so
 * it is a hint, not a diagnosis: `likely` means the evidence points one way,
 * `possible` means it is the best of several explanations.
 */
export interface RootCauseHint {
  /** Stable, machine-readable cause, e.g. `cache_stale`. */
  readonly code: string;
  readonly confidence: "likely" | "possible";
  /** Safe, human-readable explanation. */
  readonly hint: string;
  /** Short `name=value` facts the hint was derived from. */
  readonly evidence?: readonly string[];
}

export interface ReconciliationFinding {
  /** Stable id, e.g. `worker_job.dedupe_unique:job-1`. */
  readonly id: string;
  readonly invariant: string;
  readonly kind: FindingKind;
  readonly severity: FindingSeverity;
  /** The record kind the drift was found in. */
  readonly subject: string;
  readonly recordId: string;
  /** Safe, human-readable explanation. Never contains a raw payload. */
  readonly detail: string;
  readonly expected?: string;
  readonly observed?: string;
  /** The invariant's repair guidance, copied onto the finding. */
  readonly repair: string;
  /** Additive: the most probable cause, when the snapshot holds evidence. */
  readonly rootCause?: RootCauseHint;
}

/** A user-facing balance as the app stored it. Amounts are strings. */
export interface StoredBalance {
  readonly account: string;
  readonly asset: string;
  readonly balance: string;
  readonly cachedAt?: string;
}

/** The same balance as the ledger (or another external source) reports it. */
export interface LedgerBalance {
  readonly account: string;
  readonly asset: string;
  readonly balance: string;
  /** Settlement reference, e.g. a ledger sequence or a trade id. */
  readonly reference: string;
}

/** One measured operation, as retained for review. */
export interface OperationRecord {
  readonly id: string;
  readonly op: string;
  readonly state: string;
  readonly startedAt: string;
  readonly correlationId: string;
}

export interface ReconciliationInput {
  /** What the app stored and showed. */
  storedBalances: readonly StoredBalance[];
  /** What the external source reports now. */
  ledgerBalances: readonly LedgerBalance[];
  jobs: readonly JobPayload[];
  notifications: readonly Notification[];
  idempotencyRecords: readonly IdempotencyRecord[];
  exportEnvelopes: readonly ExportEnvelope[];
  operations: readonly OperationRecord[];
  /** Injected clock, in ms. Everything age-based is measured from here. */
  now: number;
  /** A queued or retrying job older than this is stale. Default 5 minutes. */
  staleAfterMs?: number;
}

export interface CheckResult {
  readonly invariant: string;
  readonly checked: number;
  readonly findings: number;
}

export interface ReconciliationReport {
  readonly runId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  /** Always true: this module has no write path at all. */
  readonly dryRun: true;
  readonly checks: readonly CheckResult[];
  readonly findings: readonly ReconciliationFinding[];
  readonly summary: Readonly<Record<FindingKind | "total", number>>;
  /** True when nothing at `critical` severity was found. */
  readonly clean: boolean;
}

export type ReconciliationErrorCode = "invalid_snapshot";

/** Compares decimal amount strings without floating point. */
export function amountsEqual(left: string, right: string): boolean {
  const parse = (value: string): { sign: 1 | -1; units: bigint; places: number } | null => {
    const trimmed = value.trim();
    if (!/^-?\d+(\.\d+)?$/.test(trimmed)) return null;
    const negative = trimmed.startsWith("-");
    const [whole = "0", fraction = ""] = (negative ? trimmed.slice(1) : trimmed).split(".");
    return {
      sign: negative ? -1 : 1,
      units: BigInt(`${whole}${fraction}`),
      places: fraction.length
    };
  };

  const a = parse(left);
  const b = parse(right);
  if (a === null || b === null) return left.trim() === right.trim();

  // Compare at a common scale so "1.5" and "1.50" are equal, "1.5" and "1.51"
  // are not.
  const places = Math.max(a.places, b.places);
  const scaled = (value: { sign: 1 | -1; units: bigint; places: number }) =>
    BigInt(value.sign) * value.units * 10n ** BigInt(places - value.places);
  return scaled(a) === scaled(b);
}

/** A Stellar secret (seed) embedded in a longer string. */
const EMBEDDED_SECRET = /\b[SM][A-Z2-7]{55}\b/g;

/**
 * A finding quotes record values, so a value that was pasted into a record can
 * end up in a report. Whole-string redaction misses an *embedded* secret, so
 * quoted fragments are scrubbed explicitly before the report is built.
 */
export function scrubSecrets(value: string): string {
  return value.replace(EMBEDDED_SECRET, "[REDACTED]");
}

function finding(
  invariant: string,
  subject: string,
  recordId: string,
  detail: string,
  extra: { expected?: string; observed?: string; severity?: FindingSeverity; rootCause?: RootCauseHint } = {}
): ReconciliationFinding {
  const declared = INVARIANT_INDEX.get(invariant);
  if (!declared) throw new Error(`[reconciliation] undeclared invariant ${invariant}`);
  const safeId = scrubSecrets(recordId);
  return {
    id: `${invariant}:${safeId}`,
    invariant,
    kind: declared.kind,
    severity: extra.severity ?? defaultSeverity(declared.kind),
    subject,
    recordId: safeId,
    detail: scrubSecrets(detail),
    expected: extra.expected === undefined ? undefined : scrubSecrets(extra.expected),
    observed: extra.observed === undefined ? undefined : scrubSecrets(extra.observed),
    repair: declared.repair,
    rootCause: extra.rootCause === undefined ? undefined : scrubCause(extra.rootCause)
  };
}

function scrubCause(cause: RootCauseHint): RootCauseHint {
  return {
    code: cause.code,
    confidence: cause.confidence,
    hint: scrubSecrets(cause.hint),
    evidence: cause.evidence?.map(scrubSecrets)
  };
}

function cause(
  code: string,
  confidence: RootCauseHint["confidence"],
  hint: string,
  evidence?: string[]
): RootCauseHint {
  return evidence && evidence.length ? { code, confidence, hint, evidence } : { code, confidence, hint };
}

/** Stellar amounts carry at most seven decimal places. */
const STELLAR_DECIMALS = 7;

function fractionDigits(value: string): number {
  const fraction = value.trim().split(".")[1];
  return fraction ? fraction.length : 0;
}

const DEFAULT_STALE_AFTER_MS = 5 * 60 * 1_000;

function staleAfterOf(input: ReconciliationInput): number {
  return input.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
}

/**
 * Statuses older or newer builds wrote for a job. Seeing one means a write site
 * ran a different schema, not that the lifecycle is missing a state.
 */
const LEGACY_JOB_STATUSES: Readonly<Record<string, string>> = {
  pending: "queued",
  failed: "dead_lettered",
  completed: "succeeded",
  done: "succeeded",
  in_progress: "running"
};

function missingLedgerCause(input: ReconciliationInput, entry: StoredBalance): RootCauseHint {
  if (input.ledgerBalances.length === 0) {
    return cause(
      "ledger_read_empty",
      "likely",
      "The snapshot carries no ledger entries at all, so the ledger read most likely failed or was skipped. Do not drop any cached line on this evidence.",
      [`stored_lines=${input.storedBalances.length}`, "ledger_lines=0"]
    );
  }
  const otherAssets = input.ledgerBalances.filter((line) => line.account === entry.account);
  if (otherAssets.length > 0) {
    return cause(
      "trustline_removed",
      "likely",
      `The ledger still reports ${otherAssets.length} other asset line(s) for this account but not ${entry.asset}; the trustline was probably removed after the line was cached.`,
      [`ledger_assets_for_account=${otherAssets.length}`]
    );
  }
  return cause(
    "account_not_loaded",
    "possible",
    "The ledger snapshot holds nothing for this account. It may have been merged or never funded, or the read was partial; re-read the account before acting.",
    ["ledger_lines_for_account=0"]
  );
}

function amountDriftCause(input: ReconciliationInput, entry: StoredBalance, reference: LedgerBalance): RootCauseHint {
  if (fractionDigits(entry.balance) > STELLAR_DECIMALS || fractionDigits(reference.balance) > STELLAR_DECIMALS) {
    return cause(
      "precision_mismatch",
      "likely",
      `One side carries more than ${STELLAR_DECIMALS} decimal places; the amount was probably converted through a float or a different scale.`,
      [`stored_places=${fractionDigits(entry.balance)}`, `ledger_places=${fractionDigits(reference.balance)}`]
    );
  }
  const cachedAt = entry.cachedAt === undefined ? Number.NaN : Date.parse(entry.cachedAt);
  if (!Number.isFinite(cachedAt)) {
    return cause(
      "cache_age_unknown",
      "possible",
      "The cached line has no usable cachedAt, so it cannot be told apart from an ordinary stale cache. Record cachedAt at the write site.",
      ["cached_at=unknown"]
    );
  }
  const age = input.now - cachedAt;
  if (age > staleAfterOf(input)) {
    return cause(
      "cache_stale",
      "likely",
      `The line was cached ${Math.round(age / 1_000)}s ago, longer than the staleness window; the ledger has most likely moved since.`,
      [`cache_age_s=${Math.round(age / 1_000)}`, `reference=${reference.reference}`]
    );
  }
  return cause(
    "write_race",
    "possible",
    "The line was cached recently and still disagrees: a ledger close between the read and the cache write, or a read from a different network, is the likely window.",
    [`cache_age_s=${Math.max(0, Math.round(age / 1_000))}`, `reference=${reference.reference}`]
  );
}


function defaultSeverity(kind: FindingKind): FindingSeverity {
  switch (kind) {
    case "inconsistent":
      return "critical";
    case "duplicate":
      return "warning";
    case "stale":
      return "warning";
    case "missing":
      return "info";
  }
}

type Check = (input: ReconciliationInput) => ReconciliationFinding[];

const checks: { invariant: string; run: Check }[] = [
  {
    invariant: "balance.ledger_entry_present",
    run: (input) => {
      const seen = new Set(input.ledgerBalances.map((entry) => balanceKey(entry)));
      return input.storedBalances
        .filter((entry) => !seen.has(balanceKey(entry)))
        .map((entry) =>
          finding(
            "balance.ledger_entry_present",
            "stored_balance",
            balanceKey(entry),
            `No ledger entry for ${entry.asset} on ${entry.account}; the stored line cannot be settled.`,
            { rootCause: missingLedgerCause(input, entry) }
          )
        );
    }
  },
  {
    invariant: "balance.amount_agrees",
    run: (input) => {
      const ledger = new Map(input.ledgerBalances.map((entry) => [balanceKey(entry), entry]));
      const findings: ReconciliationFinding[] = [];
      for (const entry of input.storedBalances) {
        const reference = ledger.get(balanceKey(entry));
        if (!reference) continue;
        if (!amountsEqual(entry.balance, reference.balance)) {
          findings.push(
            finding(
              "balance.amount_agrees",
              "stored_balance",
              balanceKey(entry),
              `Stored ${entry.asset} balance disagrees with ledger reference ${reference.reference}.`,
              { expected: reference.balance, observed: entry.balance, rootCause: amountDriftCause(input, entry, reference) }
            )
          );
        }
      }
      return findings;
    }
  },
  {
    invariant: "balance.single_line_per_asset",
    run: (input) => duplicates(input.storedBalances, balanceKey).map((entry) => {
      const lines = input.storedBalances.filter((line) => balanceKey(line) === balanceKey(entry));
      const amounts = new Set(lines.map((line) => line.balance.trim()));
      const rootCause =
        amounts.size > 1
          ? cause(
              "concurrent_cache_write",
              "likely",
              "The duplicate lines hold different amounts, so two writers cached the same asset at different times without a uniqueness guard.",
              [`lines=${lines.length}`, `distinct_amounts=${amounts.size}`]
            )
          : cause(
              "duplicate_write_path",
              "possible",
              "The duplicate lines are identical; one write path most likely appended instead of replacing.",
              [`lines=${lines.length}`]
            );
      return finding(
        "balance.single_line_per_asset",
        "stored_balance",
        balanceKey(entry),
        `Asset held on more than one line for ${entry.account}.`,
        { rootCause }
      );
    })
  },
  {
    invariant: "worker_job.state_declared",
    run: (input) =>
      input.jobs
        .filter((job) => !workerJobMachine.isState(job.status))
        .map((job) =>
          finding("worker_job.state_declared", "worker_job", job.id, "Job status is not a declared lifecycle state.", {
            observed: String(job.status),
            rootCause:
              LEGACY_JOB_STATUSES[String(job.status)] !== undefined
                ? cause(
                    "legacy_status",
                    "likely",
                    `"${String(job.status)}" is a status an older or newer build wrote; it maps to ${LEGACY_JOB_STATUSES[String(job.status)]} in the current lifecycle.`,
                    [`maps_to=${LEGACY_JOB_STATUSES[String(job.status)]}`]
                  )
                : cause(
                    "bypassed_lifecycle",
                    "possible",
                    "A write site set the status directly instead of applying a lifecycle event."
                  )
          })
        )
  },
  {
    invariant: "worker_job.budget_consistent",
    run: (input) =>
      input.jobs
        .filter(
          (job) =>
            workerJobMachine.isState(job.status) &&
            !workerJobMachine.isTerminal(job.status) &&
            job.attempts >= job.maxAttempts
        )
        .map((job) =>
          finding(
            "worker_job.budget_consistent",
            "worker_job",
            job.id,
            `Job used all ${job.maxAttempts} attempts but is still ${job.status}.`,
            {
              expected: "a terminal state",
              observed: job.status,
              rootCause: job.lastError
                ? cause(
                    "handler_failing",
                    "likely",
                    "The handler keeps failing and the exhaust transition was never applied after the last attempt.",
                    [`last_error=${job.lastError.code}`, `attempts=${job.attempts}`]
                  )
                : cause(
                    "attempt_counter_drift",
                    "possible",
                    "The attempt counter reached the budget with no recorded error, so the counter was probably advanced outside the worker.",
                    [`attempts=${job.attempts}`, `max_attempts=${job.maxAttempts}`]
                  )
            }
          )
        )
  },
  {
    invariant: "worker_job.dedupe_unique",
    run: (input) => {
      const pending = input.jobs.filter((job) => job.status === "queued" || job.status === "retrying");
      return duplicates(pending.filter((job) => job.dedupeKey !== undefined), (job) => job.dedupeKey!).map(
        (job) => {
          const twins = pending.filter((other) => other.dedupeKey === job.dedupeKey && other.id !== job.id);
          const sameRequest = twins.some((other) => other.correlationId === job.correlationId);
          return finding("worker_job.dedupe_unique", "worker_job", job.id, `Two pending jobs share dedupe key ${job.dedupeKey}.`, {
            observed: job.dedupeKey,
            rootCause: sameRequest
              ? cause(
                  "double_submit",
                  "likely",
                  "Both jobs carry the same correlation id, so one request enqueued twice — usually a retried submit without an idempotency key.",
                  [`pending_with_key=${twins.length + 1}`]
                )
              : cause(
                  "missing_idempotency_key",
                  "possible",
                  "Two independent enqueue paths used the same dedupe key; the dedupe check raced because neither path claimed an idempotency key.",
                  [`pending_with_key=${twins.length + 1}`]
                )
          });
        }
      );
    }
  },
  {
    invariant: "worker_job.progress",
    run: (input) => {
      const staleAfter = staleAfterOf(input);
      const pending = input.jobs.filter((job) => job.status === "queued" || job.status === "retrying");
      const stale = pending.filter((job) => {
        const reference = job.nextAttemptAt ?? job.enqueuedAt;
        const at = Date.parse(reference);
        return Number.isFinite(at) && input.now - at > staleAfter;
      });
      // When every pending job is overdue nothing is draining the queue; one
      // overdue job among moving ones is a scheduling gap for that job alone.
      const queueStalled = stale.length > 1 && stale.length === pending.length;
      return stale.map((job) =>
        finding(
          "worker_job.progress",
          "worker_job",
          job.id,
          `Job has been ${job.status} past its deadline.`,
          {
            observed: job.status,
            rootCause: queueStalled
              ? cause(
                  "scheduler_not_draining",
                  "likely",
                  "Every pending job is past its deadline, so no worker is draining the queue; check the scheduler before touching any single job.",
                  [`stale=${stale.length}`, `pending=${pending.length}`]
                )
              : job.status === "retrying"
                ? cause(
                    "backoff_not_rescheduled",
                    "possible",
                    "Other jobs are moving, so this one's retry was most likely never rescheduled after its backoff elapsed.",
                    [`attempts=${job.attempts}`]
                  )
                : cause(
                    "job_not_picked_up",
                    "possible",
                    "Other jobs are moving, so this job was probably enqueued with a delay or to an operation no handler is registered for.",
                    [`operation=${job.operation}`]
                  )
          }
        )
      );
    }
  },
  {
    invariant: "idempotency.claim_fresh",
    run: (input) => {
      const findings: ReconciliationFinding[] = [];
      for (const record of input.idempotencyRecords) {
        const expiresAt = Date.parse(record.expiresAt);
        if (!Number.isFinite(expiresAt)) continue;
        if (input.now > expiresAt) {
          findings.push(
            finding(
              "idempotency.claim_fresh",
              "idempotency_record",
              record.key,
              `Expired ${record.status} record was never swept.`,
              {
                expected: "swept",
                observed: record.status,
                rootCause: cause(
                  "sweep_not_scheduled",
                  "likely",
                  "The record outlived its TTL, so idempotency.sweep() has not run since it expired.",
                  [`expired_s=${Math.round((input.now - expiresAt) / 1_000)}`]
                )
              }
            )
          );
        } else if (record.status === "in_flight" && input.now > Date.parse(record.createdAt) && record.replays === 0) {
          findings.push(
            finding("idempotency.claim_fresh", "idempotency_record", record.key, "Claim never settled.", {
              rootCause: cause(
                "claim_abandoned",
                "possible",
                "The claim is still in flight with no replay; the process that claimed it most likely crashed before recording an outcome. The work may still be running.",
                [`operation=${record.operation}`]
              )
            })
          );
        }
      }
      return findings;
    }
  },
  {
    invariant: "export_envelope.count_matches",
    run: (input) =>
      input.exportEnvelopes
        .filter((envelope) => envelope.recordCount !== envelope.records.length)
        .map((envelope) =>
          finding(
            "export_envelope.count_matches",
            "export_envelope",
            envelope.correlationId,
            "Envelope recordCount does not match the records it carries.",
            {
              expected: String(envelope.records.length),
              observed: String(envelope.recordCount),
              rootCause:
                envelope.records.length < envelope.recordCount
                  ? cause(
                      "truncated_write",
                      "likely",
                      "The envelope carries fewer records than it declares, so the write was cut off after the header was sealed.",
                      [`missing_records=${envelope.recordCount - envelope.records.length}`]
                    )
                  : cause(
                      "count_not_updated",
                      "likely",
                      "The envelope carries more records than it declares, so records were appended after the header was sealed.",
                      [`extra_records=${envelope.records.length - envelope.recordCount}`]
                    )
            }
          )
        )
  },
  {
    invariant: "export_envelope.retention",
    run: (input) =>
      input.exportEnvelopes
        .filter((envelope) => {
          const expiresAt = Date.parse(envelope.expiresAt);
          return Number.isFinite(expiresAt) && input.now > expiresAt;
        })
        .map((envelope) =>
          finding("export_envelope.retention", "export_envelope", envelope.correlationId, "Envelope is past its expiry and still stored.", {
            rootCause: cause(
              "retention_sweep_missing",
              "likely",
              "The envelope passed expiresAt and was never expired through its lifecycle, so the retention sweep is not running."
            )
          })
        )
  },
  {
    invariant: "notification.state_declared",
    run: (input) =>
      input.notifications
        .filter((notification) => !notificationMachine.isState(notification.state))
        .map((notification) =>
          finding("notification.state_declared", "notification", notification.id, "Notification state is not declared.", {
            observed: String(notification.state),
            rootCause: cause(
              "bypassed_lifecycle",
              "likely",
              "A write site set the state directly instead of applying a notification lifecycle event."
            )
          })
        )
  },
  {
    invariant: "notification.identity_unique",
    run: (input) => duplicates(input.notifications, (notification) => `${notification.recipient}|${notification.id}`).map(
      (notification) =>
        finding("notification.identity_unique", "notification", notification.id, "Two entries share one notification id.", {
          rootCause: cause(
            "double_publish",
            "likely",
            "The same notification was published twice for one recipient, usually two workflows reacting to one event without a shared dedupe key."
          )
        })
    )
  },
  {
    invariant: "operation.settles",
    run: (input) => {
      const staleAfter = staleAfterOf(input);
      return input.operations
        .filter((record) => {
          if (operationMachine.isTerminal(record.state)) return false;
          if (!operationMachine.isState(record.state)) return true;
          const at = Date.parse(record.startedAt);
          return Number.isFinite(at) && input.now - at > staleAfter;
        })
        .map((record) =>
          finding("operation.settles", "operation", record.id, `Operation ${record.op} never settled.`, {
            observed: record.state,
            rootCause: operationMachine.isState(record.state)
              ? cause(
                  "process_interrupted",
                  "possible",
                  "The operation started and never recorded an outcome; the tab or process was most likely closed mid-flight."
                )
              : cause("unknown_state", "likely", "The operation carries a state the operation lifecycle does not declare.")
          })
        );
    }
  }
];

function balanceKey(entry: { account: string; asset: string }): string {
  return `${entry.account}|${entry.asset}`;
}

function duplicates<T>(items: readonly T[], key: (item: T) => string): T[] {
  const counts = new Map<string, number>();
  const repeats: T[] = [];
  for (const item of items) {
    const id = key(item);
    const count = (counts.get(id) ?? 0) + 1;
    counts.set(id, count);
    if (count > 1) repeats.push(item);
  }
  return repeats;
}

function countOf(items: readonly { kind: FindingKind }[], kind: FindingKind): number {
  return items.filter((item) => item.kind === kind).length;
}

function emptySnapshot(): ReconciliationInput {
  return {
    storedBalances: [],
    ledgerBalances: [],
    jobs: [],
    notifications: [],
    idempotencyRecords: [],
    exportEnvelopes: [],
    operations: [],
    now: 0
  };
}

function isSnapshot(value: unknown): value is ReconciliationInput {
  if (!value || typeof value !== "object") return false;
  const input = value as Partial<ReconciliationInput>;
  return (
    Array.isArray(input.storedBalances) &&
    Array.isArray(input.ledgerBalances) &&
    Array.isArray(input.jobs) &&
    Array.isArray(input.notifications) &&
    Array.isArray(input.idempotencyRecords) &&
    Array.isArray(input.exportEnvelopes) &&
    Array.isArray(input.operations) &&
    typeof input.now === "number"
  );
}

/**
 * Runs every check against a snapshot and returns the report. Pure: the input
 * is only read, and `dryRun` is always true because no write path exists.
 */
export function reconcile(
  input: ReconciliationInput,
  runId = newCorrelationId()
): ReconciliationReport {
  const snapshot: ReconciliationInput = isSnapshot(input) ? input : emptySnapshot();
  const startedAt = new Date(snapshot.now).toISOString();

  const findings: ReconciliationFinding[] = [];
  const results: CheckResult[] = [];
  for (const check of checks) {
    const before = findings.length;
    for (const entry of check.run(snapshot)) findings.push(entry);
    results.push({
      invariant: check.invariant,
      checked: countsFor(check.invariant, snapshot),
      findings: findings.length - before
    });
  }

  const summary = {
    missing: countOf(findings, "missing"),
    duplicate: countOf(findings, "duplicate"),
    stale: countOf(findings, "stale"),
    inconsistent: countOf(findings, "inconsistent"),
    total: findings.length
  };

  return {
    runId,
    startedAt,
    finishedAt: new Date(snapshot.now).toISOString(),
    dryRun: true,
    checks: results,
    // Redacted at the boundary: a finding's detail can quote a stored value.
    findings: redact(findings) as ReconciliationFinding[],
    summary,
    clean: !findings.some((entry) => entry.severity === "critical")
  };
}

function countsFor(invariant: string, input: ReconciliationInput): number {
  switch (invariant) {
    case "balance.ledger_entry_present":
    case "balance.amount_agrees":
      return input.storedBalances.length;
    case "balance.single_line_per_asset":
      return input.storedBalances.length;
    case "worker_job.state_declared":
    case "worker_job.budget_consistent":
    case "worker_job.progress":
      return input.jobs.length;
    case "worker_job.dedupe_unique":
      return input.jobs.filter((job) => job.dedupeKey !== undefined).length;
    case "idempotency.claim_fresh":
      return input.idempotencyRecords.length;
    case "export_envelope.count_matches":
    case "export_envelope.retention":
      return input.exportEnvelopes.length;
    case "notification.state_declared":
    case "notification.identity_unique":
      return input.notifications.length;
    case "operation.settles":
      return input.operations.length;
    default:
      return 0;
  }
}

/** A stable, line-oriented rendering for CI logs and a maintainer review. */
export function formatReport(report: ReconciliationReport): string {
  const lines = [
    `reconciliation ${report.runId} (dry run)`,
    `  checked ${report.checks.length} invariants, ${report.summary.total} finding(s)`,
    `  missing=${report.summary.missing} duplicate=${report.summary.duplicate} ` +
      `stale=${report.summary.stale} inconsistent=${report.summary.inconsistent}`,
    ""
  ];

  if (report.findings.length === 0) {
    lines.push("  no drift detected");
    return lines.join("\n");
  }

  for (const entry of report.findings) {
    lines.push(`  [${entry.severity}] ${entry.kind} ${entry.invariant} (${entry.subject} ${entry.recordId})`);
    lines.push(`      ${entry.detail}`);
    if (entry.expected !== undefined || entry.observed !== undefined) {
      lines.push(`      expected ${entry.expected ?? "-"} / observed ${entry.observed ?? "-"}`);
    }
    if (entry.rootCause) {
      lines.push(`      cause: ${entry.rootCause.code} (${entry.rootCause.confidence}) ${entry.rootCause.hint}`);
    }
    lines.push(`      repair: ${entry.repair}`);
  }
  return lines.join("\n");
}

/** Emits one structured record per run; the sink sees no store contents. */
export function emitReconciliationTelemetry(report: ReconciliationReport): void {
  emitTelemetry({
    op: "reconciliation.dry_run",
    actorType: "worker",
    result: report.clean ? "success" : "failure",
    correlationId: report.runId,
    errorCode: report.clean ? undefined : "reconciliation_drift",
    payload: {
      invariants: report.checks.length,
      findings: report.summary.total,
      ...report.summary
    }
  });
}
