import { beforeEach, describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import {
  ACTION_THRESHOLDS,
  executeProtectedAction,
  MaintainerApprovalManager,
  verifyProtectedActionApproval,
  type HighImpactAction,
  type ProtectedActionRequest
} from "../maintainer-approval";

const MAINTAINER_ALICE = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 1));
const MAINTAINER_BOB = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 2));
const MAINTAINER_CAROL = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 3));
const ROGUE_ACTOR = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 99));

describe("Issue #180: Signed Administrative Action Approvals for High-Impact Changes", () => {
  let manager: MaintainerApprovalManager;
  let mockCurrentTime: number;

  beforeEach(() => {
    mockCurrentTime = 1700000000000;
    manager = new MaintainerApprovalManager({
      now: () => new Date(mockCurrentTime),
      defaultExpiryMs: 15 * 60 * 1000 // 15 minutes
    });
  });

  function signProposal(intentId: string, signer: Keypair) {
    const intent = manager.getIntent(intentId);
    if (!intent) throw new Error("Intent not found for test helper");
    const sigHex = signer.sign(Buffer.from(intent.intentHash, "hex")).toString("hex");
    return manager.signIntent(intentId, signer.publicKey(), sigHex);
  }

  describe("Thresholds & Action Types", () => {
    it("defines proper multi-maintainer thresholds for ticketing and event access actions", () => {
      const expectedThresholds: Record<HighImpactAction, number> = {
        emergency_killswitch: 2,
        protocol_rollback: 2,
        reconciliation_repair: 2,
        admin_config_override: 2,
        quota_override: 1,
        dead_letter_purge: 1,
        event_capacity_override: 2,
        event_cancellation: 2,
        fraud_lock_quarantine: 1,
        batch_ticket_burn: 2,
        organizer_fee_override: 2
      };

      for (const [action, threshold] of Object.entries(expectedThresholds)) {
        expect(ACTION_THRESHOLDS[action as HighImpactAction]).toBe(threshold);
      }
    });
  });

  describe("Protected Action Verification & Guardrails", () => {
    it("fails when approval ID is missing or not found (approval_not_found)", async () => {
      const request: ProtectedActionRequest = {
        action: "event_cancellation",
        target: "event-stadium-2026",
        approvalId: "intent-does-not-exist",
        executorPublicKey: MAINTAINER_ALICE.publicKey()
      };

      const verification = verifyProtectedActionApproval(request, manager);
      expect(verification.valid).toBe(false);
      if (!verification.valid) {
        expect(verification.error).toBe("approval_not_found");
        expect(verification.message).toContain("was not found");
      }

      await expect(
        executeProtectedAction(request, () => ({ success: true }), manager)
      ).rejects.toThrow("approval_not_found");
    });

    it("rejects pending actions when approval threshold is not yet met (approval_not_ready)", async () => {
      const intent = manager.proposeIntent({
        action: "event_cancellation",
        target: "event-stadium-2026",
        reason: "Severe hurricane alert issued by authorities",
        requestedBy: MAINTAINER_ALICE.publicKey()
      });

      // Only 1 of 2 required maintainers signs
      signProposal(intent.id, MAINTAINER_ALICE);

      const request: ProtectedActionRequest = {
        action: "event_cancellation",
        target: "event-stadium-2026",
        approvalId: intent.id,
        executorPublicKey: MAINTAINER_ALICE.publicKey()
      };

      const verification = verifyProtectedActionApproval(request, manager);
      expect(verification.valid).toBe(false);
      if (!verification.valid) {
        expect(verification.error).toBe("approval_not_ready");
      }

      await expect(
        executeProtectedAction(request, () => ({ success: true }), manager)
      ).rejects.toThrow("approval_not_ready");
    });

    it("rejects expired approvals (approval_expired)", async () => {
      const intent = manager.proposeIntent({
        action: "event_capacity_override",
        target: "event-arena-101",
        parameters: { maxTickets: 25000 },
        reason: "Fire marshal permit granted for floor expansion",
        requestedBy: MAINTAINER_ALICE.publicKey(),
        expiresInMs: 5000
      });

      // Alice and Bob sign to approve
      signProposal(intent.id, MAINTAINER_ALICE);
      signProposal(intent.id, MAINTAINER_BOB);
      expect(manager.getIntent(intent.id)?.status).toBe("approved");

      // Advance clock past expiration
      mockCurrentTime += 10000;

      const request: ProtectedActionRequest = {
        action: "event_capacity_override",
        target: "event-arena-101",
        approvalId: intent.id,
        executorPublicKey: MAINTAINER_ALICE.publicKey()
      };

      const verification = verifyProtectedActionApproval(request, manager);
      expect(verification.valid).toBe(false);
      if (!verification.valid) {
        expect(verification.error).toBe("approval_expired");
      }

      await expect(
        executeProtectedAction(request, () => ({ expanded: true }), manager)
      ).rejects.toThrow("approval_expired");
    });

    it("rejects mismatched actions and targets (action_mismatch, target_mismatch)", async () => {
      const intent = manager.proposeIntent({
        action: "event_cancellation",
        target: "event-main-stage",
        reason: "Force majeure event",
        requestedBy: MAINTAINER_ALICE.publicKey()
      });

      signProposal(intent.id, MAINTAINER_ALICE);
      signProposal(intent.id, MAINTAINER_BOB);

      // 1. Action Mismatch
      const actionMismatchReq: ProtectedActionRequest = {
        action: "event_capacity_override", // Mismatched action!
        target: "event-main-stage",
        approvalId: intent.id,
        executorPublicKey: MAINTAINER_ALICE.publicKey()
      };
      const vAction = verifyProtectedActionApproval(actionMismatchReq, manager);
      expect(vAction.valid).toBe(false);
      if (!vAction.valid) {
        expect(vAction.error).toBe("action_mismatch");
      }

      await expect(
        executeProtectedAction(actionMismatchReq, () => {}, manager)
      ).rejects.toThrow("action_mismatch");

      // 2. Target Mismatch
      const targetMismatchReq: ProtectedActionRequest = {
        action: "event_cancellation",
        target: "event-different-stage", // Mismatched target!
        approvalId: intent.id,
        executorPublicKey: MAINTAINER_ALICE.publicKey()
      };
      const vTarget = verifyProtectedActionApproval(targetMismatchReq, manager);
      expect(vTarget.valid).toBe(false);
      if (!vTarget.valid) {
        expect(vTarget.error).toBe("target_mismatch");
      }

      await expect(
        executeProtectedAction(targetMismatchReq, () => {}, manager)
      ).rejects.toThrow("target_mismatch");
    });

    it("rejects mismatched parameters (parameter_mismatch)", async () => {
      const intent = manager.proposeIntent({
        action: "organizer_fee_override",
        target: "organizer-fest-co",
        parameters: { feeBasisPoints: 150 },
        reason: "Approved partnership promotional discount",
        requestedBy: MAINTAINER_ALICE.publicKey()
      });

      signProposal(intent.id, MAINTAINER_ALICE);
      signProposal(intent.id, MAINTAINER_BOB);

      const alteredParamsReq: ProtectedActionRequest = {
        action: "organizer_fee_override",
        target: "organizer-fest-co",
        parameters: { feeBasisPoints: 0 }, // Altered from 150 to 0!
        approvalId: intent.id,
        executorPublicKey: MAINTAINER_ALICE.publicKey()
      };

      const vParam = verifyProtectedActionApproval(alteredParamsReq, manager);
      expect(vParam.valid).toBe(false);
      if (!vParam.valid) {
        expect(vParam.error).toBe("parameter_mismatch");
      }

      await expect(
        executeProtectedAction(alteredParamsReq, () => {}, manager)
      ).rejects.toThrow("parameter_mismatch");
    });

    it("rejects unauthorized actors and invalid Ed25519 public keys (unauthorized_actor)", async () => {
      const intent = manager.proposeIntent({
        action: "fraud_lock_quarantine",
        target: "ticket-batch-90210",
        reason: "Suspected credit card chargeback cluster",
        requestedBy: MAINTAINER_ALICE.publicKey()
      });

      signProposal(intent.id, MAINTAINER_ALICE);

      // 1. Invalid key format
      const invalidKeyReq: ProtectedActionRequest = {
        action: "fraud_lock_quarantine",
        target: "ticket-batch-90210",
        approvalId: intent.id,
        executorPublicKey: "MALFORMED_STELLAR_KEY"
      };

      const vInvalid = verifyProtectedActionApproval(invalidKeyReq, manager);
      expect(vInvalid.valid).toBe(false);
      if (!vInvalid.valid) {
        expect(vInvalid.error).toBe("unauthorized_actor");
      }

      await expect(
        executeProtectedAction(invalidKeyReq, () => {}, manager)
      ).rejects.toThrow("unauthorized_actor");

      // 2. Key not in authorized maintainers list
      const unauthorizedReq: ProtectedActionRequest = {
        action: "fraud_lock_quarantine",
        target: "ticket-batch-90210",
        approvalId: intent.id,
        executorPublicKey: ROGUE_ACTOR.publicKey()
      };

      const vRogue = verifyProtectedActionApproval(unauthorizedReq, manager, {
        authorizedMaintainers: [MAINTAINER_ALICE.publicKey(), MAINTAINER_BOB.publicKey()]
      });
      expect(vRogue.valid).toBe(false);
      if (!vRogue.valid) {
        expect(vRogue.error).toBe("unauthorized_actor");
      }

      await expect(
        executeProtectedAction(unauthorizedReq, () => {}, manager, {
          authorizedMaintainers: [MAINTAINER_ALICE.publicKey(), MAINTAINER_BOB.publicKey()]
        })
      ).rejects.toThrow("unauthorized_actor");

      // 3. Executor required to be a signer
      const notSignerReq: ProtectedActionRequest = {
        action: "fraud_lock_quarantine",
        target: "ticket-batch-90210",
        approvalId: intent.id,
        executorPublicKey: MAINTAINER_CAROL.publicKey()
      };

      const vNotSigner = verifyProtectedActionApproval(notSignerReq, manager, {
        requireSignerAsExecutor: true
      });
      expect(vNotSigner.valid).toBe(false);
      if (!vNotSigner.valid) {
        expect(vNotSigner.error).toBe("unauthorized_actor");
      }
    });

    it("executes valid multi-maintainer signed approval and prevents replay (already_executed)", async () => {
      const intent = manager.proposeIntent({
        action: "batch_ticket_burn",
        target: "event-2026-fraudulent-run",
        parameters: { ticketIds: ["t-1", "t-2", "t-3"], burnReason: "Counterfeit barcodes" },
        reason: "Court ordered ticket invalidation",
        requestedBy: MAINTAINER_ALICE.publicKey()
      });

      // Both Alice and Bob sign
      signProposal(intent.id, MAINTAINER_ALICE);
      signProposal(intent.id, MAINTAINER_BOB);

      const request: ProtectedActionRequest = {
        action: "batch_ticket_burn",
        target: "event-2026-fraudulent-run",
        parameters: { ticketIds: ["t-1", "t-2", "t-3"], burnReason: "Counterfeit barcodes" },
        approvalId: intent.id,
        executorPublicKey: MAINTAINER_BOB.publicKey()
      };

      // 1. Verification succeeds
      const vOk = verifyProtectedActionApproval(request, manager);
      expect(vOk.valid).toBe(true);
      if (vOk.valid) {
        expect(vOk.intent.id).toBe(intent.id);
      }

      // 2. Execution succeeds
      let executedBurn = false;
      const executionResult = await executeProtectedAction(
        request,
        async (approvedIntent) => {
          executedBurn = true;
          return { burnedCount: (approvedIntent.parameters.ticketIds as string[]).length };
        },
        manager
      );

      expect(executedBurn).toBe(true);
      expect(executionResult.result.burnedCount).toBe(3);
      expect(executionResult.receipt.receiptDigest).toBeDefined();
      expect(executionResult.receipt.receiptDigest).toHaveLength(64);
      expect(executionResult.receipt.signers).toContain(MAINTAINER_ALICE.publicKey());
      expect(executionResult.receipt.signers).toContain(MAINTAINER_BOB.publicKey());
      expect(executionResult.receipt.status).toBe("executed");

      // 3. Replay protection: Attempting to verify or execute again is blocked
      const vReplay = verifyProtectedActionApproval(request, manager);
      expect(vReplay.valid).toBe(false);
      if (!vReplay.valid) {
        expect(vReplay.error).toBe("already_executed");
      }

      await expect(
        executeProtectedAction(request, () => ({ burnedCount: 0 }), manager)
      ).rejects.toThrow("already_executed");
    });
  });
});
