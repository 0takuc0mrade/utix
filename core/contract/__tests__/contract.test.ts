import { describe, expect, it } from "vitest";
import {
  TELEMETRY_FIELDS,
  measure,
  newCorrelationId,
  resetTelemetrySink,
  setTelemetrySink,
  type TelemetryEvent
} from "@/core/telemetry/telemetry";
import { classifyHorizonError } from "@/core/horizon/errors";
import { createWorkerFramework, type JobPayload } from "@/core/workers/queue";
import { ok } from "@/core/result/result";
import {
  EXPORT_CURRENT_SCHEMA_VERSION,
  exportRecords,
  type ExportRecordSource
} from "@/core/export/exporter";
import type { FeatureManifest } from "@/core/registry/types";
import { stateView, workerJobMachine } from "@/core/lifecycle/records";
import { createIdempotencyStore } from "@/core/idempotency/idempotency";
import { reconcile, type ReconciliationInput } from "@/core/reconciliation/reconciliation";
import { planRepairs } from "@/core/reconciliation/repair";
import { getAuditTrail, recordAudit, SENSITIVE_ACTIONS } from "@/core/audit/audit";
import { manifest as paymentQrManifest } from "@/features/payment-qr/manifest";
import {
  assertContract,
  contractOperation,
  validateContract
} from "@/core/contract/contract";

const V = "1.0";

// The five contracts documented in docs/API_CONTRACT.md, kept in lockstep with
// the real modules below. When a module changes a shape used by consumers,
// this file must change too — which is the point of a drift test.

const telemetryContract = contractOperation("telemetry.event", {
  version: V,
  fields: {
    op: { type: "string", required: true },
    actorType: { type: "string", required: true },
    result: { type: "string", required: true },
    latencyMs: { type: "number", required: true },
    correlationId: { type: "string", required: true }
  }
});

const horizonErrorContract = contractOperation("horizon.error", {
  version: V,
  fields: {
    code: { type: "string", required: true },
    detail: { type: "object", required: true },
    "detail.status": { type: "number", required: false }
  }
});

const workerJobContract = contractOperation("worker.job", {
  version: V,
  fields: {
    id: { type: "string", required: true },
    operation: { type: "string", required: true },
    attempts: { type: "number", required: true },
    status: { type: "string", required: true },
    enqueuedAt: { type: "string", required: true },
    correlationId: { type: "string", required: true }
  }
});

const exportEnvelopeContract = contractOperation("export.envelope", {
  version: V,
  fields: {
    schemaVersion: { type: "string", required: true },
    generatedAt: { type: "string", required: true },
    expiresAt: { type: "string", required: true },
    generator: { type: "string", required: true },
    correlationId: { type: "string", required: true },
    recordCount: { type: "number", required: true },
    totalRecords: { type: "number", required: true },
    records: { type: "array", required: true }
  }
});

const lifecycleStateContract = contractOperation("lifecycle.state", {
  version: V,
  fields: {
    kind: { type: "string", required: true },
    state: { type: "string", required: true },
    label: { type: "string", required: true },
    tone: { type: "string", required: true },
    terminal: { type: "boolean", required: true },
    allowedEvents: { type: "array", required: true }
  }
});

const idempotencyRecordContract = contractOperation("idempotency.record", {
  version: V,
  fields: {
    key: { type: "string", required: true },
    operation: { type: "string", required: true },
    requestHash: { type: "string", required: true },
    status: { type: "string", required: true },
    createdAt: { type: "string", required: true },
    expiresAt: { type: "string", required: true },
    replays: { type: "number", required: true },
    correlationId: { type: "string", required: true }
  }
});

const reconciliationReportContract = contractOperation("reconciliation.report", {
  version: V,
  fields: {
    runId: { type: "string", required: true },
    startedAt: { type: "string", required: true },
    finishedAt: { type: "string", required: true },
    dryRun: { type: "boolean", required: true },
    checks: { type: "array", required: true },
    findings: { type: "array", required: true },
    clean: { type: "boolean", required: true },
    "summary.total": { type: "number", required: true },
    "summary.inconsistent": { type: "number", required: true },
    "findings.0.invariant": { type: "string", required: false },
    "findings.0.repair": { type: "string", required: false },
    // Additive: present when the snapshot held evidence for a cause.
    "findings.0.rootCause.code": { type: "string", required: false },
    "findings.0.rootCause.confidence": { type: "string", required: false }
  }
});

const repairPlanContract = contractOperation("reconciliation.repair_plan", {
  version: V,
  fields: {
    planId: { type: "string", required: true },
    runId: { type: "string", required: true },
    createdAt: { type: "string", required: true },
    expiresAt: { type: "string", required: true },
    dryRun: { type: "boolean", required: true },
    actions: { type: "array", required: true },
    manual: { type: "array", required: true },
    fingerprint: { type: "string", required: true },
    "summary.actions": { type: "number", required: true },
    "summary.manual": { type: "number", required: true },
    "actions.0.id": { type: "string", required: false },
    "actions.0.kind": { type: "string", required: false },
    "actions.0.reversible": { type: "boolean", required: false }
  }
});

const auditEventContract = contractOperation("audit.event", {
  version: V,
  fields: {
    id: { type: "string", required: true },
    action: { type: "string", required: true },
    actorId: { type: "string", required: true },
    scope: { type: "string", required: true },
    outcome: { type: "string", required: true },
    at: { type: "string", required: true },
    correlationId: { type: "string", required: true },
    "actor.kind": { type: "string", required: true },
    "target.kind": { type: "string", required: true },
    "target.id": { type: "string", required: true },
    reason: { type: "string", required: false },
    errorCode: { type: "string", required: false }
  }
});

const featureManifestContract = contractOperation("feature.manifest", {
  version: V,
  fields: {
    slug: { type: "string", required: true },
    title: { type: "string", required: true },
    description: { type: "string", required: true },
    category: { type: "string", required: true },
    status: { type: "string", required: true }
  }
});

async function realTelemetryEvent(): Promise<TelemetryEvent> {
  let seen: TelemetryEvent | undefined;
  setTelemetrySink({ emit: (event) => (seen = event) });

  const correlationId = newCorrelationId();
  await measure("horizon.request", { actorType: "client", correlationId }, () => ok(true));
  resetTelemetrySink();

  if (!seen) throw new Error("no telemetry emitted");
  return seen;
}

describe("contract drift tests", () => {
  it("locks the telemetry record shape to what the module emits", async () => {
    const record = await realTelemetryEvent();
    expect(TELEMETRY_FIELDS.every((field) => field in record)).toBe(true);
    expect(assertContract(telemetryContract, () => record).ok).toBe(true);
  });

  it("locks the horizon error classification shape", () => {
    const classified = classifyHorizonError({ response: { status: 429 } });
    expect(assertContract(horizonErrorContract, () => classified).ok).toBe(true);
  });

  it("locks the worker job payload shape", () => {
    const framework = createWorkerFramework();
    const job: JobPayload = framework.enqueue({ operation: "demo.run" });
    expect(assertContract(workerJobContract, () => job).ok).toBe(true);
  });

  it("locks the export envelope shape", () => {
    const source: ExportRecordSource = {
      recordType: "operation_log",
      schemaVersion: EXPORT_CURRENT_SCHEMA_VERSION,
      scope: "own",
      collect: () => [{ op: "wallet.detect", result: "success" }]
    };
    const result = exportRecords(
      { schemaVersion: EXPORT_CURRENT_SCHEMA_VERSION, scope: "own", actor: { kind: "user" } },
      [source]
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(assertContract(exportEnvelopeContract, () => result.value).ok).toBe(true);
  });

  it("locks the feature manifest shape", () => {
    const manifest: FeatureManifest = paymentQrManifest;
    expect(assertContract(featureManifestContract, () => manifest).ok).toBe(true);
  });

  it("locks the lifecycle state view the UI and the API both render", () => {
    // The same object a component would use for a badge.
    expect(assertContract(lifecycleStateContract, () => stateView("worker_job", "retrying")).ok).toBe(
      true
    );
    // And it is derived from the table, not from a hand-written label map.
    const terminal = stateView("worker_job", "succeeded");
    expect(terminal.terminal).toBe(workerJobMachine.isTerminal("succeeded"));
    expect(terminal.allowedEvents).toEqual(workerJobMachine.allowedEvents("succeeded"));
  });

  it("locks the idempotency record a retried write replays", () => {
    const store = createIdempotencyStore();
    store.begin({ key: "contract-key-01", operation: "export.generate", request: { page: 1 } });
    const completed = store.complete("contract-key-01", { recordCount: 0 });
    expect(completed.ok).toBe(true);
    if (!completed.ok) return;
    expect(assertContract(idempotencyRecordContract, () => completed.value).ok).toBe(true);
  });

  it("locks the reconciliation report shape", () => {
    const drift: ReconciliationInput = {
      storedBalances: [{ account: "G1", asset: "USDC", balance: "10.50" }],
      ledgerBalances: [{ account: "G1", asset: "USDC", balance: "10.51", reference: "ledger:100" }],
      jobs: [],
      notifications: [],
      idempotencyRecords: [],
      exportEnvelopes: [],
      operations: [],
      now: Date.parse("2026-09-26T00:00:00.000Z")
    };
    const report = reconcile(drift);
    expect(report.dryRun).toBe(true);
    expect(assertContract(reconciliationReportContract, () => report).ok).toBe(true);
  });

  it("locks the reconciliation repair plan shape", () => {
    const drift: ReconciliationInput = {
      storedBalances: [{ account: "G1", asset: "USDC", balance: "10.50" }],
      ledgerBalances: [{ account: "G1", asset: "USDC", balance: "10.51", reference: "ledger:100" }],
      jobs: [],
      notifications: [],
      idempotencyRecords: [],
      exportEnvelopes: [],
      operations: [],
      now: Date.parse("2026-09-26T00:00:00.000Z")
    };
    const plan = planRepairs(reconcile(drift), drift);
    expect(plan.dryRun).toBe(true);
    expect(plan.actions[0]?.kind).toBe("recache_balance");
    expect(assertContract(repairPlanContract, () => plan).ok).toBe(true);
  });

  it("locks the audit event shape to what the trail records", () => {
    getAuditTrail().reset();
    const event = recordAudit({
      action: "record.state_changed",
      actor: { kind: "maintainer", id: "ada" },
      scope: "maintainer",
      target: { kind: "worker_job", id: "job-1" },
      reason: "manual_dead_letter",
      before: { state: "retrying" },
      after: { state: "dead_lettered", event: "dead_letter" },
      at: "2026-09-26T00:00:00.000Z"
    });

    expect(event).toBeDefined();
    expect(assertContract(auditEventContract, () => event!).ok).toBe(true);

    // The action list is part of the contract: it is what coverage means.
    expect(SENSITIVE_ACTIONS).toContain("record.state_changed");
    getAuditTrail().reset();
  });

  it("detects a drifted response that drops a required field", () => {
    const drifted = { detail: {}, status: 200 }; // `code` is required
    expect(validateContract(drifted, horizonErrorContract.schema).ok).toBe(false);
    expect(assertContract(horizonErrorContract, () => drifted).ok).toBe(false);
  });
});