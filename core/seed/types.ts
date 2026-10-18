/**
 * Types for the contributor-safe seed dataset (#185).
 *
 * The dataset reuses the domain model (`core/invariants`) and the delegated
 * permission model (`core/authorizations`), and adds the two record kinds the
 * edge cases need: settlements and workflows.
 */

import type { Authorization } from "@/core/authorizations/types";
import type { DomainState } from "@/core/invariants/types";

export type SeedSettlementStatus = "settled" | "failed";

/** The money movement behind a transfer, including attempts that failed. */
export interface SeedSettlement {
  readonly id: string;
  readonly ticketId: string;
  /** The transfer this settled, or `null` when the settlement failed. */
  readonly transferId: string | null;
  readonly status: SeedSettlementStatus;
  readonly priceStroops: number;
  readonly organizerFeeStroops: number;
  readonly protocolFeeStroops: number;
  readonly sellerProceedsStroops: number;
  readonly attemptedAt: number;
  /** Required when `status` is `failed`. */
  readonly failureReason?: string;
}

export type SeedWorkflowKind = "refund_review" | "organizer_payout";

/** An operational task with a deadline. Open and past due means overdue. */
export interface SeedWorkflow {
  readonly id: string;
  readonly kind: SeedWorkflowKind;
  readonly ticketId: string;
  readonly status: "open" | "completed";
  readonly openedAt: number;
  readonly dueAt: number;
  readonly completedAt?: number;
}

export interface SeedDataset {
  /** The fixed instant every record is relative to; never the wall clock. */
  readonly now: number;
  readonly state: DomainState;
  readonly settlements: readonly SeedSettlement[];
  readonly authorizations: readonly Authorization[];
  readonly workflows: readonly SeedWorkflow[];
}

export type SeedIssueCode =
  | "invariant_violation"
  | "address_not_placeholder"
  | "ticket_event_missing"
  | "event_issued_count_mismatch"
  | "future_record"
  | "transfer_ticket_missing"
  | "transfer_without_settlement"
  | "settlement_transfer_mismatch"
  | "settlement_fee_mismatch"
  | "failed_settlement_inconsistent"
  | "authorization_inconsistent"
  | "workflow_inconsistent";

export interface SeedIssue {
  readonly code: SeedIssueCode;
  readonly entityId: string;
  readonly message: string;
}
