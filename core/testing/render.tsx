import { render, type RenderOptions, type RenderResult } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement, ReactNode } from "react";
import { NetworkProvider, resetNetworkStorageListeners } from "@/core/network/NetworkProvider";
import { NotificationProvider } from "@/core/notifications/NotificationProvider";
import { NotificationStore } from "@/core/notifications/store";
import type { StellarNetwork } from "@/core/network/types";

/**
 * Creates an in-memory Storage fixture for deterministic test isolation (#155).
 * Prevents persisted network, notification, and session test state from leaking across component tests.
 */
export function createIsolatedStorage(initialData: Record<string, string> = {}): Storage {
  const store = new Map<string, string>(Object.entries(initialData));
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, String(value)),
    removeItem: (key: string) => store.delete(key),
    clear: () => store.clear(),
    get length() {
      return store.size;
    },
    key: (index: number) => Array.from(store.keys())[index] ?? null
  };
}

export interface RenderFeatureOptions extends Omit<RenderOptions, "wrapper"> {
  network?: StellarNetwork;
  /** Explicit storage fixture. Defaults to a fresh isolated memory storage instance (#155). */
  storage?: Storage;
  notificationStore?: NotificationStore;
}

/**
 * Renders a feature component inside the same providers the real app uses,
 * and returns a bound `userEvent` instance and the isolated storage fixture.
 *
 * Every slice's component tests should go through this helper so provider
 * wiring stays identical between the app and the test suite, while isolating
 * storage state across runs.
 */
export function renderFeature(
  ui: ReactElement,
  { network, storage: providedStorage, notificationStore, ...options }: RenderFeatureOptions = {}
): RenderResult & { user: ReturnType<typeof userEvent.setup>; storage: Storage } {
  const storage = providedStorage ?? createIsolatedStorage();
  const notifStore = notificationStore ?? new NotificationStore(storage);

  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <NotificationProvider store={notifStore}>
        <NetworkProvider initialNetwork={network} storage={storage}>{children}</NetworkProvider>
      </NotificationProvider>
    );
  }

  const user = userEvent.setup();
  return { ...render(ui, { wrapper: Wrapper, ...options }), user, storage };
}

export { resetNetworkStorageListeners };
export * from "@testing-library/react";
export { userEvent };

