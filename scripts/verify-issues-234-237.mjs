#!/usr/bin/env node
/**
 * Verification Test Suite for Issues #234, #235, #236, #237
 *
 * Runs automated verification of all newly implemented domain logic:
 * - Issue #234: Policy Simulation Preview
 * - Issue #235: Durable Notification Preferences & Mandatory Alert Routing
 * - Issue #236: Stale Cache & Index Detection with Automated Repair
 * - Issue #237: Release Readiness Gate
 */

import assert from "node:assert/strict";
import { evaluateReleaseReadiness } from "./release-readiness-gate.mjs";

console.log("============================================================");
console.log("   AUTOMATED VERIFICATION: ISSUES #234, #235, #236, #237    ");
console.log("============================================================\n");

// -------------------------------------------------------------
// TEST 1: ISSUE #237 - Release Readiness Gate
// -------------------------------------------------------------
console.log("--> Testing Issue #237: Release Readiness Gate...");
const readinessReport = await evaluateReleaseReadiness();
assert.equal(readinessReport.passed, true, "Release readiness report must pass all gates");
assert.equal(readinessReport.totalGates, 4, "Must have exactly 4 gates");
assert.equal(readinessReport.passedGates, 4, "All 4 gates must pass");
for (const gate of readinessReport.gates) {
  assert.equal(gate.passed, true, `Gate ${gate.name} must pass`);
}
console.log("    [PASS] Release Readiness Gate verified (4/4 gates passed)\n");

// -------------------------------------------------------------
// TEST 2: ISSUE #234 - Policy Simulation Preview
// -------------------------------------------------------------
console.log("--> Testing Issue #234: Policy Simulation Preview...");
const { PolicySimulator } = await import("../core/policy/simulation.ts");

const sampleRecords = [
  {
    id: "tx-100",
    type: "transaction",
    attributes: { feeStroops: 500, operations: ["payment", "setOptions"] }
  },
  {
    id: "tx-200",
    type: "transaction",
    attributes: { feeStroops: 2500, operations: ["accountMerge"] }
  },
  {
    id: "acc-GAAA",
    type: "account",
    attributes: { masterWeight: 0, subentryCount: 15 }
  },
  {
    id: "acc-GBBB",
    type: "account",
    attributes: { masterWeight: 20, subentryCount: 2 }
  },
  {
    id: "contract-1",
    type: "contract",
    attributes: { simulationPassed: false }
  },
  {
    id: "quota-user-1",
    type: "quota",
    attributes: { requestsPerMinute: 120 }
  }
];

// Test 2a: Read-only verification
const recordsClone = JSON.parse(JSON.stringify(sampleRecords));
const simReport = PolicySimulator.simulate(
  {
    id: "pol-test-1",
    name: "Standard Guardrails",
    description: "Applies basic fee and weight constraints",
    scope: "global",
    version: 1,
    rules: [],
    parameters: { maxBaseFeeStroops: 1000, minMasterWeight: 1 }
  },
  sampleRecords
);
assert.equal(simReport.isReadOnlyVerified, true, "Simulation must be read-only");
assert.deepEqual(sampleRecords, recordsClone, "Target records must not be mutated");

// Test 2b: Fee limits & disallowed operations
const strictSim = PolicySimulator.simulate(
  {
    id: "pol-strict",
    name: "Strict Transaction Policy",
    description: "Fee cap and disallow merge",
    scope: "transactions",
    version: 1,
    rules: [],
    parameters: { maxBaseFeeStroops: 1000, disallowedOperations: ["accountMerge"] }
  },
  sampleRecords
);
const feeSideEffect = strictSim.sideEffects.find((s) => s.impactType === "fee_limit_exceeded");
assert.ok(feeSideEffect, "Must detect fee limit breach");
assert.equal(feeSideEffect.targetId, "tx-200");

const disallowedSideEffect = strictSim.sideEffects.find((s) => s.impactType === "operation_disallowed");
assert.ok(disallowedSideEffect, "Must detect disallowed operation");
assert.equal(disallowedSideEffect.targetId, "tx-200");

// Test 2c: Irreversible rules and rollback constraints
const destructiveSim = PolicySimulator.simulate(
  {
    id: "pol-purge",
    name: "Purge Stale Data",
    description: "Permanent truncation of records",
    scope: "global",
    version: 2,
    rules: [
      {
        id: "purge_old_data",
        name: "Purge Stale Data",
        description: "Permanent truncation",
        parameter: "purge_enabled",
        currentValue: false,
        proposedValue: true,
        isIrreversible: true
      }
    ]
  },
  sampleRecords
);
assert.equal(destructiveSim.overallRiskLevel, "critical", "Irreversible rule must yield critical risk");
assert.equal(destructiveSim.executionPlan.recommendedAction, "block", "Irreversible rule must recommend block");
const irreversibleConstraint = destructiveSim.rollbackConstraints.find((c) => c.constraintId === "irreversible_mutations");
assert.ok(irreversibleConstraint, "Must output irreversible mutation rollback constraint");
assert.equal(irreversibleConstraint.reversible, false, "Must flag reversible as false");
assert.equal(irreversibleConstraint.requiresSnapshot, true, "Must require snapshot");

console.log("    [PASS] Policy Simulation Preview verified (read-only, side-effects, rollback constraints)\n");

// -------------------------------------------------------------
// TEST 3: ISSUE #235 - Durable Notification Preferences & Mandatory Alert Routing
// -------------------------------------------------------------
console.log("--> Testing Issue #235: Notification Preferences & Mandatory Alert Routing...");
const { NotificationStore } = await import("../core/notifications/store.ts");

class MockStorage {
  constructor() {
    this.map = new Map();
  }
  getItem(k) { return this.map.get(k) ?? null; }
  setItem(k, v) { this.map.set(k, v); }
  removeItem(k) { this.map.delete(k); }
}

const mockStorage = new MockStorage();
const store = new NotificationStore(mockStorage);
const testAccount = "account:GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

// Test 3a: Default preferences
const defaultPrefs = store.getPreferences(testAccount);
assert.equal(defaultPrefs.recipient, testAccount);
assert.equal(defaultPrefs.muted, false);
assert.equal(defaultPrefs.enabledEvents.failure, true);
assert.equal(defaultPrefs.mandatoryAlertsAlwaysDeliver, true);

// Test 3b: Update preferences
store.updatePreferences(testAccount, { muted: true });
const updatedPrefs = store.getPreferences(testAccount);
assert.equal(updatedPrefs.muted, true, "Muted preference must persist");

// Test 3c: Optional notifications suppressed
const optionalNotif = store.publish({
  recipient: testAccount,
  event: "completed",
  tone: "success",
  title: "Export Done",
  message: "Your export finished",
  href: "/tools/operation-browser",
  dedupeKey: "export-done-1"
});
assert.equal(optionalNotif, null, "Optional notification must be suppressed when muted");
assert.equal(store.list(testAccount).length, 0, "Suppressed notification must not be saved");

// Test 3d: Mandatory lifecycle/security alert delivered despite mute
const mandatoryAlert = store.publish({
  recipient: testAccount,
  event: "failure",
  tone: "error",
  title: "Security Threshold Breach",
  message: "Unauthorized master signer change detected",
  href: "/tools/account-signers",
  dedupeKey: "security-breach-1",
  category: "security",
  urgency: "mandatory"
});
assert.ok(mandatoryAlert, "Mandatory alert must deliver even when user is muted");
assert.equal(mandatoryAlert.routedAs, "mandatory_override", "Must be routed as mandatory_override");
assert.equal(mandatoryAlert.urgency, "mandatory");
assert.equal(mandatoryAlert.category, "security");
assert.equal(store.list(testAccount).length, 1, "Mandatory alert must be saved in recipient inbox");
assert.equal(store.unreadCount(testAccount), 1);

console.log("    [PASS] Notification Preferences & Mandatory Alert Routing verified\n");

// -------------------------------------------------------------
// TEST 4: ISSUE #236 - Stale Cache and Index Detection & Repair
// -------------------------------------------------------------
console.log("--> Testing Issue #236: Stale Cache and Index Detection & Repair...");
const { StaleProjectionDetector } = await import("../core/cache/stale-detector.ts");

const baseTime = 1700000000000;
const testCaches = [
  {
    key: "fresh:balance",
    value: { balance: "100" },
    cachedAt: baseTime - 1000,
    ttlMs: 60000,
    version: 2,
    ledgerSequence: 50000,
    sourceEntityId: "acc-1"
  },
  {
    key: "expired:orderbook",
    value: { bids: [] },
    cachedAt: baseTime - 120000,
    ttlMs: 30000,
    version: 2
  },
  {
    key: "drifted:account",
    value: { weight: 1 },
    cachedAt: baseTime - 5000,
    ttlMs: 600000,
    version: 2,
    ledgerSequence: 49900 // 102 ledgers behind head
  }
];

const testIndexes = [
  {
    indexKey: "index:orphan_pointer",
    targetId: "DELETED_ENTITY",
    indexedAt: baseTime - 1000,
    version: 2
  }
];

const inspectionContext = {
  now: baseTime,
  currentSchemaVersion: 2,
  authoritativeLedgerSequence: 50002,
  primaryEntityIds: new Set(["acc-1"]),
  maxToleratedDriftLedgers: 5
};

const inspectionReport = StaleProjectionDetector.inspect(testCaches, testIndexes, inspectionContext);
assert.equal(inspectionReport.clean, false, "Must detect staleness");
assert.equal(inspectionReport.staleCachesCount, 2, "Must detect 2 stale caches (expired TTL & ledger drift)");
assert.equal(inspectionReport.staleIndexesCount, 1, "Must detect 1 stale index (orphan pointer)");

// Verify automated repair recommendations
const ttlRec = inspectionReport.recommendations.find((r) => r.staleReason === "ttl_expired");
assert.ok(ttlRec, "Must have recommendation for TTL expiration");
assert.equal(ttlRec.recommendedAction, "evict");

const driftRec = inspectionReport.recommendations.find((r) => r.staleReason === "ledger_drift");
assert.ok(driftRec, "Must have recommendation for ledger drift");
assert.equal(driftRec.recommendedAction, "resync");

const indexRec = inspectionReport.recommendations.find((r) => r.staleReason === "index_inconsistency");
assert.ok(indexRec, "Must have recommendation for index inconsistency");
assert.equal(indexRec.recommendedAction, "reindex");

// Test repair execution
let evictedTarget = "";
const repairOutcome = StaleProjectionDetector.executeRepair(ttlRec, {
  onEvict: (k) => { evictedTarget = k; return true; }
});
assert.equal(repairOutcome.success, true);
assert.equal(evictedTarget, "expired:orderbook");
assert.equal(repairOutcome.evidence.action, "evict");

console.log("    [PASS] Stale Cache & Index Detection and Repair verified\n");

console.log("============================================================");
console.log("   ALL VERIFICATIONS PASSED SUCCESSFULLY (100% GREEN)       ");
console.log("============================================================");
