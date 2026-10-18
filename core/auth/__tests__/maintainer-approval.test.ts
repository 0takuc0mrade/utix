import { beforeEach, describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import {
  computeCanonicalIntentHash,
  MaintainerApprovalManager,
  verifyMaintainerSignature
} from "../maintainer-approval";

const MAINTAINER_1 = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 10));
const MAINTAINER_2 = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 20));
const MAINTAINER_3 = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 30));

describe("Maintainer Action Approval Flow Suite", () => {
  let manager: MaintainerApprovalManager;

  beforeEach(() => {
    manager = new MaintainerApprovalManager();
  });

  it("proposes a high-impact intent with canonical hash and expiration", () => {
    const intent = manager.proposeIntent({
      action: "emergency_killswitch",
      target: "xdr-inspector",
      reason: "Critical parsing vulnerability reported in upstream library",
      requestedBy: MAINTAINER_1.publicKey(),
      expiresInMs: 15 * 60 * 1000
    });

    expect(intent.id).toBeDefined();
    expect(intent.status).toBe("pending");
    expect(intent.action).toBe("emergency_killswitch");
    expect(intent.target).toBe("xdr-inspector");
    expect(intent.requiredSignatures).toBe(2);
    expect(intent.intentHash).toHaveLength(64);
    expect(intent.expiresAt).toBeGreaterThan(intent.requestedAt);
  });

  it("rejects intent proposals with missing reasons or invalid maintainer keys", () => {
    expect(() => {
      manager.proposeIntent({
        action: "emergency_killswitch",
        target: "xdr-inspector",
        reason: "", // Empty reason!
        requestedBy: MAINTAINER_1.publicKey()
      });
    }).toThrow("Explicit justification reason is mandatory");

    expect(() => {
      manager.proposeIntent({
        action: "emergency_killswitch",
        target: "xdr-inspector",
        reason: "Valid reason",
        requestedBy: "INVALID_KEY"
      });
    }).toThrow("Invalid maintainer public key");
  });

  it("verifies Ed25519 cryptographic signatures and tracks multi-maintainer approvals", () => {
    const intent = manager.proposeIntent({
      action: "emergency_killswitch",
      target: "soroban-decoder",
      reason: "Emergency halt for reentrancy investigation",
      requestedBy: MAINTAINER_1.publicKey()
    });

    // 1. First maintainer signs
    const sig1 = MAINTAINER_1.sign(Buffer.from(intent.intentHash, "hex")).toString("hex");
    const updated1 = manager.signIntent(intent.id, MAINTAINER_1.publicKey(), sig1);

    expect(updated1.signatures.length).toBe(1);
    expect(updated1.status).toBe("pending"); // Requires 2 signatures!

    // 2. Reject duplicate signature from the same maintainer
    expect(() => {
      manager.signIntent(intent.id, MAINTAINER_1.publicKey(), sig1);
    }).toThrow("already signed intent");

    // 3. Reject invalid forged signature
    const forgedSig = Buffer.alloc(64, 9).toString("hex");
    expect(() => {
      manager.signIntent(intent.id, MAINTAINER_2.publicKey(), forgedSig);
    }).toThrow("Cryptographic signature verification failed");

    // 4. Second maintainer signs with valid cryptographic keypair
    const sig2 = MAINTAINER_2.sign(Buffer.from(intent.intentHash, "hex")).toString("hex");
    const updated2 = manager.signIntent(intent.id, MAINTAINER_2.publicKey(), sig2);

    expect(updated2.signatures.length).toBe(2);
    expect(updated2.status).toBe("approved"); // Threshold reached!
  });

  it("executes approved intent, generates signed receipt, and blocks replay", async () => {
    const intent = manager.proposeIntent({
      action: "quota_override",
      target: "tenant-premium-01",
      parameters: { newRateLimit: 5000 },
      reason: "Temporary conference traffic surge requested",
      requestedBy: MAINTAINER_1.publicKey(),
      requiredSignatures: 1
    });

    // Sign to approve
    const sig1 = MAINTAINER_1.sign(Buffer.from(intent.intentHash, "hex")).toString("hex");
    manager.signIntent(intent.id, MAINTAINER_1.publicKey(), sig1);

    expect(intent.status).toBe("approved");

    // Execute with simulated action callback
    let actionExecuted = false;
    const execution = await manager.executeIntent(
      intent.id,
      MAINTAINER_1.publicKey(),
      async (req) => {
        actionExecuted = true;
        return { updatedRateLimit: req.parameters.newRateLimit };
      }
    );

    expect(actionExecuted).toBe(true);
    expect(execution.result.updatedRateLimit).toBe(5000);

    // Verify receipt
    const receipt = execution.receipt;
    expect(receipt.receiptId).toBeDefined();
    expect(receipt.intentId).toBe(intent.id);
    expect(receipt.status).toBe("executed");
    expect(receipt.receiptDigest).toHaveLength(64);
    expect(receipt.signers).toContain(MAINTAINER_1.publicKey());
    expect(receipt.executedBy).toBe(MAINTAINER_1.publicKey());

    // Replay protection: cannot execute again!
    await expect(
      manager.executeIntent(intent.id, MAINTAINER_1.publicKey(), () => {})
    ).rejects.toThrow("Cannot execute intent");
  });

  it("handles failed actions by recording failure receipt and preserving error details", async () => {
    const intent = manager.proposeIntent({
      action: "reconciliation_repair",
      target: "invariants-table",
      reason: "Automated repair dry run failed",
      requestedBy: MAINTAINER_1.publicKey(),
      requiredSignatures: 1
    });

    const sig = MAINTAINER_1.sign(Buffer.from(intent.intentHash, "hex")).toString("hex");
    manager.signIntent(intent.id, MAINTAINER_1.publicKey(), sig);

    await expect(
      manager.executeIntent(intent.id, MAINTAINER_1.publicKey(), () => {
        throw new Error("Disk space exhausted during repair apply");
      })
    ).rejects.toThrow("Maintainer action execution failed: Disk space exhausted");

    // Verify receipt was captured even on execution failure
    const failedReceipt = manager.getReceiptByIntent(intent.id);
    expect(failedReceipt).toBeDefined();
    expect(failedReceipt?.status).toBe("failed");
    expect(failedReceipt?.error).toContain("Disk space exhausted");
  });

  it("prevents execution of expired intents", async () => {
    let mockTime = 100000;
    const timeAwareManager = new MaintainerApprovalManager({
      now: () => new Date(mockTime)
    });

    const intent = timeAwareManager.proposeIntent({
      action: "quota_override",
      target: "global",
      reason: "Short term override",
      requestedBy: MAINTAINER_1.publicKey(),
      expiresInMs: 1000,
      requiredSignatures: 1
    });

    const sig = MAINTAINER_1.sign(Buffer.from(intent.intentHash, "hex")).toString("hex");
    timeAwareManager.signIntent(intent.id, MAINTAINER_1.publicKey(), sig);

    // Fast-forward time past expiration
    mockTime += 2000;

    await expect(
      timeAwareManager.executeIntent(intent.id, MAINTAINER_1.publicKey(), () => {})
    ).rejects.toThrow("has expired");
  });

  it("provides receipt and pending intent query APIs", async () => {
    const intent = manager.proposeIntent({
      action: "dead_letter_purge",
      target: "export-worker-queue",
      reason: "Purge malformed jobs",
      requestedBy: MAINTAINER_1.publicKey(),
      requiredSignatures: 1
    });

    expect(manager.listPendingIntents().length).toBe(1);

    const sig = MAINTAINER_1.sign(Buffer.from(intent.intentHash, "hex")).toString("hex");
    manager.signIntent(intent.id, MAINTAINER_1.publicKey(), sig);

    await manager.executeIntent(intent.id, MAINTAINER_1.publicKey(), () => ({ purged: 42 }));

    expect(manager.listPendingIntents().length).toBe(0);

    const receipts = manager.listReceipts({ action: "dead_letter_purge" });
    expect(receipts.length).toBe(1);
    expect(receipts[0].action).toBe("dead_letter_purge");
    expect(receipts[0].status).toBe("executed");
  });
});
