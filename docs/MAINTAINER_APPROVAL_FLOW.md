# Maintainer Action Approval Flow with Signed Intent Receipts

## Overview

High-impact maintainer actions in Utix (such as invoking an emergency kill-switch, applying reconciliation repairs, executing protocol rollbacks, modifying administrative configurations, or purging worker queues) require explicit intent, multi-party authorization, and immutable signed audit receipts.

The approval flow ensures that privileged operations cannot be executed unilaterally or by accident, cannot be replayed, and leave a permanent cryptographic audit trail.

## High-Impact Actions Covered

| Action | Description | Default Threshold |
| :--- | :--- | :--- |
| `emergency_killswitch` | Globally deactivates a compromised feature slice or endpoint | 2 maintainers |
| `protocol_rollback` | Restores prior protocol version schema and contract rules | 2 maintainers |
| `reconciliation_repair` | Applies automated mutations to resolve ledger drift | 2 maintainers |
| `admin_config_override` | Modifies core runtime administrative configuration | 2 maintainers |
| `quota_override` | Temporarily raises or lowers tenant rate limits / quotas | 1 maintainer |
| `dead_letter_purge` | Purges or requeues quarantined worker jobs | 1 maintainer |

## Architecture & Lifecycle

```
[ Maintainer 1: proposeIntent() ]
           │
           ▼
[ Canonical Intent Hash (SHA-256) ]
           │
           ├─► [ Maintainer 1: signIntent() (Ed25519) ]
           │
           ├─► [ Maintainer 2: signIntent() (Ed25519) ]
           │
           ▼ (Threshold Met)
[ Status: APPROVED ]
           │
           ▼
[ executeIntent() ] -> (Guardrails: Not Expired, Not Replayed)
           │
           ├─► Executes Action Callback
           ├─► Logs Audit Event to core/audit
           └─► Generates ApprovalReceipt with SHA-256 Digest
```

## Protocol Specifications

### 1. Intent Proposal
A maintainer initiates an action proposal by specifying:
- `action`: One of the recognized `HighImpactAction` types.
- `target`: The specific domain resource, slice slug, or configuration key.
- `parameters`: Key-value configuration for the action.
- `reason`: Mandatory non-empty string explaining why the action is required.
- `requestedBy`: Maintainer's Stellar Ed25519 public key (`G...`).
- `expiresInMs`: Expiry duration (defaults to 30 minutes).

### 2. Canonical Hashing
The intent payload is canonicalized by sorting all keys alphabetically and hashed with SHA-256:
```typescript
intentHash = sha256Hex(JSON.stringify(sortedPayload));
```

### 3. Cryptographic Signature
Each maintainer reviews the intent and signs the raw `intentHash` bytes using their private Ed25519 keypair:
```typescript
const signatureHex = maintainerKeypair.sign(Buffer.from(intent.intentHash, "hex")).toString("hex");
approvalManager.signIntent(intent.id, maintainerKeypair.publicKey(), signatureHex);
```
Signatures are validated using `@stellar/stellar-sdk`'s `Keypair.fromPublicKey(signer).verify(...)`.

### 4. Guarded Execution & Replay Protection
When `executeIntent` is invoked:
- Verifies `status === 'approved'`.
- Verifies `Date.now() <= expiresAt`.
- Immediately transitions status to `executing` to block concurrent or replay invocations.
- Wraps execution in a try/catch block.
- Generates a permanent `ApprovalReceipt` containing execution status, output, duration, and error details (if any).
- Emits an audit event into `core/audit/audit.ts` under maintainer scope.

### 5. Review & Query API
Maintainers can inspect past receipts and pending intents:
```typescript
const pending = approvalManager.listPendingIntents();
const receipts = approvalManager.listReceipts({ action: "emergency_killswitch" });
const receipt = approvalManager.getReceipt(receiptId);
```

## Operational Edge Cases and Recovery

1. **Maintainer Key Compromise**: If a maintainer's key is suspected compromised, other maintainers must reject any pending intents signed by that key and update the authorized maintainer allowlist.
2. **Expired Intents**: Intents not signed before their expiration time automatically transition to `expired` and cannot be executed. A new intent with fresh nonce must be proposed.
3. **Execution Failure Recovery**: If an action fails mid-execution, the receipt records `status: "failed"` with full stack trace and error message, allowing operators to diagnose root cause and plan recovery.
