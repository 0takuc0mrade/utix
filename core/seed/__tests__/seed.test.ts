import { describe, expect, it } from "vitest";
import { authorizationState } from "@/core/authorizations/store";
import type { Event as DomainEvent, TicketStatus } from "@/core/invariants/types";
import { createSeedDataset, SEED_NOW } from "../data";
import type { SeedDataset } from "../types";
import { overdueWorkflows, validateSeedDataset } from "../validate";

/** Replaces one part of the dataset, keeping the rest. */
function withState(dataset: SeedDataset, patch: Partial<SeedDataset["state"]>): SeedDataset {
  return { ...dataset, state: { ...dataset.state, ...patch } };
}

function codes(dataset: SeedDataset): string[] {
  return validateSeedDataset(dataset).map((issue) => issue.code);
}

describe("contributor-safe seed data (#185)", () => {
  it("loads with no clock, network or credentials and is internally consistent", () => {
    expect(validateSeedDataset(createSeedDataset())).toEqual([]);
  });

  it("is deterministic and resets to the same data", () => {
    const first = createSeedDataset();
    expect(createSeedDataset()).toEqual(first);
    expect(first.now).toBe(SEED_NOW);

    // Mutating one copy never touches the next: calling it again is the reset.
    (first.state.events as Map<string, DomainEvent>).delete("ev-seed-summit");
    (first.state.blacklistedAddresses as Set<string>).clear();
    const reset = createSeedDataset();
    expect(reset.state.events.has("ev-seed-summit")).toBe(true);
    expect(reset.state.blacklistedAddresses.size).toBe(1);
    expect(validateSeedDataset(reset)).toEqual([]);
  });

  it("contains no real keys or secrets, only G_SEED_* placeholders", () => {
    const dataset = createSeedDataset();
    const text = JSON.stringify({
      events: [...dataset.state.events.values()],
      tickets: [...dataset.state.tickets.values()],
      transfers: dataset.state.transfers,
      blacklist: [...dataset.state.blacklistedAddresses],
      settlements: dataset.settlements,
      authorizations: dataset.authorizations,
      workflows: dataset.workflows
    });
    expect(text).not.toMatch(/\b[GS][A-Z2-7]{55}\b/);
    expect(text).toContain("G_SEED_");
  });

  describe("edge cases", () => {
    it("includes a failed settlement that moved no money", () => {
      const dataset = createSeedDataset();
      const failed = dataset.settlements.filter((entry) => entry.status === "failed");
      expect(failed).toHaveLength(1);
      expect(failed[0]).toMatchObject({ transferId: null, failureReason: "insufficient_funds" });
      // The ticket stayed with its seller and no transfer was recorded.
      expect(dataset.state.tickets.get(failed[0].ticketId)).toMatchObject({ status: "issued" });
      expect(dataset.state.transfers.some((transfer) => transfer.ticketId === failed[0].ticketId)).toBe(false);
    });

    it("includes revoked access", () => {
      const dataset = createSeedDataset();
      const states = dataset.authorizations.map((entry) => authorizationState(entry, dataset.now));
      expect(states).toContain("revoked");
      const locked = [...dataset.state.tickets.values()].find((entry) => entry.fraudFlag);
      expect(locked).toMatchObject({ status: "locked" });
      expect(dataset.state.blacklistedAddresses.has(locked!.ownerAddress)).toBe(true);
    });

    it("includes an overdue workflow next to an on-time and a completed one", () => {
      const dataset = createSeedDataset();
      expect(overdueWorkflows(dataset).map((workflow) => workflow.id)).toEqual(["wf-seed-overdue"]);
      expect(dataset.workflows.map((workflow) => workflow.status).sort()).toEqual(["completed", "open", "open"]);
    });

    it("includes historical records", () => {
      const dataset = createSeedDataset();
      expect(dataset.state.events.get("ev-seed-gala-2025")?.status).toBe("completed");
      const historic = dataset.state.transfers.filter((transfer) => transfer.timestamp < dataset.now - 365 * 86_400_000);
      expect(historic).toHaveLength(1);
    });

    it("covers every authorization state and every ticket status", () => {
      const dataset = createSeedDataset();
      expect(new Set(dataset.authorizations.map((entry) => authorizationState(entry, dataset.now)))).toEqual(
        new Set(["active", "renewed", "expired", "cleaned", "revoked"])
      );
      const statuses: TicketStatus[] = ["issued", "transferred", "locked", "redeemed", "expired", "burned"];
      expect(new Set([...dataset.state.tickets.values()].map((entry) => entry.status))).toEqual(new Set(statuses));
    });

    it("includes a sold-out event and events in every non-draft status", () => {
      const events = [...createSeedDataset().state.events.values()];
      expect(events.some((event) => event.issuedCount === event.totalCapacity)).toBe(true);
      expect(new Set(events.map((event) => event.status))).toEqual(
        new Set(["active", "paused", "completed", "cancelled"])
      );
    });
  });

  describe("validation catches inconsistent records", () => {
    it("flags a settlement whose fees differ from the fee module", () => {
      const dataset = createSeedDataset();
      const tampered = {
        ...dataset,
        settlements: dataset.settlements.map((entry) =>
          entry.id === "settle-seed-failed"
            ? { ...entry, protocolFeeStroops: 1, sellerProceedsStroops: entry.sellerProceedsStroops + 1_999_999 }
            : entry
        )
      };
      expect(codes(tampered)).toEqual(["settlement_fee_mismatch"]);
    });

    it("flags a transfer that no settlement references, and a settlement that disagrees with its transfer", () => {
      const dataset = createSeedDataset();
      expect(codes({ ...dataset, settlements: dataset.settlements.filter((entry) => entry.id !== "settle-seed-001") })).toEqual(
        ["transfer_without_settlement"]
      );
      const drifted = {
        ...dataset,
        settlements: dataset.settlements.map((entry) =>
          entry.id === "settle-seed-001" ? { ...entry, ticketId: "tkt-seed-001" } : entry
        )
      };
      expect(codes(drifted)).toContain("settlement_transfer_mismatch");
    });

    it("flags a failed settlement that claims a transfer or gives no reason", () => {
      const dataset = createSeedDataset();
      for (const patch of [{ transferId: "tr-seed-001" }, { failureReason: undefined }]) {
        const tampered = {
          ...dataset,
          settlements: dataset.settlements.map((entry) =>
            entry.id === "settle-seed-failed" ? { ...entry, ...patch } : entry
          )
        };
        expect(codes(tampered)).toContain("failed_settlement_inconsistent");
      }
    });

    it("flags a domain invariant violation and a wrong issued count", () => {
      const dataset = createSeedDataset();
      const events = new Map(dataset.state.events);
      events.set("ev-seed-summit", { ...events.get("ev-seed-summit")!, issuedCount: 2 });
      expect(codes(withState(dataset, { events }))).toEqual(["event_issued_count_mismatch"]);

      const tickets = new Map(dataset.state.tickets);
      tickets.set("tkt-seed-003", { ...tickets.get("tkt-seed-003")!, status: "issued" });
      expect(codes(withState(dataset, { tickets }))).toContain("invariant_violation");
    });

    it("flags a non-placeholder address", () => {
      const dataset = createSeedDataset();
      const events = new Map(dataset.state.events);
      events.set("ev-seed-summit", {
        ...events.get("ev-seed-summit")!,
        organizerAddress: `G${"A".repeat(55)}`
      });
      expect(codes(withState(dataset, { events }))).toEqual(["address_not_placeholder"]);
    });

    it("flags inconsistent authorizations and workflows", () => {
      const dataset = createSeedDataset();
      const authorizations = dataset.authorizations.map((entry) => {
        if (entry.id === "auth-seed-revoked") return { ...entry, revokedAt: undefined };
        if (entry.id === "auth-seed-active") return { ...entry, resourceId: "ev-missing" };
        return entry;
      });
      expect(codes({ ...dataset, authorizations })).toEqual(["authorization_inconsistent", "authorization_inconsistent"]);

      const workflows = dataset.workflows.map((entry) =>
        entry.id === "wf-seed-overdue" ? { ...entry, ticketId: "tkt-missing" } : entry
      );
      expect(codes({ ...dataset, workflows })).toEqual(["workflow_inconsistent"]);
    });

    it("flags records dated after the seed instant", () => {
      const dataset = createSeedDataset();
      const workflows = dataset.workflows.map((entry) =>
        entry.id === "wf-seed-open" ? { ...entry, openedAt: dataset.now + 1000, dueAt: dataset.now + 2000 } : entry
      );
      expect(codes({ ...dataset, workflows })).toEqual(["future_record"]);
    });
  });
});
