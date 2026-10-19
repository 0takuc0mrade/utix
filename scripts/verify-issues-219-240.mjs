#!/usr/bin/env node
/**
 * Automated Verification Test Suite for Issues #219, #223, #226, #240
 *
 * Verifies all 4 hard contributor assignments:
 * - Issue #219: Cross-service contract map for domain events and integration boundaries
 * - Issue #223: Feature-flag rollout guard with automatic rollback verification
 * - Issue #226: Risk-scored abuse detection for suspicious high-impact operations
 * - Issue #240: Storage schema compatibility checks for the next schema version
 *
 * Usage:
 *   node --loader ./scripts/loader.mjs scripts/verify-issues-219-240.mjs
 */

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

console.log("============================================================");
console.log("   AUTOMATED VERIFICATION: ISSUES #219, #223, #226, #240    ");
console.log("============================================================\n");

// -------------------------------------------------------------
// TEST 1: ISSUE #219 - Cross-Service Contract Map
// -------------------------------------------------------------
console.log("--> Testing Issue #219: Cross-Service Contract Map...");
const {
  verifyCrossServiceContractMap,
  getContractDefinition,
  getContractsByProducer,
  getContractsByConsumer,
  validateEventContractPayload,
  listAllContracts
} = await import("../core/contract/contract-map.ts");

// 1. Verify contract map registry completeness
const mapVerification = verifyCrossServiceContractMap();
assert.equal(mapVerification.ok, true, "Cross-service contract map must be complete and valid");
assert.equal(mapVerification.value.valid, true);
assert.ok(mapVerification.value.totalContracts >= 10, "Must define at least 10 core event/boundary contracts");
assert.ok(mapVerification.value.producersCount >= 5, "Must declare at least 5 distinct producers");
assert.ok(mapVerification.value.consumersCount >= 5, "Must declare at least 5 distinct consumers");

// 2. Validate specific contract definitions
const telemetryContract = getContractDefinition("telemetry.event");
assert.ok(telemetryContract, "telemetry.event contract must exist");
assert.equal(telemetryContract.producer, "core/telemetry");
assert.equal(telemetryContract.failurePolicy.allowedFailureBehavior, "fail_silent");

const workerContract = getContractDefinition("worker.job");
assert.ok(workerContract, "worker.job contract must exist");
assert.equal(workerContract.idempotency.required, true);
assert.equal(workerContract.failurePolicy.allowedFailureBehavior, "retry_and_dead_letter");
assert.equal(workerContract.failurePolicy.deadLetterQueue, true);

// 3. Payload validation: success path
const validTelemetry = {
  op: "horizon.request",
  actorType: "client",
  result: "success",
  latencyMs: 142,
  correlationId: "corr-test-1",
  timestamp: "2026-10-19T10:00:00.000Z"
};
const telRes = validateEventContractPayload("telemetry.event", validTelemetry);
assert.equal(telRes.ok, true, "Compliant telemetry payload must pass contract validation");

// 4. Payload validation: missing required field
const invalidTelemetry = {
  op: "horizon.request",
  result: "success"
};
const invTelRes = validateEventContractPayload("telemetry.event", invalidTelemetry);
assert.equal(invTelRes.ok, false);
assert.equal(invTelRes.code, "missing_required_field");

// 5. Payload validation: wrong type
const wrongTypeTelemetry = {
  op: "horizon.request",
  actorType: "client",
  result: "success",
  latencyMs: "not-a-number",
  correlationId: "corr-test-1",
  timestamp: "2026-10-19T10:00:00.000Z"
};
const wrongTypeRes = validateEventContractPayload("telemetry.event", wrongTypeTelemetry);
assert.equal(wrongTypeRes.ok, false);
assert.equal(wrongTypeRes.code, "wrong_type");

// 6. Version negotiation & future version rejection
const futureVerRes = validateEventContractPayload("telemetry.event", validTelemetry, {
  requestedVersion: "99.0"
});
assert.equal(futureVerRes.ok, false);
assert.equal(futureVerRes.code, "schema_future");

console.log("    [PASS] Cross-Service Contract Map verified (definitions, schemas, version rules, failure policies)\n");

// -------------------------------------------------------------
// TEST 2: ISSUE #223 - Feature-Flag Rollout Guard & Rollback
// -------------------------------------------------------------
console.log("--> Testing Issue #223: Feature-Flag Rollout Guard & Rollback Verification...");
const {
  createRolloutGuard
} = await import("../core/feature-flags/rollout-guard.ts");
const {
  isFeatureEnabled,
  clearEmergencyDisable,
  resetRolloutEngine
} = await import("../core/feature-flags/flags.ts");

resetRolloutEngine();

const mockState = {
  workerJobs: [
    { id: "job-1", status: "completed", flag: "sorobanDiagnosticEngine" },
    { id: "job-2", status: "running", flag: "sorobanDiagnosticEngine" } // stranded job!
  ]
};

const guard = createRolloutGuard(
  {
    flag: "sorobanDiagnosticEngine",
    riskTier: "critical",
    percentage: 10,
    allowedNetworks: ["testnet"],
    errorThresholdPercent: 50,
    maxConsecutiveFailures: 3,
    minSamples: 10
  },
  {
    stateProvider: () => mockState,
    consistencyChecks: [
      {
        name: "no_stranded_jobs",
        description: "Verify no worker jobs remain in 'running' state after rollback",
        check: (state) => {
          const stranded = state.workerJobs.filter((j) => j.status === "running" && j.flag === "sorobanDiagnosticEngine");
          return {
            valid: stranded.length === 0,
            violation: `${stranded.length} stranded jobs detected in running state`
          };
        },
        remediate: (state) => {
          state.workerJobs = state.workerJobs.filter((j) => !(j.status === "running" && j.flag === "sorobanDiagnosticEngine"));
          return {
            remediated: true,
            details: "Purged stranded running worker jobs"
          };
        }
      }
    ]
  }
);

// 1. Initial State: Flag is enabled for testnet context
assert.equal(guard.isTripped(), false, "Guard must start untripped");
guard.recordSuccess();
guard.recordSuccess();
const initialMetrics = guard.getMetrics();
assert.equal(initialMetrics.successes, 2);
assert.equal(initialMetrics.failures, 0);

// 2. Anomaly Breach: 3 consecutive failures trigger automatic rollback
const f1 = guard.recordFailure("Transient RPC timeout");
assert.equal(f1, null, "1st failure should not trip");
const f2 = guard.recordFailure("Transient RPC timeout");
assert.equal(f2, null, "2nd failure should not trip");

const rollbackReport = guard.recordFailure("Fatal Soroban VM panic");
assert.ok(rollbackReport, "3rd consecutive failure must trigger automatic rollback");
assert.equal(rollbackReport.rollbackTriggered, true);
assert.equal(guard.isTripped(), true, "Guard must be tripped");

// 3. Post-Rollback Feature Status: Must be disabled
assert.equal(isFeatureEnabled("sorobanDiagnosticEngine"), false, "Feature flag must be disabled post-rollback");
assert.equal(guard.isEnabled(), false, "Guard must return false post-rollback");

// 4. Post-Rollback State Verification & Remediation
assert.equal(rollbackReport.postRollbackFlagDisabled, true);
assert.equal(rollbackReport.violations.length, 1, "Must detect the stranded running job");
assert.equal(rollbackReport.remediationsApplied.length, 1, "Must remediate the stranded running job");
assert.equal(rollbackReport.stateConsistent, true, "State must be verified consistent after remediation");
assert.equal(mockState.workerJobs.length, 1, "Stranded job must have been cleaned up");

console.log("    [PASS] Rollout Guard & Automatic Rollback Verification verified (scoping, monitoring, tripping, remediation)\n");

// -------------------------------------------------------------
// TEST 3: ISSUE #226 - Risk-Scored Abuse Detection
// -------------------------------------------------------------
console.log("--> Testing Issue #226: Risk-Scored Abuse Detection...");
const {
  evaluateAbuseRisk,
  getAbuseAssessment,
  overrideAbuseAssessment,
  resetAbuseAssessmentStore
} = await import("../core/security/abuse-detection.ts");

resetAbuseAssessmentStore();

const USER_ALICE = { kind: "user", id: "G_ALICE" };
const MAINTAINER_BOB = { kind: "maintainer", id: "G_MAINTAINER_BOB" };

// 1. Zero friction for legitimate low-risk operations
const lowRisk1 = evaluateAbuseRisk({
  operation: "address.validate",
  actor: USER_ALICE
});
assert.equal(lowRisk1.score, 0, "Address validation must have 0 risk score");
assert.equal(lowRisk1.action, "allow");
assert.equal(lowRisk1.requiredStepUp, "none");

const lowRisk2 = evaluateAbuseRisk({
  operation: "balance.view",
  actor: USER_ALICE
});
assert.equal(lowRisk2.score, 0, "Balance query must have 0 risk score");
assert.equal(lowRisk2.action, "allow");

// 2. High-Impact: Disabling master key weight triggers step-up
const stepUp1 = evaluateAbuseRisk({
  operation: "account.set_options",
  actor: USER_ALICE,
  payload: { masterWeight: 0 }
});
assert.ok(stepUp1.score >= 40 && stepUp1.score < 70, "Zeroing master key should score in step_up tier");
assert.equal(stepUp1.action, "step_up");
assert.equal(stepUp1.requiredStepUp, "confirm_dialog");
assert.equal(stepUp1.signals.length, 1);
assert.equal(stepUp1.signals[0].id, "disabled_master_key");

// 3. High-Impact: Destructive account merge
const mergeAssessment = evaluateAbuseRisk({
  operation: "account.merge",
  actor: USER_ALICE,
  payload: { destination: "G_DESTINATION" }
});
assert.equal(mergeAssessment.action, "step_up");
assert.equal(mergeAssessment.signals[0].id, "destructive_account_merge");

// 4. Critical: Velocity burst + suspicious action triggers review or block
const criticalAbuse = evaluateAbuseRisk({
  operation: "faucet.fund",
  actor: USER_ALICE,
  recentOperationCount: 25 // extreme burst
});
assert.ok(criticalAbuse.score >= 80, "Extreme burst on faucet must score high");
assert.ok(criticalAbuse.action === "review" || criticalAbuse.action === "block");
assert.ok(criticalAbuse.signals.length >= 2, "Must accumulate multiple explainable risk signals");

// 5. Maintainer Override of False Positive
const storedAssessment = getAbuseAssessment(criticalAbuse.evaluationId);
assert.ok(storedAssessment);
const overridden = overrideAbuseAssessment(
  criticalAbuse.evaluationId,
  "allow",
  MAINTAINER_BOB,
  "Approved load-test run by verified contributor"
);
assert.ok(overridden);
assert.equal(overridden.action, "allow");
assert.equal(overridden.overridden?.maintainerId, MAINTAINER_BOB.id);

console.log("    [PASS] Risk-Scored Abuse Detection verified (signals, progressive step-up, explainability, maintainer overrides)\n");

// -------------------------------------------------------------
// TEST 4: ISSUE #240 - Storage Schema Compatibility & Migration
// -------------------------------------------------------------
console.log("--> Testing Issue #240: Storage Schema Migration & Compatibility...");
const {
  checkStorageCompatibility,
  executeStorageSchemaMigration,
  StorageV1ToV2Migration,
  STORAGE_SCHEMA_CURRENT_VERSION,
  STORAGE_SCHEMA_NEXT_VERSION
} = await import("../core/migration/storage-schema.ts");

const validV1Records = [
  {
    id: "op-101",
    kind: "horizon_request",
    state: "completed",
    correlationId: "corr-101",
    createdAt: "2026-10-19T08:00:00.000Z",
    updatedAt: "2026-10-19T08:00:01.000Z",
    payload: { endpoint: "/accounts/G1" }
  },
  {
    id: "op-102",
    kind: "export_generate",
    state: "completed",
    correlationId: "corr-102",
    createdAt: "2026-10-19T08:05:00.000Z",
    updatedAt: "2026-10-19T08:05:02.000Z",
    payload: { scope: "own" }
  }
];

// 4.1 Authorization Path: Unauthorized user rejected
const unauthRes = await executeStorageSchemaMigration(validV1Records, {
  actor: { kind: "user", id: "G_UNAUTH" }
});
assert.equal(unauthRes.ok, false, "Unauthorized non-maintainer must be refused");
assert.equal(unauthRes.code, "permission_denied");

// 4.2 Pre-flight Compatibility Check
const compat = checkStorageCompatibility(validV1Records);
assert.equal(compat.compatible, true, "Valid V1 records must pass compatibility check");
assert.equal(compat.v1Count, 2);
assert.equal(compat.v2Count, 0);

// 4.3 Dry-Run Path
const dryRunRes = await executeStorageSchemaMigration(validV1Records, {
  actor: { kind: "maintainer", id: "G_MAINTAINER" },
  dryRun: true
});
assert.equal(dryRunRes.ok, true, "Dry-run must succeed");
assert.equal(dryRunRes.value.dryRun, true);
assert.equal(dryRunRes.value.affectedCount, 2);

// 4.4 Normal Path: Full migration V1 -> V2
const normalRes = await executeStorageSchemaMigration(validV1Records, {
  actor: { kind: "maintainer", id: "G_MAINTAINER" },
  dryRun: false
});
assert.equal(normalRes.ok, true, "Normal migration must succeed");
assert.equal(normalRes.value.fromVersion, STORAGE_SCHEMA_CURRENT_VERSION);
assert.equal(normalRes.value.toVersion, STORAGE_SCHEMA_NEXT_VERSION);
assert.equal(normalRes.value.affectedCount, 2);
assert.equal(normalRes.value.passed, true);

// 4.5 Retry Path: Idempotent re-run on already upgraded V2 records
const { transformed: v2Records } = StorageV1ToV2Migration.apply(validV1Records);
assert.equal(v2Records.length, 2);
assert.equal(v2Records[0].schemaVersion, 2);
assert.ok(v2Records[0].checksum.length >= 16);

const retryRes = await executeStorageSchemaMigration(v2Records, {
  actor: { kind: "maintainer", id: "G_MAINTAINER" },
  dryRun: false
});
assert.equal(retryRes.ok, true, "Retry must succeed idempotently");
assert.equal(retryRes.value.affectedCount, 0, "Already-migrated V2 records should not be re-transformed");
assert.equal(retryRes.value.unchangedCount, 2);

// 4.6 Failure & Rollback Path: Corrupt records trigger rejection
const corruptRecords = [
  { id: "corrupt-1", state: "completed" }, // missing required kind & createdAt
  null
];
const corruptCompat = checkStorageCompatibility(corruptRecords);
assert.equal(corruptCompat.compatible, false, "Corrupted records must fail pre-flight check");
assert.ok(corruptCompat.invalidRecords.length >= 2);

const corruptRes = await executeStorageSchemaMigration(corruptRecords, {
  actor: { kind: "maintainer", id: "G_MAINTAINER" }
});
assert.equal(corruptRes.ok, false);
assert.equal(corruptRes.code, "corrupt_record_detected");

console.log("    [PASS] Storage Schema Migration verified (normal, failure, retry, authorization paths)\n");

console.log("============================================================");
console.log("   ALL 4 ISSUES (#219, #223, #226, #240) VERIFIED [PASS]    ");
console.log("============================================================\n");
