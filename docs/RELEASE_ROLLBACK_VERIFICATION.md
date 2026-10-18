# Release Rollback Verification Runbook

## Overview

When protocol or smart contract deployments are rolled back (for instance, retreating from a newly deployed protocol version `1.1.0` back to stable `1.0.0`), maintainers must verify that user-facing state, pending operations, background jobs, and external references remain completely consistent with the restored behavior.

Utix provides an automated, read-only post-rollback verification suite in `core/recovery/rollback-verifier.ts` backed by the CLI command `scripts/verify-release-rollback.mjs`.

## Guarantees

1. **Read-only by Default**: All verification checks evaluate state immutably. No database mutations, state transitions, or record updates occur during verification.
2. **Manual Repair Detection**: Any orphaned records, stranded in-flight operations, or incompatible payload schemas are flagged with explicit `requiresManualRepair: true` flags and actionable remediation instructions.
3. **Comprehensive Invariant Coverage**:
   - Protocol version compatibility across tickets, events, transfers, and redemptions.
   - Pending operations and in-flight transfer expiration/reconciliation.
   - Unconfirmed redemptions and nonce validation.
   - Event capacity boundaries and duplicate ID prevention.
   - Background worker job payload compatibility.
   - External Stellar public key (G-address) and transaction hash format validity.

## Quick Start

Run read-only post-rollback verification:

```bash
npm run rollback:verify
# or
node scripts/verify-release-rollback.mjs --target 1.0.0 --from 1.1.0
```

Machine-readable JSON output for monitoring pipelines:

```bash
node scripts/verify-release-rollback.mjs --json
```

## Exit Codes

- `0`: All verification checks passed; system is in a clean, consistent state.
- `1`: Manual repair is required or critical integrity checks failed.
- `2`: Internal execution error.

## Rollback Verification Categories

### 1. Protocol Version Compatibility
Ensures no active records contain schemas or features belonging to the rolled-back version.
- **Critical Violation**: Active tickets or event records stamped with rolled-back protocol version.
- **Remediation**: Reissue tickets under restored version or apply state view downgrade.

### 2. Pending Operations and In-Flight Transfers
Checks for transfers initiated under the rolled-back version that remained in `pending` status.
- **Critical Violation**: Pending transfer initiated under rolled-back rules.
- **Remediation**: Cancel pending transfer and notify owner to re-initiate under restored protocol.

### 3. Partially Processed Redemptions
Detects redemption records marked with unconfirmed nonces or executed under deprecated redemption contracts.
- **Critical Violation**: Unconfirmed redemption or rolled-back redemption nonce.
- **Remediation**: Verify physical check-in status on organizer dashboard; reset ticket to `issued` if unconfirmed.

### 4. Event Capacity & Issuance Invariants
Enforces core ticketing invariants:
- Total issued active tickets <= event capacity.
- Every ticket references an existing event ID.
- No duplicate ticket IDs exist.

### 5. Worker Job Payload Compatibility
Inspects queued, running, and retrying worker jobs in background queues.
- **Critical Violation**: Active job with payload schema matching the rolled-back version.
- **Remediation**: Move job to dead-letter queue, transform payload to target version, and requeue.

### 6. External References and Fraud Controls
Validates external Stellar references (64-character hex transaction hashes, 56-character Ed25519 public keys) and flags fraud controls triggered under rolled-back rules for manual review.

## Manual Repair Workflow

When `requiresManualRepair: true`:
1. Inspect the `manualRepairRecords` array in the verification report.
2. Follow the `suggestedAction` provided for each flagged record.
3. Once remediation is applied, re-run `node scripts/verify-release-rollback.mjs`.
4. Ensure the report outputs `CLEAN ROLLBACK [PASS]` before resuming public developer workflows.
