/**
 * Consistency checks for the seed dataset (#185).
 *
 * `validateSeedDataset` returns every way the records disagree with each other,
 * or an empty list when they agree. It builds on the existing domain
 * invariants (`core/invariants`), recomputes every settlement's fees with the
 * fee module (`core/fees`), and reuses the renewal grace period from
 * `core/authorizations`, so the seed cannot silently drift from the rules the
 * rest of the codebase enforces.
 */

import { DEFAULT_RENEWAL_GRACE_MS } from "@/core/authorizations/store";
import { calculateFees, reconcileFees } from "@/core/fees/fees";
import { DomainInvariantChecker } from "@/core/invariants/checker";
import { SEED_ASSET, seedFeeSchedule } from "./data";
import type { SeedDataset, SeedIssue, SeedIssueCode } from "./types";

/** Seed addresses are placeholders: never a real, fundable Stellar key. */
const PLACEHOLDER_ADDRESS = /^G_SEED_[A-Z_]+$/;

export function validateSeedDataset(dataset: SeedDataset): SeedIssue[] {
  const issues: SeedIssue[] = [];
  const report = (code: SeedIssueCode, entityId: string, message: string): void => {
    issues.push({ code, entityId, message });
  };
  const { now, state } = dataset;

  for (const violation of DomainInvariantChecker.verifyAll(state)) {
    report("invariant_violation", violation.entityId, `${violation.invariantId}: ${violation.message}`);
  }

  const addresses: Array<[string, string]> = [];
  for (const event of state.events.values()) addresses.push([event.id, event.organizerAddress]);
  for (const entry of state.tickets.values()) addresses.push([entry.id, entry.ownerAddress]);
  for (const transfer of state.transfers) {
    addresses.push([transfer.id, transfer.fromAddress], [transfer.id, transfer.toAddress]);
  }
  for (const address of state.blacklistedAddresses) addresses.push(["blacklist", address]);
  for (const entry of dataset.authorizations) addresses.push([entry.id, entry.grantor], [entry.id, entry.grantee]);
  for (const [entityId, address] of addresses) {
    if (!PLACEHOLDER_ADDRESS.test(address)) {
      report("address_not_placeholder", entityId, `${address} is not a G_SEED_* placeholder`);
    }
  }

  const ticketCounts = new Map<string, number>();
  for (const entry of state.tickets.values()) {
    if (!state.events.has(entry.eventId)) {
      report("ticket_event_missing", entry.id, `Ticket references unknown event ${entry.eventId}`);
    }
    ticketCounts.set(entry.eventId, (ticketCounts.get(entry.eventId) ?? 0) + 1);
    if (entry.issuedAt > now) report("future_record", entry.id, "Ticket was issued after the seed instant");
  }
  for (const event of state.events.values()) {
    const actual = ticketCounts.get(event.id) ?? 0;
    if (event.issuedCount !== actual) {
      report("event_issued_count_mismatch", event.id, `issuedCount ${event.issuedCount} but ${actual} tickets exist`);
    }
  }

  const settlementsByTransfer = new Map(
    dataset.settlements.filter((entry) => entry.transferId !== null).map((entry) => [entry.transferId, entry])
  );
  for (const transfer of state.transfers) {
    const settlement = settlementsByTransfer.get(transfer.id);
    if (!state.tickets.has(transfer.ticketId)) {
      report("transfer_ticket_missing", transfer.id, `Transfer references unknown ticket ${transfer.ticketId}`);
    }
    if (transfer.timestamp > now) report("future_record", transfer.id, "Transfer happened after the seed instant");
    if (!settlement) {
      report("transfer_without_settlement", transfer.id, "No settlement references this transfer");
    } else if (
      settlement.status !== "settled" ||
      settlement.ticketId !== transfer.ticketId ||
      settlement.priceStroops !== transfer.priceStroops ||
      settlement.organizerFeeStroops !== transfer.organizerFeeStroops ||
      settlement.protocolFeeStroops !== transfer.protocolFeeStroops ||
      settlement.sellerProceedsStroops !== transfer.sellerProceedsStroops
    ) {
      report("settlement_transfer_mismatch", settlement.id, `Settlement disagrees with transfer ${transfer.id}`);
    }
  }

  for (const settlement of dataset.settlements) {
    if (settlement.status === "settled") {
      if (!settlement.transferId || !state.transfers.some((transfer) => transfer.id === settlement.transferId)) {
        report("settlement_transfer_mismatch", settlement.id, "Settled settlement has no matching transfer");
      }
    } else if (settlement.transferId !== null || !settlement.failureReason) {
      report("failed_settlement_inconsistent", settlement.id, "A failed settlement has no transfer and states why");
    }

    const entry = state.tickets.get(settlement.ticketId);
    const event = entry ? state.events.get(entry.eventId) : undefined;
    if (!event) {
      report("settlement_fee_mismatch", settlement.id, `Settlement references unknown ticket ${settlement.ticketId}`);
      continue;
    }
    const breakdown = calculateFees({
      asset: SEED_ASSET,
      amount: BigInt(settlement.priceStroops),
      schedule: seedFeeSchedule(event.feeBasisPoints)
    });
    const reconciliation = breakdown.ok
      ? reconcileFees(breakdown.value, {
          gross: BigInt(settlement.priceStroops),
          lines: {
            protocol: BigInt(settlement.protocolFeeStroops),
            organizer: BigInt(settlement.organizerFeeStroops)
          },
          net: BigInt(settlement.sellerProceedsStroops)
        })
      : undefined;
    if (!reconciliation?.matches) {
      report("settlement_fee_mismatch", settlement.id, "Stored fees differ from the fee module's breakdown");
    }
    if (settlement.attemptedAt > now) report("future_record", settlement.id, "Settlement is after the seed instant");
  }

  for (const entry of dataset.authorizations) {
    const problems: string[] = [];
    if (entry.resourceId !== null && !state.events.has(entry.resourceId)) problems.push("unknown resource");
    if (Date.parse(entry.issuedAt) > now) problems.push("issued after the seed instant");
    if (Date.parse(entry.expiresAt) <= Date.parse(entry.issuedAt)) problems.push("expires before it was issued");
    if (entry.status === "revoked" && !entry.revokedAt) problems.push("revoked without revokedAt");
    if (entry.status === "cleaned") {
      if (!entry.cleanedAt) problems.push("cleaned without cleanedAt");
      else if (Date.parse(entry.cleanedAt) - Date.parse(entry.expiresAt) <= DEFAULT_RENEWAL_GRACE_MS) {
        problems.push("cleaned inside the renewal grace period");
      }
    }
    if (entry.renewals > 0 && !entry.lastRenewedAt) problems.push("renewed without lastRenewedAt");
    for (const problem of problems) report("authorization_inconsistent", entry.id, problem);
  }

  for (const workflow of dataset.workflows) {
    if (!state.tickets.has(workflow.ticketId)) {
      report("workflow_inconsistent", workflow.id, `Workflow references unknown ticket ${workflow.ticketId}`);
    }
    if (workflow.dueAt <= workflow.openedAt) report("workflow_inconsistent", workflow.id, "Due before it was opened");
    if (workflow.status === "completed" && workflow.completedAt === undefined) {
      report("workflow_inconsistent", workflow.id, "Completed without completedAt");
    }
    if (workflow.status === "open" && workflow.completedAt !== undefined) {
      report("workflow_inconsistent", workflow.id, "Open with a completedAt");
    }
    if (workflow.openedAt > now) report("future_record", workflow.id, "Workflow opened after the seed instant");
  }

  return issues;
}

/** Open workflows whose due date has passed at the seed instant. */
export function overdueWorkflows(dataset: SeedDataset) {
  return dataset.workflows.filter((workflow) => workflow.status === "open" && workflow.dueAt < dataset.now);
}
