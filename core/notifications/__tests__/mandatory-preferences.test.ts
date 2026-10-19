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

const account = `account:${`G${"B".repeat(55)}`}` as const;
const otherAccount = `account:${`G${"C".repeat(55)}`}` as const;

describe("NotificationStore mandatory overrides and preference authorization", () => {
  it("delivers a mandatory failure alert even when the recipient has muted everything", () => {
    const store = new NotificationStore(new TestStorage());
    store.updatePreferences(account, { muted: true });

    const alert = store.publish({
      recipient: account,
      event: "failure",
      tone: "error",
      title: "Payout failed",
      message: "Retry budget exhausted",
      href: "/tools/operation-browser",
      dedupeKey: "payout-failed-1"
    });

    expect(alert).not.toBeNull();
    expect(alert?.routedAs).toBe("mandatory_override");
    expect(alert?.urgency).toBe("mandatory");
  });

  it("still suppresses an optional notification for a muted recipient", () => {
    const store = new NotificationStore(new TestStorage());
    store.updatePreferences(account, { muted: true });

    const optional = store.publish({
      recipient: account,
      event: "completed",
      tone: "success",
      title: "Done",
      message: "Finished",
      href: "/tools/operation-browser",
      dedupeKey: "done-1"
    });

    expect(optional).toBeNull();
  });

  it("refuses a preference update made by another account and leaves the preferences unchanged", () => {
    const store = new NotificationStore(new TestStorage());

    expect(() => store.updatePreferences(account, { muted: true }, otherAccount)).toThrow(
      /cannot be edited/
    );
    expect(store.getPreferences(account).muted).toBe(false);
  });

  it("refuses a workspace reset of an account's preferences", () => {
    const store = new NotificationStore(new TestStorage());
    store.updatePreferences(account, { muted: true });

    expect(() => store.resetPreferences(account, "workspace")).toThrow(/cannot be edited/);
    expect(store.getPreferences(account).muted).toBe(true);
  });

  it("lets the recipient edit their own preferences", () => {
    const store = new NotificationStore(new TestStorage());

    const updated = store.updatePreferences(account, { muted: true }, account);

    expect(updated.muted).toBe(true);
  });
});
