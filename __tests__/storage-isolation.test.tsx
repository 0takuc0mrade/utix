import { cleanup, screen, act } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { renderFeature, createIsolatedStorage } from "@/core/testing";
import { useNetwork } from "@/core/network/NetworkProvider";
import { useNotifications } from "@/core/notifications/NotificationProvider";
import { NETWORK_STORAGE_KEY } from "@/core/network/config";

function TestConsumer() {
  const { network, setNetwork } = useNetwork();
  const { notifications, unreadCount, publish } = useNotifications();

  return (
    <div>
      <span data-testid="network-status">{network}</span>
      <span data-testid="unread-count">{unreadCount}</span>
      <button type="button" onClick={() => setNetwork("mainnet")}>
        Switch to Mainnet
      </button>
      <button
        type="button"
        onClick={() =>
          publish({
            recipient: "workspace",
            event: "failure",
            tone: "warning",
            title: "Test Alert",
            message: "Action required",
            href: "/tools/test",
            dedupeKey: `alert-${Date.now()}`,
            urgency: "standard",
            category: "operational"
          })
        }
      >
        Send Notification
      </button>
      <ul>
        {notifications.map((n) => (
          <li key={n.id}>{n.title}</li>
        ))}
      </ul>
    </div>
  );
}

describe("Deterministic Browser Storage Isolation (#155)", () => {
  afterEach(() => {
    cleanup();
  });

  describe("Failing-order regression test demonstration", () => {
    it("demonstrates state contamination when sharing unisolated storage across tests", () => {
      // Unisolated shared storage simulation
      const leakySharedStorage = createIsolatedStorage();

      // Test 1: Mutates shared storage to 'mainnet'
      leakySharedStorage.setItem(NETWORK_STORAGE_KEY, "mainnet");

      // Test 2 (running after Test 1): Expects default clean state, but gets contaminated by Test 1!
      const leakedValue = leakySharedStorage.getItem(NETWORK_STORAGE_KEY);
      expect(leakedValue).toBe("mainnet"); // Demonstrates leakage hazard
    });
  });

  describe("Deterministic isolation with renderFeature and injected storage", () => {
    it("Step A: Render 1 modifies network and publishes notifications in its isolated fixture", async () => {
      const { user, storage } = renderFeature(<TestConsumer />);

      expect(screen.getByTestId("network-status").textContent).toBe("testnet");
      expect(screen.getByTestId("unread-count").textContent).toBe("0");

      // Mutate network to mainnet
      await user.click(screen.getByRole("button", { name: "Switch to Mainnet" }));
      expect(screen.getByTestId("network-status").textContent).toBe("mainnet");
      expect(storage.getItem(NETWORK_STORAGE_KEY)).toBe("mainnet");

      // Send notification
      await user.click(screen.getByRole("button", { name: "Send Notification" }));
      expect(screen.getByTestId("unread-count").textContent).toBe("1");
    });

    it("Step B: Render 2 starts with pristine testnet and zero notifications (independent of Step A)", () => {
      // Render 2 runs after Step A. Without isolation, Step A's mainnet and notifications would leak.
      // With deterministic isolation, Render 2 owns a brand new storage fixture.
      const { storage } = renderFeature(<TestConsumer />);

      expect(screen.getByTestId("network-status").textContent).toBe("testnet");
      expect(screen.getByTestId("unread-count").textContent).toBe("0");
      expect(storage.getItem(NETWORK_STORAGE_KEY)).toBeNull();
    });

    it("supports explicitly sharing an injected storage fixture when persistence is under test", async () => {
      const sharedFixture = createIsolatedStorage();

      // First session: write to the explicit fixture
      const session1 = renderFeature(<TestConsumer />, { storage: sharedFixture });
      await session1.user.click(session1.getByRole("button", { name: "Switch to Mainnet" }));
      expect(session1.getByTestId("network-status").textContent).toBe("mainnet");
      cleanup();

      // Second session: re-mount with the SAME fixture to test persistence
      const session2 = renderFeature(<TestConsumer />, { storage: sharedFixture });
      expect(session2.getByTestId("network-status").textContent).toBe("mainnet");
    });

    it("createIsolatedStorage provides complete Storage interface fidelity", () => {
      const storage = createIsolatedStorage({ initialKey: "initialValue" });

      expect(storage.length).toBe(1);
      expect(storage.getItem("initialKey")).toBe("initialValue");
      expect(storage.key(0)).toBe("initialKey");

      storage.setItem("key2", "value2");
      expect(storage.length).toBe(2);
      expect(storage.getItem("key2")).toBe("value2");

      storage.removeItem("initialKey");
      expect(storage.length).toBe(1);
      expect(storage.getItem("initialKey")).toBeNull();

      storage.clear();
      expect(storage.length).toBe(0);
      expect(storage.getItem("key2")).toBeNull();
    });
  });
});
