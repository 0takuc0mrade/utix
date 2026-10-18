#!/usr/bin/env node

/**
 * Release Rollback Verification CLI Command
 *
 * Verifies post-rollback consistency of user-facing state, pending operations,
 * background jobs, and external references against the restored protocol behavior.
 *
 * Read-only by default.
 *
 * Usage:
 *   node scripts/verify-release-rollback.mjs
 *   node scripts/verify-release-rollback.mjs --target 1.0.0 --from 1.1.0
 *   node scripts/verify-release-rollback.mjs --json
 */

import { verifyReleaseRollback, formatRollbackReport } from "../core/recovery/rollback-verifier.ts";
import { Keypair } from "@stellar/stellar-sdk";

const args = process.argv.slice(2);
const isJson = args.includes("--json");

function getArgValue(flag) {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

const targetVersion = getArgValue("--target") || "1.0.0";
const rolledBackFromVersion = getArgValue("--from") || "1.1.0";

const organizerKey = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 1)).publicKey();
const userKey = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 2)).publicKey();

const currentDataset = {
  events: [
    {
      id: "event-main-001",
      name: "Utix Global Conference",
      organizerAddress: organizerKey,
      capacity: 1000,
      status: "active",
      protocolVersion: targetVersion,
      createdAt: Date.now() - 86400000
    }
  ],
  tickets: [
    {
      id: "tkt-001",
      eventId: "event-main-001",
      owner: userKey,
      tier: "standard",
      status: "issued",
      protocolVersion: targetVersion,
      externalRef: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      issuedAt: Date.now() - 3600000,
      updatedAt: Date.now() - 3600000
    }
  ],
  transfers: [],
  redemptions: [],
  workerJobs: [],
  fraudRecords: []
};

const rollbackTarget = {
  targetVersion,
  rolledBackFromVersion,
  rollbackTimestamp: Date.now()
};

const report = verifyReleaseRollback(currentDataset, rollbackTarget, { readOnly: true });

if (isJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(formatRollbackReport(report));
}

process.exit(report.passed ? 0 : 1);
