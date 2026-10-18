import { describe, expect, it } from "vitest";
import { ERROR_CODES } from "@/core/errors/error-codes";
import { UnauthorizedError } from "@/core/auth/middleware";
import { issueTicket, redeemTicket, transferTicket } from "@/core/invariants/mutations";
import type { DomainState } from "@/core/invariants/types";
import { err } from "@/core/result/result";
import {
  REJECTION_INVARIANTS,
  REJECTION_REASONS,
  REJECTION_SOURCE_CODES,
  explainRejection,
  renderRejection,
  unmappedErrorCodes
} from "@/core/errors/explanations";

const STATE: DomainState = {
  events: new Map([
    [
      "evt-1",
      { id: "evt-1", organizerAddress: "G_ORG", totalCapacity: 1, issuedCount: 1, status: "active", feeBasisPoints: 250 }
    ]
  ]),
  tickets: new Map([
    [
      "t-1",
      {
        id: "t-1",
        eventId: "evt-1",
        tierId: "general",
        ownerAddress: "G_ALICE",
        priceStroops: 100,
        status: "issued",
        issuedAt: 0,
        validFrom: 100,
        validUntil: 200,
        fraudFlag: false,
        nonce: 0,
        metadataHash: ""
      }
    ]
  ]),
  transfers: [],
  processedNonces: new Set(["used-nonce"]),
  blacklistedAddresses: new Set(["G_EVE"])
};

describe("rejection explanations (#190)", () => {
  it("gives every stable error code a reason code", () => {
    expect(unmappedErrorCodes()).toEqual([]);
  });

  it("only maps to reasons that exist and carry recovery hints", () => {
    const targets = [...Object.values(REJECTION_SOURCE_CODES), ...Object.values(REJECTION_INVARIANTS)];
    for (const target of targets) {
      expect(REJECTION_REASONS[target]).toBeDefined();
    }
    for (const reason of Object.values(REJECTION_REASONS)) {
      expect(reason.recovery.length).toBeGreaterThan(0);
    }
  });

  it("explains every stable error code as an HTTP-class rejection", () => {
    for (const definition of Object.values(ERROR_CODES)) {
      const explanation = explainRejection(definition.code);
      expect(explanation.status).toBeGreaterThanOrEqual(400);
      expect(explanation.retryable).toBeTypeOf("boolean");
    }
  });

  describe("validation rejection", () => {
    it("explains an invalid amount from an invariant violation", () => {
      const roomy: DomainState = {
        ...STATE,
        events: new Map([["evt-1", { ...STATE.events.get("evt-1")!, totalCapacity: 5 }]])
      };
      const amount = issueTicket(roomy, {
        id: "t-2",
        eventId: "evt-1",
        tierId: "general",
        ownerAddress: "G_BOB",
        priceStroops: -1,
        validFrom: 1,
        validUntil: 2
      });
      if (amount.ok) throw new Error("expected a rejection");
      const explanation = explainRejection(amount.code);
      expect(explanation.reasonCode).toBe("invalid_amount");
      expect(explanation.category).toBe("validation");
    });

    it("accepts a failed domain result as well as its violation", () => {
      const early = redeemTicket(STATE, { ticketId: "t-1", claimerAddress: "G_ALICE", timestamp: 5 });
      expect(explainRejection(early).reasonCode).toBe("outside_validity_window");
    });

    it("explains a result error code and an idempotency key problem", () => {
      expect(explainRejection(err("INVALID_ADDRESS")).reasonCode).toBe("invalid_address");
      expect(explainRejection(err("idempotency_key_invalid")).category).toBe("validation");
    });
  });

  describe("policy rejection", () => {
    it("explains capacity, lock and blacklist rejections", () => {
      const full = issueTicket(STATE, {
        id: "t-2",
        eventId: "evt-1",
        tierId: "general",
        ownerAddress: "G_BOB",
        priceStroops: 1,
        validFrom: 1,
        validUntil: 2
      });
      if (full.ok) throw new Error("expected a rejection");
      expect(explainRejection(full.code).reasonCode).toBe("capacity_reached");

      expect(explainRejection({ invariantId: "INV-05" }).reasonCode).toBe("ticket_locked");
      expect(explainRejection({ invariantId: "INV-11" }).reasonCode).toBe("account_restricted");
      expect(explainRejection(err("quota_exceeded")).reasonCode).toBe("rate_limited");
      expect(explainRejection("quota_exceeded").retryable).toBe(true);
    });

    it("explains a redemption outside the validity window", () => {
      const early = redeemTicket(STATE, { ticketId: "t-1", claimerAddress: "G_ALICE", timestamp: 5 });
      if (early.ok) throw new Error("expected a rejection");
      const explanation = explainRejection(early.code);
      expect(explanation.reasonCode).toBe("outside_validity_window");
      expect(explanation.category).toBe("policy");
    });
  });

  describe("permission rejection", () => {
    it("explains a thrown UnauthorizedError without exposing its message", () => {
      const error = new UnauthorizedError("Permission denied: admin:config requires elevated privileges", "admin:config", "viewer");
      const explanation = explainRejection(error);
      expect(explanation.reasonCode).toBe("permission_denied");
      expect(explanation.category).toBe("permission");
      expect(JSON.stringify(explanation)).not.toContain("admin:config");
    });

    it("explains a wrong owner from the domain layer", () => {
      const stolen = transferTicket(STATE, {
        id: "x-1",
        ticketId: "t-1",
        fromAddress: "G_MALLORY",
        toAddress: "G_BOB",
        priceStroops: 10,
        organizerFeeStroops: 1,
        protocolFeeStroops: 1,
        sellerProceedsStroops: 8,
        nonce: "fresh"
      });
      if (stolen.ok) throw new Error("expected a rejection");
      expect(explainRejection(stolen.code).reasonCode).toBe("not_owner");
      expect(explainRejection("export_denied").category).toBe("permission");
    });
  });

  describe("stale-state rejection", () => {
    it("explains a replayed nonce and an in-flight duplicate", () => {
      const replayed = transferTicket(STATE, {
        id: "x-2",
        ticketId: "t-1",
        fromAddress: "G_ALICE",
        toAddress: "G_BOB",
        priceStroops: 10,
        organizerFeeStroops: 1,
        protocolFeeStroops: 1,
        sellerProceedsStroops: 8,
        nonce: "used-nonce"
      });
      if (replayed.ok) throw new Error("expected a rejection");
      expect(explainRejection(replayed.code).reasonCode).toBe("duplicate_request");
      const inFlight = explainRejection("idempotency_in_flight");
      expect(inFlight.category).toBe("stale_state");
      expect(inFlight.retryable).toBe(true);
    });

    it("explains an already redeemed ticket", () => {
      expect(explainRejection("ALREADY_REDEEMED").category).toBe("stale_state");
    });
  });

  describe("unexpected failure fallback", () => {
    it("never returns the raw message of an unknown error", () => {
      const explanation = explainRejection(new Error("ECONNRESET at 10.0.0.7:5432 password=hunter2"), {
        correlationId: "corr-1"
      });
      expect(explanation.reasonCode).toBe("unexpected_failure");
      expect(explanation.category).toBe("unexpected");
      expect(explanation.reference).toBe("corr-1");
      expect(JSON.stringify(explanation)).not.toContain("hunter2");
    });

    it("falls back for unknown codes, null and prototype keys", () => {
      for (const input of [undefined, null, 42, "no_such_code", "constructor", err("no_such_code"), {}]) {
        expect(explainRejection(input).reasonCode).toBe("unexpected_failure");
      }
    });

    it("does not treat a success result as a rejection code", () => {
      expect(explainRejection({ ok: true, code: "FORBIDDEN" }).reasonCode).toBe("unexpected_failure");
    });
  });

  it("renders the same text for the same rejection", () => {
    const text = renderRejection(explainRejection("TICKET_NOT_FOUND", { correlationId: "corr-2" }));
    expect(text).toContain("Not found: The item you asked for could not be found.");
    expect(text).toContain("What you can do:");
    expect(text).toContain("Reference: corr-2");
  });
});
