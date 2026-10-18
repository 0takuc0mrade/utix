/**
 * Types for stale authorization cleanup and renewal (#183).
 *
 * An authorization is a time-boxed permission one principal (the grantor)
 * delegates to another (the grantee) for a scope, optionally on one resource.
 */

import type { AuditActor } from "@/core/audit/audit";

/** What the store persists. Expiry is derived from `expiresAt`, never stored. */
export type AuthorizationRecordStatus = "active" | "revoked" | "cleaned";

/**
 * The effective state at an instant:
 * - `active`: usable and never renewed;
 * - `renewed`: usable and renewed at least once;
 * - `expired`: past `expiresAt` and refused, but still renewable inside the grace period;
 * - `cleaned`: removed by cleanup after the grace period; a new grant is needed;
 * - `revoked`: withdrawn by the grantor or a maintainer.
 */
export type AuthorizationState = "active" | "renewed" | "expired" | "cleaned" | "revoked";

export interface Authorization {
  readonly id: string;
  readonly grantor: string;
  readonly grantee: string;
  /** What the authorization allows, e.g. `tickets.redeem`. */
  readonly scope: string;
  /** The resource it is limited to, or `null` for every resource under the scope. */
  readonly resourceId: string | null;
  readonly status: AuthorizationRecordStatus;
  /** ISO-8601 instants. */
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly renewals: number;
  readonly lastRenewedAt?: string;
  readonly revokedAt?: string;
  readonly cleanedAt?: string;
}

export type AuthorizationErrorCode =
  | "invalid_authorization"
  | "authorization_not_found"
  | "authorization_expired"
  | "authorization_revoked"
  | "authorization_cleaned"
  | "grant_unauthorized"
  | "grantor_not_entitled"
  | "revoke_unauthorized"
  | "cleanup_unauthorized"
  | "renewal_unauthorized"
  | "renewal_not_confirmed"
  | "renewal_window_closed"
  | "authorization_audit_failed";

export interface GrantAuthorizationInput {
  readonly actor: AuditActor;
  readonly grantor: string;
  readonly grantee: string;
  readonly scope: string;
  readonly resourceId?: string;
  /** Lifetime from now, in milliseconds. */
  readonly ttlMs: number;
  readonly reason?: string;
}

export interface AuthorizeInput {
  readonly grantee: string;
  readonly scope: string;
  readonly resourceId?: string;
}

export interface RenewAuthorizationInput {
  readonly id: string;
  readonly actor: AuditActor;
  /** The authorized actor must explicitly confirm the renewal. */
  readonly confirmed: boolean;
  /** How far past the current expiry (or now, if already expired) to extend, in milliseconds. */
  readonly extendByMs: number;
  readonly reason?: string;
}

export interface RevokeAuthorizationInput {
  readonly id: string;
  readonly actor: AuditActor;
  readonly reason?: string;
}

export interface CleanupAuthorizationsInput {
  readonly actor: AuditActor;
  readonly reason?: string;
}

export interface StaleAuthorizationReportOptions {
  /** Also list active authorizations that expire within this window. */
  readonly expiringWithinMs?: number;
}

export interface StaleAuthorizationReport {
  /** ISO-8601 instant the report describes. */
  readonly generatedAt: string;
  /** Expired but still renewable. */
  readonly expired: readonly Authorization[];
  /** Expired for longer than the grace period; the next cleanup removes these. */
  readonly cleanable: readonly Authorization[];
  /** Still usable but expiring inside the requested window. */
  readonly expiringSoon: readonly Authorization[];
}

export interface CleanupResult {
  readonly cleaned: readonly string[];
  /** Left in place because the audit trail rejected the event. */
  readonly skipped: readonly string[];
}
