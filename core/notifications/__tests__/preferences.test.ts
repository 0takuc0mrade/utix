import { describe, expect, it } from "vitest";
import { NotificationStore } from "../store";
import type { NotificationStorage } from "../types";

class TestStorage implements NotificationStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }

  removeItem(key: string) {
    this.values.delete(key);
  }
}

const account = `account:${`G${"A".repeat(55)}`}` as const;

describe("NotificationStore Preferences & Mandatory Alert Routing (#235)", () => {
  it("initializes with sensible durable default preferences", () => {
    const storage = new TestStorage();
    const store = new NotificationStore(storage);

    const prefs = store.getPreferences(account);
    expect(prefs.recipient).toBe(account);
    expect(prefs.muted).toBe(false);
    expect(prefs.enabledEvents.failure).toBe(true);
    expect(prefs.enabledEvents.completed).toBe(true);
    expect(prefs.enabledTones.error).toBe(true);
    expect(prefs.mandatoryAlertsAlwaysDeliver).toBe(true);
  });

  it("persists updated preferences durably across store instances", () => {
    const storage = new TestStorage();
    const store1 = new NotificationStore(storage);

    store1.updatePreferences(account, {
      muted: true,
      enabledEvents: { completed: false, failure: true, approval_required: true, recovery: true, retry: true }
    });

    const store2 = new NotificationStore(storage);
    const prefs = store2.getPreferences(account);

    expect(prefs.muted).toBe(true);
    expect(prefs.enabledEvents.completed).toBe(false);
    expect(prefs.version).toBeGreaterThan(1);
  });

  it("suppresses optional notifications when user has muted or disabled event", () => {
    const storage = new TestStorage();
    const store = new NotificationStore(storage);

    store.updatePreferences(account, { muted: true });

    const optionalNotification = store.publish({
      recipient: account,
      event: "completed",
      tone: "success",
      title: "Export Ready",
      message: "Export has finished processing",
      href: "/tools/operation-browser",
      dedupeKey: "export-done-1"
    });

    expect(optionalNotification).toBeNull();
    expect(store.list(account)).toHaveLength(0);
    expect(store.unreadCount(account)).toBe(0);
  });

  it("delivers mandatory lifecycle and security alerts even when recipient has muted all notifications", () => {
    const storage = new TestStorage();
    const store = new NotificationStore(storage);

    // User mutes everything
    store.updatePreferences(account, { muted: true });

    // Mandatory critical failure alert
    const mandatoryAlert = store.publish({
      recipient: account,
      event: "failure",
      tone: "error",
      title: "Key Threshold Compromised",
      message: "Signer threshold was modified without approval",
      href: "/tools/account-signers",
      dedupeKey: "security-breach-1",
      category: "security",
      urgency: "mandatory"
    });

    expect(mandatoryAlert).not.toBeNull();
    expect(mandatoryAlert?.routedAs).toBe("mandatory_override");
    expect(mandatoryAlert?.urgency).toBe("mandatory");
    expect(mandatoryAlert?.category).toBe("security");

    // Must be persisted and visible in notifications list
    const list = store.list(account);
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(mandatoryAlert?.id);
    expect(store.unreadCount(account)).toBe(1);
  });

  it("automatically infers mandatory urgency for critical system failures", () => {
    const storage = new TestStorage();
    const store = new NotificationStore(storage);

    // User disables failure events
    store.updatePreferences(account, {
      enabledEvents: { failure: false, completed: true, approval_required: true, recovery: true, retry: true }
    });

    // An error-tone failure is mandatory by default
    const criticalFailure = store.publish({
      recipient: account,
      event: "failure",
      tone: "error",
      title: "Fatal Ledger Rejection",
      message: "Sequence gap caused transaction rejection",
      href: "/tools/transaction-decoder",
      dedupeKey: "fatal-seq-gap-1"
    });

    expect(criticalFailure).not.toBeNull();
    expect(criticalFailure?.routedAs).toBe("mandatory_override");
    expect(criticalFailure?.urgency).toBe("mandatory");
  });

  it("resets preferences to factory defaults", () => {
    const storage = new TestStorage();
    const store = new NotificationStore(storage);

    store.updatePreferences(account, { muted: true });
    expect(store.getPreferences(account).muted).toBe(true);

    const reset = store.resetPreferences(account);
    expect(reset.muted).toBe(false);
    expect(store.getPreferences(account).muted).toBe(false);
  });
});
