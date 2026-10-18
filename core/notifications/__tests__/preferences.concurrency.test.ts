import { describe, expect, it } from "vitest";
import { NotificationStore, StalePreferencesVersionError } from "../store";
import type { NotificationStorage } from "../types";

/**
 * Stale-version writes to notification preferences (#271).
 *
 * Two tabs (or devices syncing one storage) each read the preferences, compute
 * a change from what they read, and write it back. Without a version check the
 * slower tab's write is computed from a stale read: toggling `muted` from a
 * stale `false` re-mutes a recipient who has just unmuted elsewhere. Passing
 * `expectedVersion` turns that into an explicit, retryable rejection.
 */
function sharedStorage(): NotificationStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key)
  };
}

const alice = `account:G${"A".repeat(55)}` as const;
const bob = `account:G${"B".repeat(55)}` as const;

function twoTabs() {
  const storage = sharedStorage();
  return { storage, tabA: new NotificationStore(storage), tabB: new NotificationStore(storage) };
}

describe("notification preferences under concurrent writers (#271)", () => {
  it("applies a write whose expected version is current and advances the version", () => {
    const { tabA } = twoTabs();
    const before = tabA.getPreferences(alice);

    const after = tabA.updatePreferences(alice, { muted: true }, { expectedVersion: before.version });

    expect(after.version).toBe(before.version + 1);
    expect(tabA.getPreferences(alice)).toMatchObject({ muted: true, version: before.version + 1 });
  });

  it("rejects the slower of two writers that read the same version", () => {
    const { tabA, tabB } = twoTabs();
    const seenByA = tabA.getPreferences(alice);
    const seenByB = tabB.getPreferences(alice);

    tabB.updatePreferences(alice, { muted: !seenByB.muted }, { expectedVersion: seenByB.version });

    let rejection: unknown;
    try {
      tabA.updatePreferences(alice, { muted: !seenByA.muted }, { expectedVersion: seenByA.version });
    } catch (error) {
      rejection = error;
    }

    expect(rejection).toBeInstanceOf(StalePreferencesVersionError);
    expect(rejection).toMatchObject({ recipient: alice, expectedVersion: 1, actualVersion: 2 });
    expect(tabA.getPreferences(alice)).toMatchObject({ muted: true, version: 2 });
  });

  it("succeeds when the rejected writer re-reads and retries from the fresh version", () => {
    const { tabA, tabB } = twoTabs();
    const stale = tabA.getPreferences(alice);
    tabB.updatePreferences(alice, { muted: true });

    expect(() => tabA.updatePreferences(alice, { enabledTones: { ...stale.enabledTones, info: false } }, { expectedVersion: stale.version }))
      .toThrow(StalePreferencesVersionError);

    const fresh = tabA.getPreferences(alice);
    const retried = tabA.updatePreferences(
      alice,
      { enabledTones: { ...fresh.enabledTones, info: false } },
      { expectedVersion: fresh.version }
    );

    expect(retried).toMatchObject({ muted: true, version: fresh.version + 1 });
    expect(retried.enabledTones.info).toBe(false);
  });

  it("applies a double-submitted toggle exactly once", () => {
    const { tabA } = twoTabs();
    const seen = tabA.getPreferences(alice);
    const toggle = () => tabA.updatePreferences(alice, { muted: !seen.muted }, { expectedVersion: seen.version });

    toggle();
    expect(toggle).toThrow(StalePreferencesVersionError);
    expect(tabA.getPreferences(alice)).toMatchObject({ muted: true, version: seen.version + 1 });
  });

  it("keeps last-write-wins for callers that do not pass a version", () => {
    const { tabA, tabB } = twoTabs();
    tabB.updatePreferences(alice, { muted: true });
    tabA.updatePreferences(alice, { muted: false });

    expect(tabA.getPreferences(alice)).toMatchObject({ muted: false, version: 3 });
  });

  it("scopes versions per recipient, so writers for different recipients never conflict", () => {
    const { tabA, tabB } = twoTabs();
    const aliceSeen = tabA.getPreferences(alice);
    const bobSeen = tabB.getPreferences(bob);

    tabB.updatePreferences(bob, { muted: true }, { expectedVersion: bobSeen.version });
    tabA.updatePreferences(alice, { muted: true }, { expectedVersion: aliceSeen.version });

    expect(tabA.getPreferences(alice).version).toBe(2);
    expect(tabA.getPreferences(bob).version).toBe(2);
  });

  it("refuses an invalid recipient before any version comparison", () => {
    const { tabA } = twoTabs();
    const forged = "account:not-a-key" as typeof alice;

    expect(() => tabA.updatePreferences(forged, { muted: true }, { expectedVersion: 1 })).toThrow(
      "Invalid notification recipient"
    );
  });

  it("treats a corrupt stored version as the default, so a writer can recover", () => {
    const { storage, tabA } = twoTabs();
    storage.setItem(`utix:notification-preferences:v1:${alice}`, JSON.stringify({ muted: true, version: "x" }));

    const seen = tabA.getPreferences(alice);
    expect(seen.version).toBe(1);
    expect(tabA.updatePreferences(alice, { muted: false }, { expectedVersion: 1 }).version).toBe(2);
  });
});
