import { beforeEach, describe, expect, it } from "vitest";
import { createIsolatedAuditTrail, type AuditActor, type AuditInput } from "@/core/audit/audit";
import { createAuthorizationStore, DAY_MS, DEFAULT_RENEWAL_GRACE_MS, type AuthorizationStore } from "../store";

const T0 = Date.parse("2026-01-01T00:00:00.000Z");

const alice: AuditActor = { kind: "user", id: "alice" };
const bob: AuditActor = { kind: "user", id: "bob" };
const maintainer: AuditActor = { kind: "maintainer", id: "ada" };
const system: AuditActor = { kind: "system" };

describe("stale authorization cleanup and renewal (#183)", () => {
  let clock: number;
  let trail: ReturnType<typeof createIsolatedAuditTrail>;
  let store: AuthorizationStore;

  /** A store backed by the isolated trail; `rejecting` makes one action's audit event fail. */
  function build(rejecting?: AuditInput["action"]): AuthorizationStore {
    return createAuthorizationStore({
      now: () => clock,
      record: (input) => {
        if (input.action === rejecting) return undefined;
        const result = trail.record(input);
        return result.ok ? result.value : undefined;
      }
    });
  }

  function grantToBob(ttlMs = DAY_MS) {
    const result = store.grant({
      actor: alice,
      grantor: "alice",
      grantee: "bob",
      scope: "tickets.redeem",
      resourceId: "event-1",
      ttlMs
    });
    if (!result.ok) throw new Error(`grant failed: ${result.code}`);
    return result.value;
  }

  const auditActions = () => trail.all().map((event) => `${event.action}:${event.outcome}`);

  beforeEach(() => {
    clock = T0;
    trail = createIsolatedAuditTrail();
    store = build();
  });

  describe("active", () => {
    it("allows a protected action while the authorization is active", () => {
      const grant = grantToBob();
      expect(grant).toMatchObject({ status: "active", renewals: 0, expiresAt: "2026-01-02T00:00:00.000Z" });
      expect(store.stateOf(grant.id)).toBe("active");
      expect(store.authorize({ grantee: "bob", scope: "tickets.redeem", resourceId: "event-1" })).toEqual({
        ok: true,
        value: grant
      });
      expect(auditActions()).toEqual(["authorization.granted:allowed"]);
    });

    it("limits a resource-specific authorization to that resource", () => {
      grantToBob();
      expect(store.authorize({ grantee: "bob", scope: "tickets.redeem", resourceId: "event-2" })).toEqual({
        ok: false,
        code: "authorization_not_found"
      });
      expect(store.authorize({ grantee: "bob", scope: "tickets.transfer", resourceId: "event-1" })).toEqual({
        ok: false,
        code: "authorization_not_found"
      });
    });

    it("lets an authorization without a resource cover every resource under the scope", () => {
      store.grant({ actor: alice, grantor: "alice", grantee: "bob", scope: "tickets.redeem", ttlMs: DAY_MS });
      expect(store.authorize({ grantee: "bob", scope: "tickets.redeem", resourceId: "event-9" }).ok).toBe(true);
    });

    it("refuses a grant from someone other than the grantor or a maintainer", () => {
      const result = store.grant({
        actor: bob,
        grantor: "alice",
        grantee: "bob",
        scope: "tickets.redeem",
        ttlMs: DAY_MS
      });
      expect(result).toEqual({ ok: false, code: "grant_unauthorized" });
      expect(store.list()).toEqual([]);
      expect(auditActions()).toEqual(["authorization.granted:denied"]);
    });

    it("rejects malformed grants", () => {
      const base = { actor: alice, grantor: "alice", grantee: "bob", scope: "tickets.redeem", ttlMs: DAY_MS };
      for (const bad of [
        { ttlMs: 0 },
        { ttlMs: 1.5 },
        { ttlMs: 366 * DAY_MS },
        { scope: "Tickets Redeem" },
        { grantee: "alice" },
        { grantee: "" }
      ]) {
        expect(store.grant({ ...base, ...bad })).toEqual({ ok: false, code: "invalid_authorization" });
      }
    });
  });

  describe("grantor entitlement", () => {
    it("refuses grants the grantor could not make, and wildcards from non-maintainers", () => {
      let entitled = true;
      store = createAuthorizationStore({ now: () => clock, record: (input) => { const r = trail.record(input); return r.ok ? r.value : undefined; }, canDelegate: () => entitled });
      const base = { actor: alice, grantor: "alice", grantee: "bob", scope: "tickets.redeem", ttlMs: DAY_MS };
      expect(store.grant({ ...base, resourceId: "event-1" }).ok).toBe(true);
      expect(store.grant(base)).toEqual({ ok: false, code: "grant_unauthorized" });
      expect(store.grant({ ...base, actor: maintainer }).ok).toBe(true);
      entitled = false;
      expect(store.grant({ ...base, resourceId: "event-2" })).toEqual({ ok: false, code: "grant_unauthorized" });
    });

    it("stops honouring a grant once its grantor loses the entitlement", () => {
      let entitled = true;
      store = createAuthorizationStore({ now: () => clock, record: (input) => { const r = trail.record(input); return r.ok ? r.value : undefined; }, canDelegate: () => entitled });
      store.grant({ actor: alice, grantor: "alice", grantee: "bob", scope: "tickets.redeem", resourceId: "event-1", ttlMs: DAY_MS });
      const check = { grantee: "bob", scope: "tickets.redeem", resourceId: "event-1" };
      expect(store.authorize(check).ok).toBe(true);
      entitled = false;
      expect(store.authorize(check)).toEqual({ ok: false, code: "grantor_not_entitled" });
    });
  });

  describe("expired", () => {
    it("stops allowing protected actions at the moment of expiry, without any cleanup", () => {
      const grant = grantToBob();
      clock = Date.parse(grant.expiresAt) - 1;
      expect(store.authorize({ grantee: "bob", scope: "tickets.redeem", resourceId: "event-1" }).ok).toBe(true);

      clock = Date.parse(grant.expiresAt);
      expect(store.stateOf(grant.id)).toBe("expired");
      expect(store.authorize({ grantee: "bob", scope: "tickets.redeem", resourceId: "event-1" })).toEqual({
        ok: false,
        code: "authorization_expired"
      });
    });

    it("uses a newer usable authorization over an older expired one", () => {
      const first = grantToBob(DAY_MS);
      clock = T0 + 2 * DAY_MS;
      const second = grantToBob(DAY_MS);
      const result = store.authorize({ grantee: "bob", scope: "tickets.redeem", resourceId: "event-1" });
      expect(result).toEqual({ ok: true, value: second });
      expect(store.stateOf(first.id)).toBe("expired");
    });
  });

  describe("report and cleanup", () => {
    it("reports expired, cleanable and soon-to-expire authorizations without changing them", () => {
      const stale = grantToBob(DAY_MS);
      clock = T0 + DAY_MS + 1;
      expect(store.report().expired.map((entry) => entry.id)).toEqual([stale.id]);
      expect(store.report().cleanable).toEqual([]);

      const fresh = grantToBob(2 * DAY_MS);
      expect(store.report({ expiringWithinMs: DAY_MS }).expiringSoon).toEqual([]);
      expect(store.report({ expiringWithinMs: 3 * DAY_MS }).expiringSoon.map((entry) => entry.id)).toEqual([
        fresh.id
      ]);

      clock = Date.parse(stale.expiresAt) + DEFAULT_RENEWAL_GRACE_MS + 1;
      const report = store.report();
      expect(report.generatedAt).toBe(new Date(clock).toISOString());
      expect(report.cleanable.map((entry) => entry.id)).toEqual([stale.id]);
      expect(store.stateOf(stale.id)).toBe("expired");
    });

    it("refuses cleanup from anyone but a maintainer or the system", () => {
      grantToBob();
      expect(store.cleanup({ actor: alice })).toEqual({ ok: false, code: "cleanup_unauthorized" });
      expect(auditActions()).toEqual(["authorization.granted:allowed", "authorization.cleaned_up:denied"]);
    });

    it("leaves authorizations that are still inside the grace period renewable", () => {
      const grant = grantToBob();
      clock = Date.parse(grant.expiresAt) + DEFAULT_RENEWAL_GRACE_MS;
      expect(store.cleanup({ actor: maintainer })).toEqual({ ok: true, value: { cleaned: [], skipped: [] } });
      expect(store.stateOf(grant.id)).toBe("expired");
    });

    it("cleans authorizations expired past the grace period and audits each one", () => {
      const stale = grantToBob();
      clock = Date.parse(stale.expiresAt) + DEFAULT_RENEWAL_GRACE_MS + 1;
      const active = grantToBob();

      expect(store.cleanup({ actor: system })).toEqual({ ok: true, value: { cleaned: [stale.id], skipped: [] } });
      expect(store.stateOf(stale.id)).toBe("cleaned");
      expect(store.get(stale.id)?.cleanedAt).toBe(new Date(clock).toISOString());
      expect(store.stateOf(active.id)).toBe("active");

      const cleanedEvents = trail.all().filter((event) => event.action === "authorization.cleaned_up");
      expect(cleanedEvents).toHaveLength(1);
      expect(cleanedEvents[0]).toMatchObject({
        outcome: "allowed",
        target: { kind: "authorization", id: stale.id },
        before: { state: "expired" },
        after: { state: "cleaned" }
      });

      // Cleaned authorizations stay refused, and a second run changes nothing.
      expect(store.cleanup({ actor: maintainer })).toEqual({ ok: true, value: { cleaned: [], skipped: [] } });
    });

    it("keeps an authorization in place when the audit trail rejects the cleanup event", () => {
      store = build("authorization.cleaned_up");
      const grant = grantToBob();
      clock = Date.parse(grant.expiresAt) + DEFAULT_RENEWAL_GRACE_MS + 1;
      expect(store.cleanup({ actor: maintainer })).toEqual({
        ok: true,
        value: { cleaned: [], skipped: [grant.id] }
      });
      expect(store.stateOf(grant.id)).toBe("expired");
    });
  });

  describe("renewed", () => {
    it("requires an explicit confirmation", () => {
      const grant = grantToBob();
      expect(store.renew({ id: grant.id, actor: alice, confirmed: false, extendByMs: DAY_MS })).toEqual({
        ok: false,
        code: "renewal_not_confirmed"
      });
      expect(store.get(grant.id)).toEqual(grant);
      expect(auditActions()).toEqual(["authorization.granted:allowed", "authorization.renewed:denied"]);
    });

    it("refuses a renewal from the grantee or a stranger", () => {
      const grant = grantToBob();
      for (const actor of [bob, { kind: "user", id: "mallory" } as AuditActor, system]) {
        expect(store.renew({ id: grant.id, actor, confirmed: true, extendByMs: DAY_MS })).toEqual({
          ok: false,
          code: "renewal_unauthorized"
        });
      }
      expect(store.get(grant.id)).toEqual(grant);
    });

    it("renews an expired authorization inside the grace period and audits before and after", () => {
      const grant = grantToBob();
      clock = Date.parse(grant.expiresAt) + DAY_MS;
      const renewed = store.renew({ id: grant.id, actor: alice, confirmed: true, extendByMs: 3 * DAY_MS });
      expect(renewed).toMatchObject({
        ok: true,
        value: { renewals: 1, expiresAt: new Date(clock + 3 * DAY_MS).toISOString(), lastRenewedAt: new Date(clock).toISOString() }
      });
      expect(store.stateOf(grant.id)).toBe("renewed");
      expect(store.authorize({ grantee: "bob", scope: "tickets.redeem", resourceId: "event-1" }).ok).toBe(true);

      const events = trail.all().filter((event) => event.action === "authorization.renewed");
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        outcome: "allowed",
        actor: alice,
        scope: "own",
        before: { state: "expired", renewals: 0 },
        after: { state: "renewed", renewals: 1 }
      });
    });

    it("extends from the current expiry when the authorization is still active", () => {
      const grant = grantToBob();
      clock = T0 + DAY_MS / 2;
      const renewed = store.renew({ id: grant.id, actor: maintainer, confirmed: true, extendByMs: DAY_MS });
      expect(renewed).toMatchObject({ ok: true, value: { expiresAt: "2026-01-03T00:00:00.000Z" } });
    });

    it("refuses a renewal after the grace period, and after cleanup", () => {
      const grant = grantToBob();
      clock = Date.parse(grant.expiresAt) + DEFAULT_RENEWAL_GRACE_MS + 1;
      expect(store.renew({ id: grant.id, actor: alice, confirmed: true, extendByMs: DAY_MS })).toEqual({
        ok: false,
        code: "renewal_window_closed"
      });
      store.cleanup({ actor: system });
      expect(store.renew({ id: grant.id, actor: alice, confirmed: true, extendByMs: DAY_MS })).toEqual({
        ok: false,
        code: "authorization_cleaned"
      });
    });

    it("rejects an invalid extension and an unknown authorization", () => {
      const grant = grantToBob();
      expect(store.renew({ id: grant.id, actor: alice, confirmed: true, extendByMs: 0 })).toEqual({
        ok: false,
        code: "invalid_authorization"
      });
      expect(store.renew({ id: "missing", actor: alice, confirmed: true, extendByMs: DAY_MS })).toEqual({
        ok: false,
        code: "authorization_not_found"
      });
    });

    it("applies nothing when the audit trail rejects the renewal event", () => {
      store = build("authorization.renewed");
      const grant = grantToBob();
      expect(store.renew({ id: grant.id, actor: alice, confirmed: true, extendByMs: DAY_MS })).toEqual({
        ok: false,
        code: "authorization_audit_failed"
      });
      expect(store.get(grant.id)).toEqual(grant);
    });
  });

  describe("revoked", () => {
    it("lets the grantor revoke, after which every protected action is refused", () => {
      const grant = grantToBob();
      const revoked = store.revoke({ id: grant.id, actor: alice, reason: "lost_device" });
      expect(revoked).toMatchObject({ ok: true, value: { status: "revoked", revokedAt: new Date(clock).toISOString() } });
      expect(store.stateOf(grant.id)).toBe("revoked");
      expect(store.authorize({ grantee: "bob", scope: "tickets.redeem", resourceId: "event-1" })).toEqual({
        ok: false,
        code: "authorization_revoked"
      });
      const event = trail.all().find((entry) => entry.action === "authorization.revoked");
      expect(event).toMatchObject({ outcome: "allowed", reason: "lost_device", after: { state: "revoked" } });
    });

    it("refuses revocation by the grantee, and a second revocation", () => {
      const grant = grantToBob();
      expect(store.revoke({ id: grant.id, actor: bob })).toEqual({ ok: false, code: "revoke_unauthorized" });
      expect(store.revoke({ id: grant.id, actor: maintainer }).ok).toBe(true);
      expect(store.revoke({ id: grant.id, actor: maintainer })).toEqual({ ok: false, code: "authorization_revoked" });
    });

    it("cannot be renewed", () => {
      const grant = grantToBob();
      store.revoke({ id: grant.id, actor: alice });
      expect(store.renew({ id: grant.id, actor: alice, confirmed: true, extendByMs: DAY_MS })).toEqual({
        ok: false,
        code: "authorization_revoked"
      });
    });

    it("is not cleaned up: a revoked authorization stays revoked", () => {
      const grant = grantToBob();
      store.revoke({ id: grant.id, actor: alice });
      clock = Date.parse(grant.expiresAt) + DEFAULT_RENEWAL_GRACE_MS + 1;
      expect(store.cleanup({ actor: system })).toEqual({ ok: true, value: { cleaned: [], skipped: [] } });
      expect(store.stateOf(grant.id)).toBe("revoked");
    });
  });
});
