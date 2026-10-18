import type { Role } from "@/core/auth/types";
import type { AuditActor } from "@/core/audit/audit";

/**
 * Configuration keys an administrator may change at runtime. Values are scalar
 * primitives (string | number | boolean | null) so they can be recorded in the
 * audit trail without smuggling a private payload.
 */
export type AdminConfigKey =
  | "network.endpoint"
  | "network.passphrase"
  | "role.default"
  | "health.checkInterval";

export interface AdminConfig {
  readonly "network.endpoint": string | number | boolean | null;
  readonly "network.passphrase": string | number | boolean | null;
  readonly "role.default": string | number | boolean | null;
  readonly "health.checkInterval": string | number | boolean | null;
}

export type AdminConfigErrorCode =
  | "admin_config_not_allowed"     // caller was not authorized
  | "admin_config_unknown_key"     // key is not a known admin config key
  | "admin_config_invalid_value"   // value fails validation for the key
  | "admin_config_audit_rejected"; // audit trail refused the event; change not applied

export interface AdminConfigInput {
  actor: AuditActor;
  key: AdminConfigKey;
  value: string | number | boolean | null;
  /**
   * Pre-computed by the caller after `requirePermission(context, "admin:config")`.
   * The store records this decision; it does not re-derive authorization so the
   * authorization boundary stays a single, testable point.
   */
  authorized: boolean;
  /** Stable token an operator can group events by (`^[a-z0-9_.:-]{1,64}$`). */
  reason?: string;
}

export const VALID_ROLES: readonly Role[] = ["viewer", "maintainer", "service"];
