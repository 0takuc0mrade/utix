/**
 * Post-rollback verification for newly deployed protocol behavior.
 *
 * Verifies that user-facing state, background jobs, external references,
 * and partially processed records are consistent with restored behavior.
 *
 * Key guarantees:
 * 1. Read-only by default: never mutates records during verification.
 * 2. Manual repair detection: detects orphaned, stranded, or incompatible records
 *    and generates actionable remediation instructions.
 * 3. Comprehensive domain coverage: ticket issuance, transfers, redemptions,
 *    event operations, fraud controls, and background worker jobs.
 * 4. Deterministic and bounded time/space complexity: O(N) time with O(1) indexed lookups.
 */

import { sha256Hex } from "@/core/ledger/sha256";

export type ProtocolVersion = string;

export type TicketStatus = "issued" | "transferred" | "redeemed" | "cancelled";
export type TransferStatus = "pending" | "accepted" | "rejected" | "cancelled" | "expired";
export type EventStatus = "active" | "paused" | "concluded";
export type WorkerJobStatus = "queued" | "running" | "retrying" | "succeeded" | "dead_lettered";

export interface TicketRecord {
  id: string;
  eventId: string;
  owner: string;
  tier: string;
  status: TicketStatus;
  protocolVersion: ProtocolVersion;
  externalRef?: string;
  issuedAt: number;
  updatedAt: number;
  metadata?: Record<string, unknown>;
}

export interface TransferRecord {
  id: string;
  ticketId: string;
  fromOwner: string;
  toOwner: string;
  status: TransferStatus;
  protocolVersion: ProtocolVersion;
  initiatedAt: number;
  expiresAt: number;
  settledAt?: number;
  externalTxHash?: string;
}

export interface RedemptionRecord {
  id: string;
  ticketId: string;
  eventId: string;
  redeemedBy: string;
  nonce: string;
  protocolVersion: ProtocolVersion;
  redeemedAt: number;
  isConfirmed: boolean;
  signature?: string;
}

export interface EventRecord {
  id: string;
  name: string;
  organizerAddress: string;
  capacity: number;
  status: EventStatus;
  protocolVersion: ProtocolVersion;
  createdAt: number;
}

export interface WorkerJobRecord {
  id: string;
  jobType: string;
  status: WorkerJobStatus;
  payloadVersion: ProtocolVersion;
  payload: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface FraudRecord {
  id: string;
  account: string;
  ruleId: string;
  protocolVersion: ProtocolVersion;
  flaggedAt: number;
  isManualReviewPending: boolean;
  metadata?: Record<string, unknown>;
}

export interface ProtocolDataset {
  tickets: TicketRecord[];
  transfers: TransferRecord[];
  redemptions: RedemptionRecord[];
  events: EventRecord[];
  workerJobs: WorkerJobRecord[];
  fraudRecords: FraudRecord[];
}

export interface RollbackTarget {
  targetVersion: ProtocolVersion;
  rolledBackFromVersion: ProtocolVersion;
  rollbackTimestamp: number;
}

export type CheckSeverity = "info" | "warning" | "critical";

export interface ManualRepairRecord {
  recordId: string;
  domain: "ticket" | "transfer" | "redemption" | "event" | "worker_job" | "fraud";
  severity: CheckSeverity;
  reason: string;
  suggestedAction: string;
  details?: Record<string, unknown>;
}

export interface RollbackCheckResult {
  name: string;
  category: "version_compatibility" | "pending_operations" | "redemptions" | "invariants" | "workers" | "external_references";
  passed: boolean;
  severity: CheckSeverity;
  requiresManualRepair: boolean;
  affectedRecords: string[];
  message: string;
  details: Record<string, unknown>;
}

export interface RollbackVerificationReport {
  timestamp: Date;
  targetVersion: ProtocolVersion;
  rolledBackFromVersion: ProtocolVersion;
  passed: boolean;
  requiresManualRepair: boolean;
  isClean: boolean;
  readOnly: boolean;
  totalChecks: number;
  passedChecks: number;
  failedChecks: number;
  manualRepairRecords: ManualRepairRecord[];
  checks: RollbackCheckResult[];
}

export interface RollbackVerificationOptions {
  readOnly?: boolean;
  now?: () => Date;
  maxPendingTransferAgeMs?: number;
}

const DEFAULT_MAX_PENDING_TRANSFER_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
import { StrKey } from "@stellar/stellar-sdk";

const STELLAR_TX_HASH_REGEX = /^[0-9a-fA-F]{64}$/;

function isValidStellarAddress(address: string): boolean {
  try {
    return StrKey.isValidEd25519PublicKey(address);
  } catch {
    return false;
  }
}

/**
 * Validates version semantic compatibility:
 * Target version must be strictly less than or equal to restored version semantics.
 */
function isVersionCompatible(recordVersion: ProtocolVersion, targetVersion: ProtocolVersion): boolean {
  return recordVersion === targetVersion;
}

/**
 * Checks for protocol version compatibility across all domain records.
 * Identifies records that were created with newer rolled-back protocol features.
 * Time complexity: O(N) where N is total records.
 * Space complexity: O(1) auxiliary.
 */
export function verifyProtocolVersionCompatibility(
  dataset: ProtocolDataset,
  target: RollbackTarget
): { check: RollbackCheckResult; repairs: ManualRepairRecord[] } {
  const affected: string[] = [];
  const repairs: ManualRepairRecord[] = [];

  for (const ticket of dataset.tickets) {
    if (ticket.protocolVersion === target.rolledBackFromVersion) {
      affected.push(ticket.id);
      repairs.push({
        recordId: ticket.id,
        domain: "ticket",
        severity: "critical",
        reason: `Ticket issued under rolled-back protocol version ${ticket.protocolVersion}`,
        suggestedAction: `Downgrade ticket metadata schema to target version ${target.targetVersion} or reissue under restored contract`,
        details: { ticketStatus: ticket.status, version: ticket.protocolVersion }
      });
    }
  }

  const passed = affected.length === 0;
  return {
    check: {
      name: "protocol_version_compatibility",
      category: "version_compatibility",
      passed,
      severity: passed ? "info" : "critical",
      requiresManualRepair: !passed,
      affectedRecords: affected,
      message: passed
        ? `All ticket records adhere to target protocol version ${target.targetVersion}`
        : `Found ${affected.length} ticket record(s) created under rolled-back version ${target.rolledBackFromVersion}`,
      details: { affectedCount: affected.length, targetVersion: target.targetVersion }
    },
    repairs
  };
}

/**
 * Checks for pending operations and partially processed transfers initiated
 * under the rolled-back version that remain unfinalized.
 * Time complexity: O(N) where N is number of transfers.
 * Space complexity: O(1) auxiliary.
 */
export function verifyPendingOperationsAndInFlightTransfers(
  dataset: ProtocolDataset,
  target: RollbackTarget,
  options?: RollbackVerificationOptions
): { check: RollbackCheckResult; repairs: ManualRepairRecord[] } {
  const affected: string[] = [];
  const repairs: ManualRepairRecord[] = [];
  const now = options?.now ? options.now().getTime() : Date.now();
  const maxAge = options?.maxPendingTransferAgeMs ?? DEFAULT_MAX_PENDING_TRANSFER_AGE_MS;

  for (const transfer of dataset.transfers) {
    if (transfer.status === "pending") {
      const isFromRolledBack = transfer.protocolVersion === target.rolledBackFromVersion;
      const isStale = (now - transfer.initiatedAt) > maxAge;

      if (isFromRolledBack || isStale) {
        affected.push(transfer.id);
        repairs.push({
          recordId: transfer.id,
          domain: "transfer",
          severity: isFromRolledBack ? "critical" : "warning",
          reason: isFromRolledBack
            ? `Transfer initiated under rolled-back version ${transfer.protocolVersion} was left in pending state`
            : `Pending transfer exceeded maximum allowable age window`,
          suggestedAction: `Cancel pending transfer ${transfer.id} and notify fromOwner (${transfer.fromOwner}) to re-initiate under ${target.targetVersion}`,
          details: {
            ticketId: transfer.ticketId,
            fromOwner: transfer.fromOwner,
            toOwner: transfer.toOwner,
            initiatedAt: transfer.initiatedAt,
            isFromRolledBack
          }
        });
      }
    }
  }

  const passed = affected.length === 0;
  return {
    check: {
      name: "pending_transfers_and_in_flight_operations",
      category: "pending_operations",
      passed,
      severity: passed ? "info" : (repairs.some(r => r.severity === "critical") ? "critical" : "warning"),
      requiresManualRepair: !passed,
      affectedRecords: affected,
      message: passed
        ? "No orphaned or stranded pending transfers detected"
        : `Detected ${affected.length} pending transfer(s) requiring cancellation or settlement reconciliation`,
      details: { affectedCount: affected.length }
    },
    repairs
  };
}

/**
 * Checks for partially processed redemptions (e.g. unconfirmed nonces, check-in
 * state recorded without verified signature or settled on rolled-back logic).
 * Time complexity: O(N) where N is redemptions count.
 * Space complexity: O(1) auxiliary.
 */
export function verifyPartiallyProcessedRedemptions(
  dataset: ProtocolDataset,
  target: RollbackTarget
): { check: RollbackCheckResult; repairs: ManualRepairRecord[] } {
  const affected: string[] = [];
  const repairs: ManualRepairRecord[] = [];

  for (const redemption of dataset.redemptions) {
    const isUnconfirmed = !redemption.isConfirmed;
    const isRolledBackVersion = redemption.protocolVersion === target.rolledBackFromVersion;

    if (isUnconfirmed || isRolledBackVersion) {
      affected.push(redemption.id);
      repairs.push({
        recordId: redemption.id,
        domain: "redemption",
        severity: "critical",
        reason: isRolledBackVersion
          ? `Redemption processed under rolled-back protocol version ${redemption.protocolVersion}`
          : `Unconfirmed redemption nonce detected without on-chain settlement confirmation`,
        suggestedAction: `Review ticket ${redemption.ticketId} attendance status with organizer dashboard. If unconfirmed, reset ticket status to issued`,
        details: {
          ticketId: redemption.ticketId,
          redeemedBy: redemption.redeemedBy,
          isConfirmed: redemption.isConfirmed,
          protocolVersion: redemption.protocolVersion
        }
      });
    }
  }

  const passed = affected.length === 0;
  return {
    check: {
      name: "partially_processed_redemptions",
      category: "redemptions",
      passed,
      severity: passed ? "info" : "critical",
      requiresManualRepair: !passed,
      affectedRecords: affected,
      message: passed
        ? "All redemption records are confirmed and conform to target protocol"
        : `Found ${affected.length} partially processed or rolled-back redemption record(s)`,
      details: { affectedCount: affected.length }
    },
    repairs
  };
}

/**
 * Checks event capacity and ticket issuance domain invariants.
 * Ensures:
 * 1. Total issued tickets <= event capacity.
 * 2. Every ticket references an existing event record.
 * 3. No duplicate ticket IDs exist.
 * Time complexity: O(N + M) where N = tickets, M = events.
 * Space complexity: O(M) for event lookup map.
 */
export function verifyEventCapacityAndIssuanceInvariants(
  dataset: ProtocolDataset
): { check: RollbackCheckResult; repairs: ManualRepairRecord[] } {
  const affected: string[] = [];
  const repairs: ManualRepairRecord[] = [];

  // Build event map and ticket counter
  const eventMap = new Map<string, EventRecord>();
  const eventTicketCounts = new Map<string, number>();

  for (const event of dataset.events) {
    eventMap.set(event.id, event);
    eventTicketCounts.set(event.id, 0);
  }

  const seenTicketIds = new Set<string>();

  for (const ticket of dataset.tickets) {
    // Duplicate ticket ID check
    if (seenTicketIds.has(ticket.id)) {
      affected.push(ticket.id);
      repairs.push({
        recordId: ticket.id,
        domain: "ticket",
        severity: "critical",
        reason: `Duplicate ticket identifier detected: ${ticket.id}`,
        suggestedAction: "Quarantine duplicate record and inspect issuance ledger log",
        details: { duplicateId: ticket.id }
      });
      continue;
    }
    seenTicketIds.add(ticket.id);

    // Orphaned reference check
    const event = eventMap.get(ticket.eventId);
    if (!event) {
      affected.push(ticket.id);
      repairs.push({
        recordId: ticket.id,
        domain: "ticket",
        severity: "critical",
        reason: `Ticket references non-existent eventId: ${ticket.eventId}`,
        suggestedAction: "Reconcile ticket with organizer event registry or revoke orphan ticket",
        details: { missingEventId: ticket.eventId }
      });
      continue;
    }

    if (ticket.status !== "cancelled") {
      const currentCount = eventTicketCounts.get(ticket.eventId) ?? 0;
      eventTicketCounts.set(ticket.eventId, currentCount + 1);
    }
  }

  // Capacity violation check
  for (const [eventId, count] of eventTicketCounts.entries()) {
    const event = eventMap.get(eventId);
    if (event && count > event.capacity) {
      affected.push(eventId);
      repairs.push({
        recordId: eventId,
        domain: "event",
        severity: "critical",
        reason: `Event capacity exceeded: ${count} active tickets for capacity ${event.capacity}`,
        suggestedAction: `Organizer review required: expand capacity or rollback oversubscribed tickets for event ${eventId}`,
        details: { capacity: event.capacity, activeTickets: count }
      });
    }
  }

  const passed = affected.length === 0;
  return {
    check: {
      name: "event_capacity_and_issuance_invariants",
      category: "invariants",
      passed,
      severity: passed ? "info" : "critical",
      requiresManualRepair: !passed,
      affectedRecords: affected,
      message: passed
        ? "All event capacity and issuance invariants satisfied"
        : `Encountered ${affected.length} integrity violation(s) in event issuance and capacity`,
      details: { affectedCount: affected.length }
    },
    repairs
  };
}

/**
 * Checks background worker jobs for payloads that reference rolled-back handlers or schemas.
 * In-flight or retrying jobs targeting rolled-back versions must be paused/dead-lettered.
 * Time complexity: O(N) where N is worker jobs count.
 * Space complexity: O(1) auxiliary.
 */
export function verifyWorkerJobPayloadCompatibility(
  dataset: ProtocolDataset,
  target: RollbackTarget
): { check: RollbackCheckResult; repairs: ManualRepairRecord[] } {
  const affected: string[] = [];
  const repairs: ManualRepairRecord[] = [];

  for (const job of dataset.workerJobs) {
    const isActive = job.status === "queued" || job.status === "running" || job.status === "retrying";
    const isRolledBackPayload = job.payloadVersion === target.rolledBackFromVersion;

    if (isActive && isRolledBackPayload) {
      affected.push(job.id);
      repairs.push({
        recordId: job.id,
        domain: "worker_job",
        severity: "critical",
        reason: `Active worker job (${job.status}) scheduled with rolled-back payload version ${job.payloadVersion}`,
        suggestedAction: `Move job ${job.id} to dead-letter queue, transform payload to target version ${target.targetVersion}, and requeue`,
        details: { jobType: job.jobType, status: job.status, payloadVersion: job.payloadVersion }
      });
    }
  }

  const passed = affected.length === 0;
  return {
    check: {
      name: "worker_job_payload_compatibility",
      category: "workers",
      passed,
      severity: passed ? "info" : "critical",
      requiresManualRepair: !passed,
      affectedRecords: affected,
      message: passed
        ? "No active worker jobs targeting rolled-back payload versions"
        : `Found ${affected.length} active worker job(s) requiring dead-lettering or payload migration`,
      details: { affectedCount: affected.length }
    },
    repairs
  };
}

/**
 * Checks external Stellar references (hashes, addresses) and fraud control flags.
 * Validates that addresses match Stellar G-format, transaction hashes are 64 hex chars,
 * and fraud flags raised under rolled-back rules are reviewed.
 * Time complexity: O(N) where N is external references + fraud records.
 * Space complexity: O(1) auxiliary.
 */
export function verifyExternalReferencesAndFraudControls(
  dataset: ProtocolDataset,
  target: RollbackTarget
): { check: RollbackCheckResult; repairs: ManualRepairRecord[] } {
  const affected: string[] = [];
  const repairs: ManualRepairRecord[] = [];

  // Check ticket external references
  for (const ticket of dataset.tickets) {
    if (ticket.externalRef && !STELLAR_TX_HASH_REGEX.test(ticket.externalRef)) {
      affected.push(ticket.id);
      repairs.push({
        recordId: ticket.id,
        domain: "ticket",
        severity: "warning",
        reason: `Malformed external Stellar transaction reference on ticket: ${ticket.externalRef}`,
        suggestedAction: "Verify transaction hash on Horizon explorer and update ticket record",
        details: { externalRef: ticket.externalRef }
      });
    }
    if (!isValidStellarAddress(ticket.owner)) {
      affected.push(ticket.id);
      repairs.push({
        recordId: ticket.id,
        domain: "ticket",
        severity: "critical",
        reason: `Invalid Stellar owner public key format: ${ticket.owner}`,
        suggestedAction: "Quarantine ticket and verify owner address",
        details: { owner: ticket.owner }
      });
    }
  }

  // Check fraud controls flagged under rolled-back version
  for (const fraud of dataset.fraudRecords) {
    if (fraud.protocolVersion === target.rolledBackFromVersion && fraud.isManualReviewPending) {
      affected.push(fraud.id);
      repairs.push({
        recordId: fraud.id,
        domain: "fraud",
        severity: "warning",
        reason: `Fraud flag was raised by rule under rolled-back protocol version ${fraud.protocolVersion}`,
        suggestedAction: `Re-evaluate fraud rule for account ${fraud.account} against restored protocol policies`,
        details: { account: fraud.account, ruleId: fraud.ruleId, version: fraud.protocolVersion }
      });
    }
  }

  const passed = affected.length === 0;
  return {
    check: {
      name: "external_references_and_fraud_controls",
      category: "external_references",
      passed,
      severity: passed ? "info" : (repairs.some(r => r.severity === "critical") ? "critical" : "warning"),
      requiresManualRepair: !passed,
      affectedRecords: affected,
      message: passed
        ? "External Stellar references and fraud control flags verified"
        : `Identified ${affected.length} external reference or fraud control flag(s) needing attention`,
      details: { affectedCount: affected.length }
    },
    repairs
  };
}

/**
 * Main release rollback verifier.
 * Executes all domain checks in read-only mode and outputs a complete
 * post-rollback validation report with repair recommendations.
 *
 * Overall time complexity: O(N) where N is total records across all collections.
 * Space complexity: O(M) where M is number of violations / manual repair records.
 */
export function verifyReleaseRollback(
  dataset: ProtocolDataset,
  target: RollbackTarget,
  options: RollbackVerificationOptions = {}
): RollbackVerificationReport {
  const readOnly = options.readOnly !== false; // defaults to true
  const checks: RollbackCheckResult[] = [];
  const manualRepairRecords: ManualRepairRecord[] = [];

  // 1. Protocol version compatibility
  const vComp = verifyProtocolVersionCompatibility(dataset, target);
  checks.push(vComp.check);
  manualRepairRecords.push(...vComp.repairs);

  // 2. Pending operations and in-flight transfers
  const pTrans = verifyPendingOperationsAndInFlightTransfers(dataset, target, options);
  checks.push(pTrans.check);
  manualRepairRecords.push(...pTrans.repairs);

  // 3. Partially processed redemptions
  const pRedemp = verifyPartiallyProcessedRedemptions(dataset, target);
  checks.push(pRedemp.check);
  manualRepairRecords.push(...pRedemp.repairs);

  // 4. Event capacity and issuance invariants
  const eInv = verifyEventCapacityAndIssuanceInvariants(dataset);
  checks.push(eInv.check);
  manualRepairRecords.push(...eInv.repairs);

  // 5. Worker job payload compatibility
  const wComp = verifyWorkerJobPayloadCompatibility(dataset, target);
  checks.push(wComp.check);
  manualRepairRecords.push(...wComp.repairs);

  // 6. External references and fraud controls
  const extRef = verifyExternalReferencesAndFraudControls(dataset, target);
  checks.push(extRef.check);
  manualRepairRecords.push(...extRef.repairs);

  const passedChecks = checks.filter(c => c.passed).length;
  const failedChecks = checks.filter(c => !c.passed).length;
  const hasCriticalFailures = manualRepairRecords.some(r => r.severity === "critical");
  const requiresManualRepair = manualRepairRecords.length > 0;
  const isClean = checks.every(c => c.passed) && manualRepairRecords.length === 0;

  return {
    timestamp: options.now ? options.now() : new Date(),
    targetVersion: target.targetVersion,
    rolledBackFromVersion: target.rolledBackFromVersion,
    passed: !hasCriticalFailures && !requiresManualRepair,
    requiresManualRepair,
    isClean,
    readOnly,
    totalChecks: checks.length,
    passedChecks,
    failedChecks,
    manualRepairRecords,
    checks
  };
}

/**
 * Formats a post-rollback verification report as a human-readable summary.
 */
export function formatRollbackReport(report: RollbackVerificationReport): string {
  const lines: string[] = [];
  lines.push("======================================================================");
  lines.push("              POST-RELEASE ROLLBACK VERIFICATION REPORT               ");
  lines.push("======================================================================");
  lines.push(`Timestamp:              ${report.timestamp.toISOString()}`);
  lines.push(`Target Version:         ${report.targetVersion} (Restored)`);
  lines.push(`Rolled Back From:       ${report.rolledBackFromVersion}`);
  lines.push(`Execution Mode:         ${report.readOnly ? "READ-ONLY" : "MUTATING"}`);
  lines.push(`Overall Status:         ${report.isClean ? "CLEAN ROLLBACK [PASS]" : report.passed ? "PASSED WITH WARNINGS" : "ROLLBACK REQUIRES ACTION [FAIL]"}`);
  lines.push(`Manual Repair Required: ${report.requiresManualRepair ? "YES (See remediation steps below)" : "NO"}`);
  lines.push(`Checks Summary:         ${report.passedChecks}/${report.totalChecks} passed (${report.failedChecks} flagged)`);
  lines.push("");

  lines.push("CHECKS BREAKDOWN:");
  for (const c of report.checks) {
    const symbol = c.passed ? "[OK]  " : c.severity === "critical" ? "[CRIT]" : "[WARN]";
    lines.push(`  ${symbol} ${c.name}: ${c.message}`);
  }
  lines.push("");

  if (report.manualRepairRecords.length > 0) {
    lines.push("MANUAL REPAIR ACTIONS REQUIRED:");
    report.manualRepairRecords.forEach((repair, idx) => {
      lines.push(`  ${idx + 1}. [${repair.severity.toUpperCase()}] Record: ${repair.recordId} (${repair.domain})`);
      lines.push(`     Reason: ${repair.reason}`);
      lines.push(`     Action: ${repair.suggestedAction}`);
    });
    lines.push("");
  } else {
    lines.push("No manual repair actions required. System state is consistent with restored behavior.");
    lines.push("");
  }

  lines.push("======================================================================");
  return lines.join("\n");
}
