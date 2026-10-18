import { describe, expect, it, beforeEach } from "vitest";
import {
  getAuditTrail,
  recordAudit,
  SENSITIVE_ACTIONS,
  type AuditInput
} from "@/core/audit/audit";
import { createAdminConfigStore } from "@/core/admin-config/store";

function baseInput(overrides: Partial<AuditInput> = {}): AuditInput {
  return {
    action: "admin.config_changed",
    actor: { kind: "maintainer", id: "ada" },
    scope: "maintainer",
    target: { kind: "admin_config", id: "network.endpoint" },
    reason: "config_update",
    outcome: "allowed",
    before: { "network.endpoint": "https://horizon-testnet.stellar.org" },
    after: { "network.endpoint": "https://horizon-mainnet.stellar.org" },
    ...overrides
  };
}

describe("admin configuration audit evidence", () => {
  beforeEach(() => {
    getAuditTrail().reset();
  });

  it("declares admin.config_changed as a sensitive action", () => {
    expect(SENSITIVE_ACTIONS).toContain("admin.config_changed");
  });

  it("records an allowed change with full attribution and before/after", () => {
    const event = recordAudit(baseInput());
    expect(event).toBeDefined();
    expect(event!.action).toBe("admin.config_changed");
    expect(event!.outcome).toBe("allowed");
    expect(event!.scope).toBe("maintainer");
    expect(event!.target).toEqual({ kind: "admin_config", id: "network.endpoint" });
    expect(event!.reason).toBe("config_update");
    expect(event!.before).toEqual({ "network.endpoint": "https://horizon-testnet.stellar.org" });
    expect(event!.after).toEqual({ "network.endpoint": "https://horizon-mainnet.stellar.org" });
  });

  it("records a denied change with the refusal code", () => {
    const event = recordAudit({
      ...baseInput(),
      outcome: "denied",
      errorCode: "admin_config_not_allowed"
    });
    expect(event).toBeDefined();
    expect(event!.outcome).toBe("denied");
    expect(event!.errorCode).toBe("admin_config_not_allowed");
  });

  it("rejects a free-text reason that is not a stable token", () => {
    expect(recordAudit({ ...baseInput(), reason: "changed it because reasons" })).toBeUndefined();
    expect(recordAudit({ ...baseInput(), reason: "UPPERCASE" })).toBeUndefined();
    expect(recordAudit({ ...baseInput(), reason: "a".repeat(65) })).toBeUndefined();
  });

  it("drops nested before/after values instead of storing a payload, and redacts sensitive keys", () => {
    const event = recordAudit({
      ...baseInput(),
      before: {
        "network.endpoint": "https://x",
        nested: { secret: "payload" } as unknown as string
      },
      after: {
        "network.endpoint": "https://y",
        internal: { debug: true } as unknown as string,
        seedHint: "S...seed..."
      }
    });
    expect(event).toBeDefined();
    expect(event!.before).not.toHaveProperty("nested");
    expect(event!.after).not.toHaveProperty("internal");
    expect(event!.after.seedHint).toBe("[REDACTED]");
    expect(event!.after).toEqual({ "network.endpoint": "https://y", seedHint: "[REDACTED]" });
  });

  it("keeps the trail append-only: both changes are retained, oldest first", () => {
    const store = createAdminConfigStore({
      record: (input) => {
        const result = recordAudit(input);
        return result.ok ? result.value : undefined;
      }
    });
    store.setConfig({
      actor: { kind: "maintainer", id: "ada" },
      key: "network.endpoint",
      value: "https://one.example",
      authorized: true
    });
    store.setConfig({
      actor: { kind: "maintainer", id: "ada" },
      key: "network.endpoint",
      value: "https://two.example",
      authorized: true
    });

    expect(store.getConfig()["network.endpoint"]).toBe("https://two.example");

    const changes = getAuditTrail().all().filter((e) => e.action === "admin.config_changed");
    expect(changes).toHaveLength(2);
    expect(changes[0].after).toEqual({ "network.endpoint": "https://one.example" });
    expect(changes[1].after).toEqual({ "network.endpoint": "https://two.example" });
  });
});
