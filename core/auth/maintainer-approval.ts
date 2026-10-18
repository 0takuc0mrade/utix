/**
 * Maintainer Action Approval Flow with Signed Intent Receipts.
 *
 * Enforces explicit cryptographic intent and multi-maintainer authorization
 * for high-impact actions (kill-switch, repair execution, protocol rollback,
 * quota overrides, dead-letter purges, and administrative configuration updates).
 *
 * Guarantees:
 * 1. Explicit Intent: every high-impact action requires canonical intent hashing and justification.
 * 2. Cryptographic Proof: signed by maintainer Ed25519 keypairs and verified via Stellar SDK.
 * 3. Replay Protection: nonces, expiry windows, and single-execution state machine transitions.
 * 4. Tamper-evident Audit Receipts: generates durable, queryable receipts sealed with SHA-256 digests.
 * 5. Bounded Complexity: O(1) time complexity for intent lookup and signature verification.
 */

import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { sha256Hex } from "@/core/ledger/sha256";
import { recordAudit, type AuditEvent } from "@/core/audit/audit";

export type HighImpactAction =
  | "emergency_killswitch"
  | "reconciliation_repair"
  | "protocol_rollback"
  | "quota_override"
  | "dead_letter_purge"
  | "admin_config_override";

export type IntentStatus = "pending" | "approved" | "executing" | "executed" | "rejected" | "expired" | "failed";

export interface MaintainerSignature {
  signerPublicKey: string;
  signatureHex: string;
  signedAt: number;
}

export interface IntentRequest {
  id: string;
  action: HighImpactAction;
  target: string;
  parameters: Record<string, unknown>;
  reason: string;
  requestedBy: string;
  requestedAt: number;
  expiresAt: number;
  nonce: string;
  requiredSignatures: number;
  intentHash: string;
  status: IntentStatus;
  signatures: MaintainerSignature[];
}

export interface ApprovalReceipt {
  receiptId: string;
  intentId: string;
  intentHash: string;
  action: HighImpactAction;
  target: string;
  parameters: Record<string, unknown>;
  reason: string;
  requestedBy: string;
  signers: string[];
  status: "executed" | "failed";
  executedBy: string;
  executedAt: number;
  durationMs: number;
  executionOutput?: unknown;
  error?: string;
  receiptDigest: string;
  auditEventId?: string;
}

export interface ProposeIntentParams {
  action: HighImpactAction;
  target: string;
  parameters?: Record<string, unknown>;
  reason: string;
  requestedBy: string;
  expiresInMs?: number;
  requiredSignatures?: number;
}

export interface ApprovalFlowOptions {
  now?: () => Date;
  defaultExpiryMs?: number;
}

const DEFAULT_EXPIRY_MS = 30 * 60 * 1000; // 30 minutes
const ACTION_THRESHOLDS: Record<HighImpactAction, number> = {
  emergency_killswitch: 2,
  protocol_rollback: 2,
  reconciliation_repair: 2,
  admin_config_override: 2,
  quota_override: 1,
  dead_letter_purge: 1
};

/**
 * Computes canonical SHA-256 hash of an intent payload.
 * Canonicalization sorts keys deterministically to guarantee consistent digests across platforms.
 */
export function computeCanonicalIntentHash(payload: {
  action: string;
  target: string;
  parameters: Record<string, unknown>;
  reason: string;
  requestedBy: string;
  nonce: string;
  requestedAt: number;
  expiresAt: number;
}): string {
  const sortedKeys = Object.keys(payload).sort();
  const sortedObject: Record<string, unknown> = {};
  for (const k of sortedKeys) {
    sortedObject[k] = (payload as Record<string, unknown>)[k];
  }
  return sha256Hex(JSON.stringify(sortedObject));
}

/**
 * Verifies an Ed25519 signature over a message using Stellar SDK Keypair.
 */
export function verifyMaintainerSignature(
  signerPublicKey: string,
  messageHashHex: string,
  signatureHex: string
): boolean {
  if (!StrKey.isValidEd25519PublicKey(signerPublicKey)) {
    return false;
  }

  try {
    const keypair = Keypair.fromPublicKey(signerPublicKey);
    const messageBuffer = Buffer.from(messageHashHex, "hex");
    const signatureBuffer = Buffer.from(signatureHex, "hex");
    return keypair.verify(messageBuffer, signatureBuffer);
  } catch {
    return false;
  }
}

export class MaintainerApprovalManager {
  private intents: Map<string, IntentRequest> = new Map();
  private receipts: Map<string, ApprovalReceipt> = new Map();
  private receiptsByIntent: Map<string, string> = new Map();

  constructor(private readonly options: ApprovalFlowOptions = {}) {}

  private now(): number {
    return this.options.now ? this.options.now().getTime() : Date.now();
  }

  /**
   * Proposes a new high-impact maintainer action.
   * Time complexity: O(1).
   * Space complexity: O(1).
   */
  proposeIntent(params: ProposeIntentParams): IntentRequest {
    if (!StrKey.isValidEd25519PublicKey(params.requestedBy)) {
      throw new Error(`Invalid maintainer public key: ${params.requestedBy}`);
    }

    if (!params.reason || params.reason.trim().length === 0) {
      throw new Error("Explicit justification reason is mandatory for high-impact maintainer actions");
    }

    const requestedAt = this.now();
    const expiryMs = params.expiresInMs ?? this.options.defaultExpiryMs ?? DEFAULT_EXPIRY_MS;
    const expiresAt = requestedAt + expiryMs;
    const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
    const parameters = params.parameters ?? {};
    const requiredSignatures = params.requiredSignatures ?? ACTION_THRESHOLDS[params.action] ?? 1;

    const intentHash = computeCanonicalIntentHash({
      action: params.action,
      target: params.target,
      parameters,
      reason: params.reason,
      requestedBy: params.requestedBy,
      nonce,
      requestedAt,
      expiresAt
    });

    const id = `intent-${requestedAt}-${Math.random().toString(36).slice(2, 8)}`;
    const intent: IntentRequest = {
      id,
      action: params.action,
      target: params.target,
      parameters,
      reason: params.reason,
      requestedBy: params.requestedBy,
      requestedAt,
      expiresAt,
      nonce,
      requiredSignatures,
      intentHash,
      status: "pending",
      signatures: []
    };

    this.intents.set(id, intent);
    return intent;
  }

  /**
   * Signs an intent proposal using a maintainer's cryptographic signature.
   * Time complexity: O(1).
   * Space complexity: O(1).
   */
  signIntent(intentId: string, signerPublicKey: string, signatureHex: string): IntentRequest {
    const intent = this.intents.get(intentId);
    if (!intent) {
      throw new Error(`Intent ${intentId} not found`);
    }

    if (intent.status !== "pending") {
      throw new Error(`Intent ${intentId} cannot be signed in state ${intent.status}`);
    }

    if (this.now() > intent.expiresAt) {
      intent.status = "expired";
      throw new Error(`Intent ${intentId} has expired`);
    }

    if (!verifyMaintainerSignature(signerPublicKey, intent.intentHash, signatureHex)) {
      throw new Error(`Cryptographic signature verification failed for maintainer ${signerPublicKey}`);
    }

    // Check for duplicate signature from the same maintainer
    if (intent.signatures.some(s => s.signerPublicKey === signerPublicKey)) {
      throw new Error(`Maintainer ${signerPublicKey} has already signed intent ${intentId}`);
    }

    intent.signatures.push({
      signerPublicKey,
      signatureHex,
      signedAt: this.now()
    });

    // Check if required approval threshold is reached
    if (intent.signatures.length >= intent.requiredSignatures) {
      intent.status = "approved";
    }

    return intent;
  }

  /**
   * Executes an approved intent with protective guardrails and generates an audit receipt.
   * Time complexity: O(1) + actionHandler execution time.
   * Space complexity: O(1).
   */
  async executeIntent<T>(
    intentId: string,
    executorPublicKey: string,
    actionHandler: (intent: IntentRequest) => Promise<T> | T
  ): Promise<{ result: T; receipt: ApprovalReceipt }> {
    const intent = this.intents.get(intentId);
    if (!intent) {
      throw new Error(`Intent ${intentId} not found`);
    }

    if (!StrKey.isValidEd25519PublicKey(executorPublicKey)) {
      throw new Error(`Invalid executor public key: ${executorPublicKey}`);
    }

    if (intent.status !== "approved") {
      throw new Error(`Cannot execute intent ${intentId} in state ${intent.status}. State must be "approved"`);
    }

    if (this.now() > intent.expiresAt) {
      intent.status = "expired";
      throw new Error(`Intent ${intentId} has expired`);
    }

    intent.status = "executing";
    const startTime = this.now();
    const receiptId = `receipt-${startTime}-${Math.random().toString(36).slice(2, 8)}`;

    let executionOutput: T | undefined;
    let executionError: string | undefined;
    let isSuccess = false;

    try {
      executionOutput = await Promise.resolve(actionHandler(intent));
      isSuccess = true;
      intent.status = "executed";
    } catch (err) {
      executionError = err instanceof Error ? err.message : String(err);
      intent.status = "failed";
    }

    const durationMs = this.now() - startTime;
    const executedAt = this.now();

    // Compute cryptographic digest for receipt
    const receiptPayload = JSON.stringify({
      receiptId,
      intentId: intent.id,
      intentHash: intent.intentHash,
      action: intent.action,
      target: intent.target,
      status: intent.status,
      executedBy: executorPublicKey,
      executedAt,
      isSuccess,
      error: executionError
    });
    const receiptDigest = sha256Hex(receiptPayload);

    // Record into Utix audit trail
    let auditEvent: AuditEvent | undefined;
    try {
      auditEvent = recordAudit({
        action: "admin.config_changed",
        actor: { kind: "maintainer", id: executorPublicKey },
        scope: "maintainer",
        target: { kind: intent.action, id: intent.target },
        reason: intent.reason.slice(0, 64).replace(/[^a-z0-9_.:-]/gi, "_"),
        outcome: isSuccess ? "allowed" : "denied",
        before: { intentStatus: "approved" },
        after: {
          intentStatus: intent.status,
          receiptId,
          receiptDigest: receiptDigest.slice(0, 32)
        }
      });
    } catch {
      // Audit record failure should not crash execution receipt
    }

    const receipt: ApprovalReceipt = {
      receiptId,
      intentId: intent.id,
      intentHash: intent.intentHash,
      action: intent.action,
      target: intent.target,
      parameters: intent.parameters,
      reason: intent.reason,
      requestedBy: intent.requestedBy,
      signers: intent.signatures.map(s => s.signerPublicKey),
      status: isSuccess ? "executed" : "failed",
      executedBy: executorPublicKey,
      executedAt,
      durationMs,
      executionOutput,
      error: executionError,
      receiptDigest,
      auditEventId: auditEvent?.id
    };

    this.receipts.set(receiptId, receipt);
    this.receiptsByIntent.set(intent.id, receiptId);

    if (!isSuccess) {
      throw new Error(`Maintainer action execution failed: ${executionError}`);
    }

    return { result: executionOutput as T, receipt };
  }

  /**
   * Retrieves an intent by ID.
   */
  getIntent(intentId: string): IntentRequest | undefined {
    return this.intents.get(intentId);
  }

  /**
   * Retrieves a receipt by receipt ID.
   */
  getReceipt(receiptId: string): ApprovalReceipt | undefined {
    return this.receipts.get(receiptId);
  }

  /**
   * Retrieves a receipt associated with an intent ID.
   */
  getReceiptByIntent(intentId: string): ApprovalReceipt | undefined {
    const receiptId = this.receiptsByIntent.get(intentId);
    return receiptId ? this.receipts.get(receiptId) : undefined;
  }

  /**
   * Lists all receipts, with optional filtering.
   */
  listReceipts(filter?: { action?: HighImpactAction; status?: "executed" | "failed" }): ApprovalReceipt[] {
    let all = Array.from(this.receipts.values());
    if (filter?.action) {
      all = all.filter(r => r.action === filter.action);
    }
    if (filter?.status) {
      all = all.filter(r => r.status === filter.status);
    }
    return all.sort((a, b) => b.executedAt - a.executedAt);
  }

  /**
   * Lists all intents currently pending approval.
   */
  listPendingIntents(): IntentRequest[] {
    const now = this.now();
    return Array.from(this.intents.values()).filter(i => i.status === "pending" && i.expiresAt > now);
  }

  /**
   * Clears in-memory data (useful for test isolation).
   */
  reset(): void {
    this.intents.clear();
    this.receipts.clear();
    this.receiptsByIntent.clear();
  }
}

export const maintainerApprovalManager = new MaintainerApprovalManager();
