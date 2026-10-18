/**
 * Stale authorization cleanup and renewal (#183).
 *
 * Delegated permissions must not live forever. This store keeps them
 * time-boxed and moves them through a small, audited lifecycle:
 *
 * - an expired authorization is refused by `authorize` the instant it expires,
 *   whether or not cleanup has run, because expiry is derived from `expiresAt`
 *   and the clock, not from a flag a job must flip;
 * - `report` lists what is expired, what cleanup would remove and what is about
 *   to expire, without changing anything;
 * - `cleanup` (maintainer or system only) marks authorizations that have been
 *   expired longer than the grace period as `cleaned`;
 * - `renew` needs the grantor (or a maintainer) and an explicit confirmation,
 *   and is only possible until cleanup removes the authorization;
 * - every grant, renewal, revocation and cleanup is audited, and, as in the
 *   admin configuration store, the change is applied only after its audit event
 *   is on the trail. Refusals are recorded too.
 *
 * The clock, the id factory and the audit recorder are injected so a test can
 * assert an exact outcome.
 */

import { err, ok, type Result } from "@/core/result/result";
import {
  recordAudit,
  type AuditActor,
  type AuditEvent,
  type AuditInput
} from "@/core/audit/audit";
import type {
  Authorization,
  AuthorizationErrorCode,
  AuthorizationState,
  AuthorizeInput,
  CleanupAuthorizationsInput,
  CleanupResult,
  GrantAuthorizationInput,
  RenewAuthorizationInput,
  RevokeAuthorizationInput,
  StaleAuthorizationReport,
  StaleAuthorizationReportOptions
} from "./types";

export const DAY_MS = 24 * 60 * 60 * 1000;
/** How long an expired authorization stays renewable before cleanup may remove it. */
export const DEFAULT_RENEWAL_GRACE_MS = 7 * DAY_MS;
/** The longest lifetime a grant or a single renewal may add. */
export const MAX_AUTHORIZATION_TTL_MS = 365 * DAY_MS;

const SCOPE_PATTERN = /^[a-z0-9_.:-]{1,64}$/;
const REASON_PATTERN = /^[a-z0-9_.:-]{1,64}$/;

function isLabel(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 128;
}

function isDuration(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0 && (value as number) <= MAX_AUTHORIZATION_TTL_MS;
}

/** The effective state of an authorization at `nowMs`. Pure. */
export function authorizationState(authorization: Authorization, nowMs: number): AuthorizationState {
  if (authorization.status === "revoked") return "revoked";
  if (authorization.status === "cleaned") return "cleaned";
  if (Date.parse(authorization.expiresAt) <= nowMs) return "expired";
  return authorization.renewals > 0 ? "renewed" : "active";
}

function isUsable(state: AuthorizationState): boolean {
  return state === "active" || state === "renewed";
}

export interface AuthorizationStore {
  /** Delegates a scope to a grantee for `ttlMs`. */
  readonly grant: (input: GrantAuthorizationInput) => Result<Authorization, AuthorizationErrorCode>;
  /**
   * The check protected actions must make. Returns the usable authorization, or
   * the reason there is none: expired, revoked, cleaned or not found.
   */
  readonly authorize: (input: AuthorizeInput) => Result<Authorization, AuthorizationErrorCode>;
  readonly renew: (input: RenewAuthorizationInput) => Result<Authorization, AuthorizationErrorCode>;
  readonly revoke: (input: RevokeAuthorizationInput) => Result<Authorization, AuthorizationErrorCode>;
  /** Read-only report of stale authorizations. */
  readonly report: (options?: StaleAuthorizationReportOptions) => StaleAuthorizationReport;
  /** Removes authorizations expired past the grace period. Maintainer or system only. */
  readonly cleanup: (input: CleanupAuthorizationsInput) => Result<CleanupResult, AuthorizationErrorCode>;
  readonly get: (id: string) => Authorization | undefined;
  readonly stateOf: (id: string) => AuthorizationState | undefined;
  /** Every authorization, ordered by id. */
  readonly list: () => readonly Authorization[];
}

export interface AuthorizationStoreOptions {
  readonly now?: () => number;
  readonly newId?: () => string;
  readonly gracePeriodMs?: number;
  /**
   * Entitlement hook: whether `grantor` itself holds `scope` on `resourceId`
   * (`null` means every resource). When set, a grant the grantor could not make
   * is refused, a grant without a resource is reserved for maintainers, and
   * `authorize` stops honouring a grant once its grantor loses the entitlement.
   * When omitted, the grantor's entitlement is the caller's responsibility.
   */
  readonly canDelegate?: (grantor: string, scope: string, resourceId: string | null) => boolean;
  /**
   * Test seam: substitutes the audit recorder. When it returns `undefined` the
   * store behaves as if the audit trail rejected the event and applies nothing.
   */
  readonly record?: (input: AuditInput) => AuditEvent | undefined;
}

/** The sensitive action each operation records; declared in `SENSITIVE_ACTIONS`. */
const AUDITED = {
  grant: { action: "authorization.granted" },
  renew: { action: "authorization.renewed" },
  revoke: { action: "authorization.revoked" },
  cleanup: { action: "authorization.cleaned_up" }
} as const;

type AuthorizationAction = (typeof AUDITED)[keyof typeof AUDITED]["action"];

export function createAuthorizationStore(options: AuthorizationStoreOptions = {}): AuthorizationStore {
  const now = options.now ?? (() => Date.now());
  const record = options.record ?? recordAudit;
  const gracePeriodMs = options.gracePeriodMs ?? DEFAULT_RENEWAL_GRACE_MS;
  let counter = 0;
  const newId = options.newId ?? (() => `authorization-${++counter}`);
  const records = new Map<string, Authorization>();

  const iso = (ms: number): string => new Date(ms).toISOString();
  const copy = (value: Authorization): Authorization => ({ ...value });

  function audit(
    action: AuthorizationAction,
    actor: AuditActor,
    id: string,
    outcome: "allowed" | "denied",
    details: {
      reason?: string;
      errorCode?: AuthorizationErrorCode;
      before?: Record<string, unknown>;
      after?: Record<string, unknown>;
    } = {}
  ): AuditEvent | undefined {
    return record({
      action,
      actor,
      scope: actor.kind === "user" ? "own" : "maintainer",
      target: { kind: "authorization", id },
      reason: details.reason !== undefined && REASON_PATTERN.test(details.reason) ? details.reason : action.split(".")[1],
      outcome,
      before: details.before,
      after: details.after,
      at: iso(now()),
      errorCode: details.errorCode
    });
  }

  function refuse(
    action: AuthorizationAction,
    actor: AuditActor,
    id: string,
    code: AuthorizationErrorCode,
    reason?: string
  ): Result<never, AuthorizationErrorCode> {
    audit(action, actor, id, "denied", { reason, errorCode: code });
    return err(code);
  }

  /** The grantor acting for itself, or a maintainer. */
  function mayManage(actor: AuditActor, authorization: { grantor: string }): boolean {
    return actor.kind === "maintainer" || (actor.kind === "user" && actor.id === authorization.grantor);
  }

  function snapshot(authorization: Authorization, at: number): Record<string, unknown> {
    return {
      state: authorizationState(authorization, at),
      expiresAt: authorization.expiresAt,
      renewals: authorization.renewals
    };
  }

  return {
    grant(input) {
      const { actor, grantor, grantee, scope, resourceId, ttlMs, reason } = input;
      if (
        !isLabel(grantor) ||
        !isLabel(grantee) ||
        grantor === grantee ||
        typeof scope !== "string" ||
        !SCOPE_PATTERN.test(scope) ||
        (resourceId !== undefined && !isLabel(resourceId)) ||
        !isDuration(ttlMs)
      ) {
        return err("invalid_authorization");
      }
      const id = newId();
      if (!mayManage(actor, { grantor })) return refuse(AUDITED.grant.action, actor, id, "grant_unauthorized", reason);
      if (
        options.canDelegate &&
        (!options.canDelegate(grantor, scope, resourceId ?? null) ||
          (resourceId === undefined && actor.kind !== "maintainer"))
      ) {
        return refuse(AUDITED.grant.action, actor, id, "grant_unauthorized", reason);
      }

      const issuedAt = now();
      const authorization: Authorization = {
        id,
        grantor,
        grantee,
        scope,
        resourceId: resourceId ?? null,
        status: "active",
        issuedAt: iso(issuedAt),
        expiresAt: iso(issuedAt + ttlMs),
        renewals: 0
      };
      if (!audit(AUDITED.grant.action, actor, id, "allowed", { reason, after: snapshot(authorization, issuedAt) })) {
        return err("authorization_audit_failed");
      }
      records.set(id, authorization);
      return ok(copy(authorization));
    },

    authorize(input) {
      const at = now();
      const candidates = [...records.values()].filter(
        (entry) =>
          entry.grantee === input.grantee &&
          entry.scope === input.scope &&
          (entry.resourceId === null || entry.resourceId === (input.resourceId ?? null))
      );
      const live = candidates.filter((entry) => isUsable(authorizationState(entry, at)));
      const usable = live.find(
        (entry) => !options.canDelegate || options.canDelegate(entry.grantor, entry.scope, entry.resourceId)
      );
      if (usable) return ok(copy(usable));
      if (live.length > 0) return err("grantor_not_entitled");
      if (candidates.length === 0) return err("authorization_not_found");

      // Report why the most recently valid one is no longer usable.
      const latest = [...candidates].sort(
        (a, b) => Date.parse(b.expiresAt) - Date.parse(a.expiresAt) || (a.id < b.id ? -1 : 1)
      )[0];
      return err(`authorization_${authorizationState(latest, at)}` as AuthorizationErrorCode);
    },

    renew(input) {
      const { id, actor, confirmed, extendByMs, reason } = input;
      const current = records.get(id);
      if (!current) return err("authorization_not_found");

      if (!mayManage(actor, current)) return refuse(AUDITED.renew.action, actor, id, "renewal_unauthorized", reason);
      if (confirmed !== true) return refuse(AUDITED.renew.action, actor, id, "renewal_not_confirmed", reason);

      const at = now();
      const state = authorizationState(current, at);
      if (state === "revoked") return refuse(AUDITED.renew.action, actor, id, "authorization_revoked", reason);
      if (state === "cleaned") return refuse(AUDITED.renew.action, actor, id, "authorization_cleaned", reason);
      if (state === "expired" && at - Date.parse(current.expiresAt) > gracePeriodMs) {
        return refuse(AUDITED.renew.action, actor, id, "renewal_window_closed", reason);
      }
      if (!isDuration(extendByMs)) return err("invalid_authorization");

      const renewed: Authorization = {
        ...current,
        expiresAt: iso(Math.max(at, Date.parse(current.expiresAt)) + extendByMs),
        renewals: current.renewals + 1,
        lastRenewedAt: iso(at)
      };
      const event = audit(AUDITED.renew.action, actor, id, "allowed", {
        reason,
        before: snapshot(current, at),
        after: snapshot(renewed, at)
      });
      if (!event) return err("authorization_audit_failed");
      records.set(id, renewed);
      return ok(copy(renewed));
    },

    revoke(input) {
      const { id, actor, reason } = input;
      const current = records.get(id);
      if (!current) return err("authorization_not_found");

      if (!mayManage(actor, current)) return refuse(AUDITED.revoke.action, actor, id, "revoke_unauthorized", reason);

      const at = now();
      const state = authorizationState(current, at);
      if (state === "revoked") return refuse(AUDITED.revoke.action, actor, id, "authorization_revoked", reason);
      if (state === "cleaned") return refuse(AUDITED.revoke.action, actor, id, "authorization_cleaned", reason);

      const revoked: Authorization = { ...current, status: "revoked", revokedAt: iso(at) };
      const event = audit(AUDITED.revoke.action, actor, id, "allowed", {
        reason,
        before: snapshot(current, at),
        after: snapshot(revoked, at)
      });
      if (!event) return err("authorization_audit_failed");
      records.set(id, revoked);
      return ok(copy(revoked));
    },

    report(reportOptions = {}) {
      const at = now();
      const all = [...records.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const expired = all.filter((entry) => authorizationState(entry, at) === "expired");
      const window = reportOptions.expiringWithinMs ?? 0;
      return {
        generatedAt: iso(at),
        expired: expired.map(copy),
        cleanable: expired.filter((entry) => at - Date.parse(entry.expiresAt) > gracePeriodMs).map(copy),
        expiringSoon: all
          .filter((entry) => isUsable(authorizationState(entry, at)) && Date.parse(entry.expiresAt) - at <= window)
          .map(copy)
      };
    },

    cleanup(input) {
      const { actor, reason } = input;
      if (actor.kind !== "maintainer" && actor.kind !== "system") {
        return refuse(AUDITED.cleanup.action, actor, "all", "cleanup_unauthorized", reason);
      }

      const at = now();
      const cleaned: string[] = [];
      const skipped: string[] = [];
      const due = [...records.values()]
        .filter(
          (entry) =>
            authorizationState(entry, at) === "expired" && at - Date.parse(entry.expiresAt) > gracePeriodMs
        )
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

      for (const entry of due) {
        const next: Authorization = { ...entry, status: "cleaned", cleanedAt: iso(at) };
        const event = audit(AUDITED.cleanup.action, actor, entry.id, "allowed", {
          reason,
          before: snapshot(entry, at),
          after: snapshot(next, at)
        });
        if (!event) {
          skipped.push(entry.id);
          continue;
        }
        records.set(entry.id, next);
        cleaned.push(entry.id);
      }
      return ok({ cleaned, skipped });
    },

    get(id) {
      const found = records.get(id);
      return found ? copy(found) : undefined;
    },

    stateOf(id) {
      const found = records.get(id);
      return found ? authorizationState(found, now()) : undefined;
    },

    list() {
      return [...records.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map(copy);
    }
  };
}
