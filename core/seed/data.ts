/**
 * Deterministic seed data for contributors (#185).
 *
 * Everything here is a committed literal relative to one fixed instant. There
 * is no clock, randomness, network or credential involved, and every address is
 * an obvious `G_SEED_*` placeholder rather than a real Stellar key, so the data
 * is safe to commit and to load anywhere.
 *
 * It covers the core workflows (issuance, transfer, redemption) and the edge
 * cases contributors usually have to invent for themselves:
 *
 * - a failed settlement: `settle-seed-failed` moved no money and left the
 *   ticket with its seller;
 * - revoked access: a fraud-locked ticket on a blacklisted account, and a
 *   revoked delegated authorization;
 * - an overdue workflow: a refund review for a cancelled event, past its due date;
 * - historical records: a completed event with redeemed, expired and
 *   transferred tickets, an expired authorization still inside its renewal
 *   grace period, and one already cleaned up.
 *
 * `createSeedDataset` returns a fresh, independent copy on every call, which is
 * also how the dataset is reset. `validateSeedDataset` (see `validate.ts`)
 * proves the records agree with each other.
 */

import type { Authorization } from "@/core/authorizations/types";
import type { FeeAsset, FeeSchedule } from "@/core/fees/types";
import type { DomainState, Event, Ticket, TransferRecord } from "@/core/invariants/types";
import type { SeedDataset, SeedSettlement, SeedWorkflow } from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The instant the dataset describes. */
export const SEED_NOW = Date.parse("2026-06-01T00:00:00.000Z");

export const SEED_ASSET: FeeAsset = { code: "XLM", decimals: 7 };

/** The fee policy the seeded settlements were computed with. */
export function seedFeeSchedule(organizerBasisPoints: number): FeeSchedule {
  return {
    lines: [
      { id: "protocol", label: "Protocol fee", basisPoints: 100, minimum: 100_000n },
      { id: "organizer", label: "Organizer fee", basisPoints: organizerBasisPoints }
    ]
  };
}

const ORGANIZER = "G_SEED_ORGANIZER_ALICE";
const BOB = "G_SEED_ATTENDEE_BOB";
const CAROL = "G_SEED_ATTENDEE_CAROL";
const DAVE = "G_SEED_ATTENDEE_DAVE";
const ERIN = "G_SEED_ATTENDEE_ERIN";
const FRANK = "G_SEED_ATTENDEE_FRANK";
const FRAUDSTER = "G_SEED_FRAUDSTER_EVE";
const GATE_STAFF = "G_SEED_STAFF_GATE";
const SCANNER_STAFF = "G_SEED_STAFF_SCANNER";

const EVENTS: readonly Event[] = [
  { id: "ev-seed-summit", organizerAddress: ORGANIZER, totalCapacity: 100, issuedCount: 3, status: "active", feeBasisPoints: 250 },
  { id: "ev-seed-workshop", organizerAddress: ORGANIZER, totalCapacity: 50, issuedCount: 1, status: "paused", feeBasisPoints: 250 },
  { id: "ev-seed-soldout", organizerAddress: ORGANIZER, totalCapacity: 2, issuedCount: 2, status: "active", feeBasisPoints: 300 },
  { id: "ev-seed-gala-2025", organizerAddress: ORGANIZER, totalCapacity: 20, issuedCount: 3, status: "completed", feeBasisPoints: 500 },
  { id: "ev-seed-cancelled", organizerAddress: ORGANIZER, totalCapacity: 10, issuedCount: 1, status: "cancelled", feeBasisPoints: 250 }
];

function ticket(
  id: string,
  eventId: string,
  ownerAddress: string,
  priceStroops: number,
  status: Ticket["status"],
  issuedDaysAgo: number,
  validFromDaysAgo: number,
  validUntilDaysAgo: number,
  extra: Partial<Pick<Ticket, "fraudFlag" | "nonce">> = {}
): Ticket {
  return {
    id,
    eventId,
    tierId: "tier-general",
    ownerAddress,
    priceStroops,
    status,
    issuedAt: SEED_NOW - issuedDaysAgo * DAY_MS,
    validFrom: SEED_NOW - validFromDaysAgo * DAY_MS,
    validUntil: SEED_NOW - validUntilDaysAgo * DAY_MS,
    fraudFlag: extra.fraudFlag ?? false,
    nonce: extra.nonce ?? 0,
    metadataHash: `seed-metadata-${id}`
  };
}

const TICKETS: readonly Ticket[] = [
  ticket("tkt-seed-001", "ev-seed-summit", BOB, 200_000_000, "issued", 20, 10, -30),
  ticket("tkt-seed-002", "ev-seed-summit", CAROL, 1_000_000_000, "transferred", 20, 10, -30, { nonce: 1 }),
  ticket("tkt-seed-003", "ev-seed-summit", FRAUDSTER, 100_000_000, "locked", 15, 10, -30, { fraudFlag: true }),
  ticket("tkt-seed-004", "ev-seed-workshop", BOB, 50_000_000, "issued", 12, 5, -20),
  ticket("tkt-seed-005", "ev-seed-soldout", CAROL, 80_000_000, "issued", 9, 3, -10),
  ticket("tkt-seed-006", "ev-seed-soldout", DAVE, 80_000_000, "issued", 9, 3, -10),
  ticket("tkt-seed-007", "ev-seed-gala-2025", ERIN, 5_000_000, "redeemed", 400, 365, 364),
  ticket("tkt-seed-008", "ev-seed-gala-2025", FRANK, 5_000_000, "transferred", 400, 365, 364, { nonce: 1 }),
  ticket("tkt-seed-009", "ev-seed-gala-2025", ERIN, 5_000_000, "expired", 400, 365, 364),
  ticket("tkt-seed-010", "ev-seed-cancelled", BOB, 75_000_000, "burned", 60, 45, 44)
];

const TRANSFERS: readonly TransferRecord[] = [
  {
    id: "tr-seed-001",
    ticketId: "tkt-seed-002",
    fromAddress: DAVE,
    toAddress: CAROL,
    priceStroops: 1_000_000_000,
    organizerFeeStroops: 25_000_000,
    protocolFeeStroops: 10_000_000,
    sellerProceedsStroops: 965_000_000,
    nonce: "nonce-seed-001",
    timestamp: SEED_NOW - 5 * DAY_MS
  },
  {
    id: "tr-seed-002",
    ticketId: "tkt-seed-008",
    fromAddress: ERIN,
    toAddress: FRANK,
    priceStroops: 5_000_000,
    organizerFeeStroops: 250_000,
    protocolFeeStroops: 100_000,
    sellerProceedsStroops: 4_650_000,
    nonce: "nonce-seed-002",
    timestamp: SEED_NOW - 380 * DAY_MS
  }
];

const SETTLEMENTS: readonly SeedSettlement[] = [
  {
    id: "settle-seed-001",
    ticketId: "tkt-seed-002",
    transferId: "tr-seed-001",
    status: "settled",
    priceStroops: 1_000_000_000,
    organizerFeeStroops: 25_000_000,
    protocolFeeStroops: 10_000_000,
    sellerProceedsStroops: 965_000_000,
    attemptedAt: SEED_NOW - 5 * DAY_MS
  },
  {
    id: "settle-seed-002",
    ticketId: "tkt-seed-008",
    transferId: "tr-seed-002",
    status: "settled",
    priceStroops: 5_000_000,
    organizerFeeStroops: 250_000,
    protocolFeeStroops: 100_000,
    sellerProceedsStroops: 4_650_000,
    attemptedAt: SEED_NOW - 380 * DAY_MS
  },
  {
    id: "settle-seed-failed",
    ticketId: "tkt-seed-001",
    transferId: null,
    status: "failed",
    priceStroops: 200_000_000,
    organizerFeeStroops: 5_000_000,
    protocolFeeStroops: 2_000_000,
    sellerProceedsStroops: 193_000_000,
    attemptedAt: SEED_NOW - 2 * DAY_MS,
    failureReason: "insufficient_funds"
  }
];

function authorization(
  id: string,
  grantee: string,
  resourceId: string,
  issuedDaysAgo: number,
  expiresInDays: number,
  extra: Partial<Authorization> = {}
): Authorization {
  return {
    id,
    grantor: ORGANIZER,
    grantee,
    scope: "tickets.redeem",
    resourceId,
    status: "active",
    issuedAt: new Date(SEED_NOW - issuedDaysAgo * DAY_MS).toISOString(),
    expiresAt: new Date(SEED_NOW + expiresInDays * DAY_MS).toISOString(),
    renewals: 0,
    ...extra
  };
}

const AUTHORIZATIONS: readonly Authorization[] = [
  authorization("auth-seed-active", GATE_STAFF, "ev-seed-summit", 1, 6),
  authorization("auth-seed-renewed", SCANNER_STAFF, "ev-seed-summit", 40, 20, {
    renewals: 1,
    lastRenewedAt: new Date(SEED_NOW - 10 * DAY_MS).toISOString()
  }),
  // Expired two days ago: refused, but still inside the seven-day renewal grace period.
  authorization("auth-seed-expired", GATE_STAFF, "ev-seed-workshop", 30, -2),
  // Expired long ago and already removed by cleanup.
  authorization("auth-seed-cleaned", SCANNER_STAFF, "ev-seed-gala-2025", 420, -380, {
    status: "cleaned",
    cleanedAt: new Date(SEED_NOW - 370 * DAY_MS).toISOString()
  }),
  authorization("auth-seed-revoked", GATE_STAFF, "ev-seed-soldout", 8, 22, {
    status: "revoked",
    revokedAt: new Date(SEED_NOW - 3 * DAY_MS).toISOString()
  })
];

const WORKFLOWS: readonly SeedWorkflow[] = [
  // Open and past due: the overdue case.
  { id: "wf-seed-overdue", kind: "refund_review", ticketId: "tkt-seed-010", status: "open", openedAt: SEED_NOW - 10 * DAY_MS, dueAt: SEED_NOW - 3 * DAY_MS },
  { id: "wf-seed-open", kind: "organizer_payout", ticketId: "tkt-seed-002", status: "open", openedAt: SEED_NOW - 2 * DAY_MS, dueAt: SEED_NOW + 5 * DAY_MS },
  { id: "wf-seed-done", kind: "organizer_payout", ticketId: "tkt-seed-008", status: "completed", openedAt: SEED_NOW - 375 * DAY_MS, dueAt: SEED_NOW - 370 * DAY_MS, completedAt: SEED_NOW - 372 * DAY_MS }
];

/** A fresh, independent copy of the dataset. Calling it again resets it. */
export function createSeedDataset(): SeedDataset {
  const state: DomainState = {
    events: new Map(EVENTS.map((event) => [event.id, { ...event }])),
    tickets: new Map(TICKETS.map((entry) => [entry.id, { ...entry }])),
    transfers: TRANSFERS.map((transfer) => ({ ...transfer })),
    processedNonces: new Set<string>(),
    blacklistedAddresses: new Set<string>([FRAUDSTER])
  };
  return {
    now: SEED_NOW,
    state,
    settlements: SETTLEMENTS.map((settlement) => ({ ...settlement })),
    authorizations: AUTHORIZATIONS.map((entry) => ({ ...entry })),
    workflows: WORKFLOWS.map((workflow) => ({ ...workflow }))
  };
}
