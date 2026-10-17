/**
 * In-memory ProjectionStore. The reference implementation for tests and the
 * CLI; a durable adapter must keep the same per-method atomicity.
 */

import type { ActivePointer, ProjectionSlot, ProjectionStore } from "./types";

function slotKey(name: string, version: number): string {
  return `${name}@v${version}`;
}

export function createMemoryProjectionStore(): ProjectionStore {
  const slots = new Map<string, ProjectionSlot>();
  const active = new Map<string, ActivePointer>();
  const locks = new Map<string, { owner: string; expiresAt: number }>();

  return {
    getSlot<S>(name: string, version: number) {
      return slots.get(slotKey(name, version)) as ProjectionSlot<S> | undefined;
    },
    putSlot<S>(slot: ProjectionSlot<S>) {
      slots.set(slotKey(slot.name, slot.version), slot as ProjectionSlot);
    },
    getActive(name) {
      return active.get(name);
    },
    setActive(name, pointer) {
      active.set(name, pointer);
    },
    acquireLock(name, owner, now, ttlMs) {
      const held = locks.get(name);
      if (held && held.owner !== owner && held.expiresAt > now) return false;
      locks.set(name, { owner, expiresAt: now + ttlMs });
      return true;
    },
    releaseLock(name, owner) {
      if (locks.get(name)?.owner === owner) locks.delete(name);
    }
  };
}
