import { beforeEach, describe, expect, it } from "vitest";
import { getAuditTrail, type AuditAction } from "@/core/audit";
import {
  canExecuteAction,
  clearImpersonationAuditTrail,
  createImpersonationSession,
  endImpersonationSession
} from "../impersonation";
import type { CreateImpersonationParams, ImpersonationSession } from "../types";

const fixedNow = new Date("2026-10-18T10:00:00.000Z");
const mockClock = () => new Date(fixedNow.getTime());
const laterClock = () => new Date(fixedNow.getTime() + 16 * 60 * 1000);

function session(overrides: Partial<CreateImpersonationParams> = {}): ImpersonationSession {
  const result = createImpersonationSession({
    maintainerId: "maintainer_alice",
    targetUserId: "user_bob",
    targetAddress: "GD5J...TEST",
    reason: "Customer reported a sync failure",
    clock: mockClock,
    ...overrides
  });
  if (!result.ok) throw new Error(result.code);
  return result.value;
}

function auditEvents(action: AuditAction) {
  const page = getAuditTrail().query({ kind: "maintainer", id: "auditor" }, { action });
  if (!page.ok) throw new Error(page.code);
  return page.value.events;
}

describe("impersonation canonical audit trail", () => {
  beforeEach(() => {
    getAuditTrail().reset();
    clearImpersonationAuditTrail();
  });

  it("records session creation with maintainer attribution and user target", () => {
    const created = session();

    const events = auditEvents("impersonation.session_started");
    expect(events).toHaveLength(1);
    expect(events[0].actor).toEqual({ kind: "maintainer", id: "maintainer_alice" });
    expect(events[0].scope).toBe("maintainer");
    expect(events[0].target).toEqual({ kind: "user", id: "user_bob" });
    expect(events[0].outcome).toBe("allowed");
    expect(events[0].after?.sessionId).toBe(created.id);
  });

  it("records an allowed read action", () => {
    const created = session();

    const check = canExecuteAction(created, "ticket.view", { clock: mockClock });
    expect(check.ok).toBe(true);

    const events = auditEvents("impersonation.action");
    expect(events).toHaveLength(1);
    expect(events[0].outcome).toBe("allowed");
    expect(events[0].after?.action).toBe("ticket.view");
  });

  it("records a blocked dangerous mutation as a denied audit event", () => {
    const created = session({ scopes: ["read:transfers"] });

    const check = canExecuteAction(created, "ticket.transfer", { clock: mockClock });
    expect(check.ok).toBe(false);

    const events = auditEvents("impersonation.mutation_blocked");
    expect(events).toHaveLength(1);
    expect(events[0].outcome).toBe("denied");
    expect(events[0].errorCode).toBe("impersonation_denied");
    expect(events[0].after?.action).toBe("ticket.transfer");
  });

  it("records expiry when an action is attempted after the deadline", () => {
    const created = session();

    const check = canExecuteAction(created, "ticket.view", { clock: laterClock });
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.code).toBe("impersonation_session_expired");

    const events = auditEvents("impersonation.session_expired");
    expect(events).toHaveLength(1);
    expect(events[0].outcome).toBe("denied");
    expect(events[0].after?.sessionId).toBe(created.id);
  });

  it("records session end", () => {
    const created = session();

    endImpersonationSession(created, "Resolved the customer issue", mockClock);

    const events = auditEvents("impersonation.session_ended");
    expect(events).toHaveLength(1);
    expect(events[0].outcome).toBe("allowed");
    expect(events[0].after?.sessionId).toBe(created.id);
  });
});
