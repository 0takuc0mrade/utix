import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import {
  formatRollbackReport,
  type ProtocolDataset,
  type RollbackTarget,
  verifyReleaseRollback
} from "../rollback-verifier";

const ALICE = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 1)).publicKey();
const BOB = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 2)).publicKey();
const CHARLIE = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 3)).publicKey();

const cleanDataset: ProtocolDataset = {
  events: [
    {
      id: "event-101",
      name: "Stellar Developer Summit",
      organizerAddress: ALICE,
      capacity: 500,
      status: "active",
      protocolVersion: "1.0.0",
      createdAt: 1700000000000
    }
  ],
  tickets: [
    {
      id: "ticket-1",
      eventId: "event-101",
      owner: ALICE,
      tier: "general",
      status: "issued",
      protocolVersion: "1.0.0",
      externalRef: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      issuedAt: 1700000010000,
      updatedAt: 1700000010000
    },
    {
      id: "ticket-2",
      eventId: "event-101",
      owner: BOB,
      tier: "vip",
      status: "transferred",
      protocolVersion: "1.0.0",
      externalRef: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
      issuedAt: 1700000020000,
      updatedAt: 1700000030000
    }
  ],
  transfers: [
    {
      id: "transfer-1",
      ticketId: "ticket-2",
      fromOwner: ALICE,
      toOwner: BOB,
      status: "accepted",
      protocolVersion: "1.0.0",
      initiatedAt: 1700000020000,
      expiresAt: 1700003620000,
      settledAt: 1700000030000,
      externalTxHash: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"
    }
  ],
  redemptions: [
    {
      id: "redemption-1",
      ticketId: "ticket-1",
      eventId: "event-101",
      redeemedBy: ALICE,
      nonce: "nonce-101-abc",
      protocolVersion: "1.0.0",
      redeemedAt: 1700000050000,
      isConfirmed: true
    }
  ],
  workerJobs: [
    {
      id: "job-1",
      jobType: "send_ticket_notification",
      status: "succeeded",
      payloadVersion: "1.0.0",
      payload: { ticketId: "ticket-1" },
      createdAt: 1700000010000,
      updatedAt: 1700000015000
    }
  ],
  fraudRecords: [
    {
      id: "fraud-1",
      account: CHARLIE,
      ruleId: "high_frequency_transfers",
      protocolVersion: "1.0.0",
      flaggedAt: 1700000040000,
      isManualReviewPending: false
    }
  ]
};

const defaultTarget: RollbackTarget = {
  targetVersion: "1.0.0",
  rolledBackFromVersion: "1.1.0",
  rollbackTimestamp: 1700001000000
};

describe("Release Rollback Verification Suite", () => {
  it("verifies a completely clean rollback scenario", () => {
    const report = verifyReleaseRollback(cleanDataset, defaultTarget);

    expect(report.isClean).toBe(true);
    expect(report.passed).toBe(true);
    expect(report.requiresManualRepair).toBe(false);
    expect(report.manualRepairRecords.length).toBe(0);
    expect(report.failedChecks).toBe(0);
    expect(report.readOnly).toBe(true);
  });

  it("detects partial rollback with pending transfers and active worker jobs requiring manual repair", () => {
    const partialDataset: ProtocolDataset = {
      ...cleanDataset,
      transfers: [
        ...cleanDataset.transfers,
        {
          id: "transfer-pending-v11",
          ticketId: "ticket-1",
          fromOwner: ALICE,
          toOwner: CHARLIE,
          status: "pending",
          protocolVersion: "1.1.0", // initiated under rolled-back version
          initiatedAt: 1700000900000,
          expiresAt: 1700004500000
        }
      ],
      workerJobs: [
        ...cleanDataset.workerJobs,
        {
          id: "job-active-v11",
          jobType: "process_v11_soroban_sync",
          status: "queued",
          payloadVersion: "1.1.0", // queued with rolled back schema
          payload: { batchSize: 50 },
          createdAt: 1700000950000,
          updatedAt: 1700000950000
        }
      ]
    };

    const report = verifyReleaseRollback(partialDataset, defaultTarget);

    expect(report.isClean).toBe(false);
    expect(report.requiresManualRepair).toBe(true);
    expect(report.manualRepairRecords.length).toBeGreaterThanOrEqual(2);

    const transferRepair = report.manualRepairRecords.find(r => r.recordId === "transfer-pending-v11");
    expect(transferRepair).toBeDefined();
    expect(transferRepair?.domain).toBe("transfer");
    expect(transferRepair?.suggestedAction).toContain("Cancel pending transfer");

    const jobRepair = report.manualRepairRecords.find(r => r.recordId === "job-active-v11");
    expect(jobRepair).toBeDefined();
    expect(jobRepair?.domain).toBe("worker_job");
    expect(jobRepair?.suggestedAction).toContain("dead-letter");
  });

  it("detects failed rollback validation when critical invariants are broken", () => {
    const failedDataset: ProtocolDataset = {
      ...cleanDataset,
      events: [
        {
          id: "event-small",
          name: "Micro Meetup",
          organizerAddress: ALICE,
          capacity: 1, // capacity is 1
          status: "active",
          protocolVersion: "1.0.0",
          createdAt: 1700000000000
        }
      ],
      tickets: [
        {
          id: "ticket-dup",
          eventId: "event-small",
          owner: ALICE,
          tier: "general",
          status: "issued",
          protocolVersion: "1.0.0",
          issuedAt: 1700000010000,
          updatedAt: 1700000010000
        },
        {
          id: "ticket-dup", // duplicate ticket ID!
          eventId: "event-small",
          owner: BOB,
          tier: "general",
          status: "issued",
          protocolVersion: "1.0.0",
          issuedAt: 1700000015000,
          updatedAt: 1700000015000
        },
        {
          id: "ticket-orphan",
          eventId: "non-existent-event-999", // orphan event reference!
          owner: CHARLIE,
          tier: "general",
          status: "issued",
          protocolVersion: "1.0.0",
          issuedAt: 1700000020000,
          updatedAt: 1700000020000
        }
      ],
      redemptions: [
        {
          id: "redemption-unconfirmed",
          ticketId: "ticket-dup",
          eventId: "event-small",
          redeemedBy: ALICE,
          nonce: "nonce-unconfirmed",
          protocolVersion: "1.1.0", // rolled-back version redemption!
          redeemedAt: 1700000050000,
          isConfirmed: false // unconfirmed!
        }
      ]
    };

    const report = verifyReleaseRollback(failedDataset, defaultTarget);

    expect(report.passed).toBe(false);
    expect(report.isClean).toBe(false);
    expect(report.requiresManualRepair).toBe(true);

    const duplicateCheck = report.manualRepairRecords.find(r => r.reason.includes("Duplicate ticket identifier"));
    expect(duplicateCheck).toBeDefined();

    const orphanCheck = report.manualRepairRecords.find(r => r.reason.includes("non-existent eventId"));
    expect(orphanCheck).toBeDefined();

    const redemptionCheck = report.manualRepairRecords.find(r => r.recordId === "redemption-unconfirmed");
    expect(redemptionCheck).toBeDefined();
  });

  it("flags tickets with invalid Stellar owner public keys and malformed transaction references", () => {
    const invalidAddressDataset: ProtocolDataset = {
      ...cleanDataset,
      tickets: [
        {
          id: "ticket-bad-addr",
          eventId: "event-101",
          owner: "INVALID_STELLAR_KEY_123",
          tier: "general",
          status: "issued",
          protocolVersion: "1.0.0",
          externalRef: "invalid-hash-too-short",
          issuedAt: 1700000010000,
          updatedAt: 1700000010000
        }
      ]
    };

    const report = verifyReleaseRollback(invalidAddressDataset, defaultTarget);
    expect(report.requiresManualRepair).toBe(true);

    const addrIssue = report.manualRepairRecords.find(r => r.reason.includes("Invalid Stellar owner public key format"));
    expect(addrIssue).toBeDefined();

    const hashIssue = report.manualRepairRecords.find(r => r.reason.includes("Malformed external Stellar transaction reference"));
    expect(hashIssue).toBeDefined();
  });

  it("generates a comprehensive formatted human-readable report", () => {
    const report = verifyReleaseRollback(cleanDataset, defaultTarget);
    const formatted = formatRollbackReport(report);

    expect(formatted).toContain("POST-RELEASE ROLLBACK VERIFICATION REPORT");
    expect(formatted).toContain("Target Version:         1.0.0 (Restored)");
    expect(formatted).toContain("CLEAN ROLLBACK [PASS]");
    expect(formatted).toContain("READ-ONLY");
  });
});
