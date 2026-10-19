import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  applyReview,
  isTerminalState,
  mergeIntoStore,
} from "@/features/duplicate-transaction-scanner/lib/review";
import {
  PENDING_GROUP,
} from "@/features/duplicate-transaction-scanner/fixtures/scanner.fixture";
import type {
  CandidateGroup,
  ReviewInput,
} from "@/features/duplicate-transaction-scanner/types";

const ACTOR_ID = "session:test-actor";

function reviewInput(
  groupId: string,
  action: ReviewInput["action"],
  reason?: string,
): ReviewInput {
  return { groupId, action, actorId: ACTOR_ID, reason };
}

describe("isTerminalState", () => {
  it("returns true for confirmed and dismissed", () => {
    expect(isTerminalState("confirmed")).toBe(true);
    expect(isTerminalState("dismissed")).toBe(true);
  });

  it("returns false for pending and deferred", () => {
    expect(isTerminalState("pending")).toBe(false);
    expect(isTerminalState("deferred")).toBe(false);
  });
});

describe("applyReview", () => {
  it("transitions pending → confirmed on confirm", () => {
    const result = applyReview(PENDING_GROUP, reviewInput(PENDING_GROUP.id, "confirm"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.state).toBe("confirmed");
  });

  it("transitions pending → dismissed on dismiss", () => {
    const result = applyReview(PENDING_GROUP, reviewInput(PENDING_GROUP.id, "dismiss"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.state).toBe("dismissed");
  });

  it("transitions pending → deferred on defer", () => {
    const result = applyReview(PENDING_GROUP, reviewInput(PENDING_GROUP.id, "defer"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.state).toBe("deferred");
  });

  it("records reviewedAt and reviewedBy on success", () => {
    const result = applyReview(PENDING_GROUP, reviewInput(PENDING_GROUP.id, "confirm"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.reviewedAt).toBeTruthy();
    expect(result.value.reviewedBy).toBe(ACTOR_ID);
  });

  it("stores the optional reason on the group", () => {
    const result = applyReview(
      PENDING_GROUP,
      reviewInput(PENDING_GROUP.id, "dismiss", "false_positive"),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.reviewReason).toBe("false_positive");
  });

  it("refuses to transition a confirmed group", () => {
    const confirmed: CandidateGroup = { ...PENDING_GROUP, state: "confirmed" };
    const result = applyReview(confirmed, reviewInput(PENDING_GROUP.id, "confirm"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("invalid_transition");
  });

  it("refuses to transition a dismissed group", () => {
    const dismissed: CandidateGroup = { ...PENDING_GROUP, state: "dismissed" };
    const result = applyReview(dismissed, reviewInput(PENDING_GROUP.id, "dismiss"));
    expect(result.ok).toBe(false);
  });

  it("allows confirming a deferred group", () => {
    const deferred: CandidateGroup = { ...PENDING_GROUP, state: "deferred" };
    const result = applyReview(deferred, reviewInput(PENDING_GROUP.id, "confirm"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.state).toBe("confirmed");
  });

  it("allows dismissing a deferred group", () => {
    const deferred: CandidateGroup = { ...PENDING_GROUP, state: "deferred" };
    const result = applyReview(deferred, reviewInput(PENDING_GROUP.id, "dismiss"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.state).toBe("dismissed");
  });

  it("does not mutate the original group", () => {
    const original = { ...PENDING_GROUP };
    applyReview(PENDING_GROUP, reviewInput(PENDING_GROUP.id, "confirm"));
    expect(PENDING_GROUP.state).toBe(original.state);
  });
});

describe("mergeIntoStore", () => {
  it("adds new incoming groups to an empty store", () => {
    const result = mergeIntoStore([PENDING_GROUP], []);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(PENDING_GROUP.id);
  });

  it("preserves a confirmed decision from the store", () => {
    const confirmed: CandidateGroup = { ...PENDING_GROUP, state: "confirmed" };
    const result = mergeIntoStore([PENDING_GROUP], [confirmed]);
    expect(result[0].state).toBe("confirmed");
  });

  it("preserves a dismissed decision from the store", () => {
    const dismissed: CandidateGroup = { ...PENDING_GROUP, state: "dismissed" };
    const result = mergeIntoStore([PENDING_GROUP], [dismissed]);
    expect(result[0].state).toBe("dismissed");
  });

  it("preserves a deferred decision from the store", () => {
    const deferred: CandidateGroup = { ...PENDING_GROUP, state: "deferred" };
    const result = mergeIntoStore([PENDING_GROUP], [deferred]);
    expect(result[0].state).toBe("deferred");
  });

  it("retains historical groups not present in the incoming scan", () => {
    const historical: CandidateGroup = {
      ...PENDING_GROUP,
      id: "historical-group",
      state: "confirmed",
    };
    const result = mergeIntoStore([], [historical]);
    expect(result.some((g) => g.id === "historical-group")).toBe(true);
  });

  it("sorts pending groups before deferred groups before resolved groups", () => {
    const deferred: CandidateGroup = {
      ...PENDING_GROUP,
      id: "deferred-1",
      state: "deferred",
    };
    const confirmed: CandidateGroup = {
      ...PENDING_GROUP,
      id: "confirmed-1",
      state: "confirmed",
    };
    const result = mergeIntoStore([PENDING_GROUP, deferred, confirmed], []);
    expect(result[0].state).toBe("pending");
    expect(result[1].state).toBe("deferred");
    expect(result[2].state).toBe("confirmed");
  });
});
