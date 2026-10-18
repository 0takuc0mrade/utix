import { describe, expect, it, beforeEach } from "vitest";
import { type AuditActor, createIsolatedAuditTrail } from "@/core/audit/audit";
import type { AdminConfigInput, AdminConfigKey } from "@/core/admin-config/store";
import { createAdminConfigStore } from "@/core/admin-config/store";

function actor(kind: AuditActor["kind"] = "maintainer", id = "ada"): AuditActor {
  return { kind, id };
}

function trailBackedStore(trail = createIsolatedAuditTrail()) {
  return createAdminConfigStore({
    record: (input) => {
      const result = trail.record(input);
      return result.ok ? result.value : undefined;
    }
  });
}

function input(overrides: Partial<AdminConfigInput> = {}): AdminConfigInput {
  return {
    actor: actor(),
    key: "network.endpoint",
    value: "https://horizon-mainnet.stellar.org",
    authorized: true,
    reason: "config_update",
    ...overrides
  };
}

describe("admin configuration store", () => {
  let trail: ReturnType<typeof createIsolatedAuditTrail>;

  beforeEach(() => {
    trail = createIsolatedAuditTrail();
  });

  it("applies an authorized change and records audit evidence", () => {
    const store = trailBackedStore(trail);
    const result = store.setConfig(
      input({ key: "network.endpoint", value: "https://horizon-mainnet.stellar.org" })
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value["network.endpoint"]).toBe("https://horizon-mainnet.stellar.org");
    }

    const events = trail.all();
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe("admin.config_changed");
    expect(events[0].outcome).toBe("allowed");
    expect(events[0].actor).toEqual({ kind: "maintainer", id: "ada" });
    expect(events[0].scope).toBe("maintainer");
    expect(events[0].target).toEqual({ kind: "admin_config", id: "network.endpoint" });
    expect(events[0].reason).toBe("config_update");
    expect(events[0].before).toEqual({ "network.endpoint": "https://horizon-testnet.stellar.org" });
    expect(events[0].after).toEqual({ "network.endpoint": "https://horizon-mainnet.stellar.org" });
    expect(typeof events[0].id).toBe("string");
    expect(typeof events[0].at).toBe("string");
    expect(typeof events[0].correlationId).toBe("string");
  });

  it("denies an unauthorized change, leaves config untouched, and records the refusal", () => {
    const store = trailBackedStore(trail);
    const result = store.setConfig(input({ actor: actor("user", "viewer-1"), authorized: false }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("admin_config_not_allowed");

    expect(store.getConfig()["network.endpoint"]).toBe("https://horizon-testnet.stellar.org");

    const events = trail.all();
    expect(events).toHaveLength(1);
    expect(events[0].outcome).toBe("denied");
    expect(events[0].errorCode).toBe("admin_config_not_allowed");
    expect(events[0].actor).toEqual({ kind: "user", id: "viewer-1" });
  });

  it("denies service accounts just like viewers", () => {
    const store = trailBackedStore(trail);
    const result = store.setConfig(input({ actor: actor("system", "cron"), authorized: false }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("admin_config_not_allowed");
    expect(trail.all()[0].errorCode).toBe("admin_config_not_allowed");
  });

  it("rejects an unknown key and records the refusal", () => {
    const store = trailBackedStore(trail);
    const result = store.setConfig(input({ key: "bogus" as AdminConfigKey, value: "x" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("admin_config_unknown_key");
    expect(trail.all()[0].errorCode).toBe("admin_config_unknown_key");
  });

  it("rejects an endpoint carrying credentials and records the refusal", () => {
    const store = trailBackedStore(trail);
    const result = store.setConfig(input({ value: "https://user:secret@horizon.example" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("admin_config_invalid_value");
    expect(store.getConfig()["network.endpoint"]).not.toBe("https://user:secret@horizon.example");
    expect(trail.all()[0].errorCode).toBe("admin_config_invalid_value");
  });

  it("rejects a non-https endpoint and records the refusal", () => {
    const store = trailBackedStore(trail);
    const result = store.setConfig(input({ value: "ftp://horizon.example" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("admin_config_invalid_value");
  });

  it("applies a role.default change with a valid role", () => {
    const store = trailBackedStore(trail);
    const result = store.setConfig(input({ key: "role.default", value: "maintainer" }));
    expect(result.ok).toBe(true);
    expect(store.getConfig()["role.default"]).toBe("maintainer");
  });

  it("rejects an invalid role.default", () => {
    const store = trailBackedStore(trail);
    const result = store.setConfig(input({ key: "role.default", value: "god" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("admin_config_invalid_value");
  });

  it("rejects a health.checkInterval that is not a positive number", () => {
    const store = trailBackedStore(trail);
    expect(store.setConfig(input({ key: "health.checkInterval", value: -5 })).ok).toBe(false);
    expect(store.setConfig(input({ key: "health.checkInterval", value: "sixty" })).ok).toBe(false);
    const good = store.setConfig(input({ key: "health.checkInterval", value: 120_000 }));
    expect(good.ok).toBe(true);
    expect(store.getConfig()["health.checkInterval"]).toBe(120_000);
  });

  it("retries after a failure and succeeds with a valid value", () => {
    const store = trailBackedStore(trail);
    const first = store.setConfig(input({ value: "javascript:alert(1)" }));
    expect(first.ok).toBe(false);

    const retry = store.setConfig(input({ value: "https://horizon-mainnet.stellar.org" }));
    expect(retry.ok).toBe(true);
    expect(store.getConfig()["network.endpoint"]).toBe("https://horizon-mainnet.stellar.org");

    const events = trail.all();
    expect(events).toHaveLength(2);
    expect(events[0].outcome).toBe("denied");
    expect(events[1].outcome).toBe("allowed");
  });

  it("is idempotent: re-applying the same value is a no-op success and is not re-audited", () => {
    const store = trailBackedStore(trail);
    const first = store.setConfig(input({ value: "https://horizon-mainnet.stellar.org" }));
    expect(first.ok).toBe(true);
    const eventsAfterFirst = trail.all().length;

    const second = store.setConfig(input({ value: "https://horizon-mainnet.stellar.org" }));
    expect(second.ok).toBe(true);
    expect(trail.all()).toHaveLength(eventsAfterFirst);
  });

  it("does not apply a change when the audit trail rejects the event", () => {
    const store = createAdminConfigStore({
      record: () => undefined // simulate audit trail rejection
    });
    const result = store.setConfig(input());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("admin_config_audit_rejected");

    // config untouched: no audit evidence means no change
    expect(store.getConfig()["network.endpoint"]).toBe("https://horizon-testnet.stellar.org");
  });

  it("exposes a read-only copy of the config", () => {
    const store = trailBackedStore(trail);
    const copy = store.getConfig();
    expect(copy["network.endpoint"]).toBe("https://horizon-testnet.stellar.org");
  });
});
