/**
 * Administrative configuration store with mandatory audit evidence.
 *
 * Every change to administrative configuration is recorded in the audit trail
 * *before* it is applied. If the audit event cannot be recorded, the change is
 * not applied — so there is never a configuration change without audit
 * evidence. Refusals (denied, unknown key, invalid value) are recorded too,
 * which is exactly what a reviewer looks for after an incident.
 *
 * Authorization is enforced by the caller (a server action or route handler via
 * `requirePermission(context, "admin:config")`). This store records the outcome
 * of that decision and never applies a change the caller has not authorized.
 */

import { err, ok, type Result } from "@/core/result/result";
import { recordAudit, type AuditActor, type AuditInput } from "@/core/audit/audit";
import { VALID_ROLES } from "@/core/admin-config/types";
import type {
  AdminConfig,
  AdminConfigErrorCode,
  AdminConfigInput,
  AdminConfigKey,
  Role
} from "@/core/admin-config/types";

export const ADMIN_CONFIG_KEYS: readonly AdminConfigKey[] = [
  "network.endpoint",
  "network.passphrase",
  "role.default",
  "health.checkInterval"
] as const;

const DEFAULT_CONFIG: AdminConfig = {
  "network.endpoint": "https://horizon-testnet.stellar.org",
  "network.passphrase": "Test SDF Network ; September 2015",
  "role.default": "viewer",
  "health.checkInterval": 60_000
};

type MutableAdminConfig = { -readonly [K in keyof AdminConfig]: AdminConfig[K] };

function isScalar(value: unknown): value is string | number | boolean | null {
  return (
    value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean"
  );
}

function isValidEndpoint(value: string): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
    if (url.username || url.password) return false;
    return true;
  } catch {
    return false;
  }
}

function validateValue(key: AdminConfigKey, value: unknown): value is string | number | boolean | null {
  if (!isScalar(value)) return false;
  switch (key) {
    case "network.endpoint":
      return typeof value === "string" && isValidEndpoint(value);
    case "network.passphrase":
      return typeof value === "string" && value.length > 0 && value.length <= 200;
    case "role.default":
      return typeof value === "string" && VALID_ROLES.includes(value as Role);
    case "health.checkInterval":
      return typeof value === "number" && Number.isFinite(value) && value > 0 && value < 24 * 60 * 60 * 1000;
  }
}

export interface AdminConfigStore {
  readonly getConfig: () => Readonly<AdminConfig>;
  readonly setConfig: (input: AdminConfigInput) => Result<AdminConfig, AdminConfigErrorCode>;
}

export interface AdminConfigStoreOptions {
  /**
   * Test seam: substitutes the audit recorder. When it returns `undefined` the
   * store behaves as if the audit trail rejected the event and does not apply
   * the change.
   */
  readonly record?: (input: AuditInput) => AuditEvent | undefined;
}

export function createAdminConfigStore(options: AdminConfigStoreOptions = {}): AdminConfigStore {
  const record = options.record ?? recordAudit;
  const config: MutableAdminConfig = { ...DEFAULT_CONFIG };

  function audit(
    actor: AuditActor,
    key: AdminConfigKey,
    value: unknown,
    outcome: "allowed" | "denied",
    errorCode?: AdminConfigErrorCode,
    reason?: string
  ): AuditEvent | undefined {
    return record({
      action: "admin.config_changed",
      actor,
      scope: "maintainer",
      target: { kind: "admin_config", id: key },
      reason: reason ?? "config_update",
      outcome,
      before: { [key]: config[key] },
      after: { [key]: value },
      errorCode
    });
  }

  return {
    getConfig(): Readonly<AdminConfig> {
      return { ...config };
    },

    setConfig(input: AdminConfigInput): Result<AdminConfig, AdminConfigErrorCode> {
      const { actor, key, value, authorized, reason } = input;

      // Authorization path: a change that was not authorized is refused and
      // still recorded, so a reviewer can see who tried and what they asked for.
      if (!authorized) {
        audit(actor, key, value, "denied", "admin_config_not_allowed", reason);
        return err("admin_config_not_allowed");
      }

      if (!ADMIN_CONFIG_KEYS.includes(key)) {
        audit(actor, key, value, "denied", "admin_config_unknown_key", reason);
        return err("admin_config_unknown_key");
      }

      if (!validateValue(key, value)) {
        audit(actor, key, value, "denied", "admin_config_invalid_value", reason);
        return err("admin_config_invalid_value");
      }

      // Idempotent retry: re-applying the current value is a no-op success and
      // is not recorded again because nothing changed.
      if (config[key] === value) {
        return ok({ ...config });
      }

      // Audit-first: the change is only applied once the audit event is on the
      // trail. If the trail rejects it, nothing is applied.
      if (!audit(actor, key, value, "allowed", undefined, reason)) {
        return err("admin_config_audit_rejected");
      }

      config[key] = value;
      return ok({ ...config });
    }
  };
}
