import { beforeEach, describe, expect, it } from "vitest";
import { getAuditTrail } from "@/core/audit/audit";
import {
  createMemoryProjectionStore,
  createUpcasterRegistry,
  promoteProjection,
  replayProjection,
  rollbackProjection,
  type EventSource,
  type ProjectionDefinition,
  type ProjectionStore,
  type ReplayDeps,
  type ReplayEvent
} from "../index";

type Balances = Readonly<Record<string, number>>;

const maintainer = { role: "maintainer" as const, userId: "ops-1" };

function event(sequence: number, type: string, version: number, payload: unknown): ReplayEvent {
  return { id: `evt-${sequence}`, sequence, type, version, payload, occurredAt: "2026-10-01T00:00:00.000Z" };
}

/** v1 payments carried a decimal string; v2 carries integer stroops. */
const upcasters = createUpcasterRegistry([
  {
    type: "payment.recorded",
    fromVersion: 1,
    upcast: (payload) => {
      const { account, amount } = payload as { account: string; amount: string };
      if (!/^\d+(\.\d+)?$/.test(amount)) throw new Error(`bad amount ${amount}`);
      return { account, stroops: Math.round(Number(amount) * 10_000_000) };
    }
  }
]);

function balances(version: number, overrides: Partial<ProjectionDefinition<Balances>> = {}): ProjectionDefinition<Balances> {
  return {
    name: "balances",
    version,
    eventVersions: { "account.opened": 1, "payment.recorded": 2 },
    initial: () => ({}),
    apply: (state, e) => {
      if (e.type === "account.opened") return { ...state, [(e.payload as { account: string }).account]: 0 };
      const { account, stroops } = e.payload as { account: string; stroops: number };
      if (!(account in state)) throw new Error(`payment to unknown account ${account}`);
      return { ...state, [account]: state[account] + stroops };
    },
    validate: (state) => Object.entries(state).filter(([, v]) => v < 0).map(([k]) => `negative balance ${k}`),
    ...overrides
  };
}

const log: ReplayEvent[] = [
  event(1, "account.opened", 1, { account: "GA" }),
  event(2, "payment.recorded", 1, { account: "GA", amount: "1.5" }),
  event(4, "audit.noise", 1, {}),
  event(5, "account.opened", 1, { account: "GB" }),
  event(7, "payment.recorded", 2, { account: "GB", stroops: 30 })
];

function memorySource(events: readonly ReplayEvent[], failures: { failNext?: number; reads?: number } = {}): EventSource & { reads: number } {
  const source = {
    reads: 0,
    async read(after: number, limit: number) {
      source.reads += 1;
      if (failures.failNext && failures.failNext > 0) {
        failures.failNext -= 1;
        throw new Error("connection reset");
      }
      return events.filter((e) => e.sequence > after).slice(0, limit);
    }
  };
  return source;
}

function deps(store: ProjectionStore, source: EventSource, auth: ReplayDeps["auth"] = maintainer): ReplayDeps & { sleeps: number[] } {
  const sleeps: number[] = [];
  return {
    source,
    store,
    auth,
    upcasters,
    now: () => Date.parse("2026-10-17T00:00:00.000Z"),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    sleeps
  };
}

function replayAudits() {
  return getAuditTrail()
    .all()
    .filter((e) => e.action.startsWith("projection."));
}

describe("versioned event replay", () => {
  let store: ProjectionStore;

  beforeEach(() => {
    getAuditTrail().reset();
    store = createMemoryProjectionStore();
  });

  describe("normal path", () => {
    it("rebuilds into a versioned slot, upcasts old events and promotes atomically", async () => {
      const result = await replayProjection(balances(1), deps(store, memorySource(log)), { batchSize: 2, promote: true });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toMatchObject({
        status: "promoted",
        fromSequence: 0,
        toSequence: 7,
        eventsRead: 5,
        eventsApplied: 4,
        eventsIgnored: 1,
        eventsUpcast: 1,
        batches: 3,
        retries: 0
      });
      expect(store.getActive("balances")).toEqual({ version: 1, previousVersion: undefined });
      expect(store.getSlot<Balances>("balances", 1)).toMatchObject({
        status: "ready",
        checkpoint: 7,
        state: { GA: 15_000_000, GB: 30 }
      });
      expect(replayAudits()).toHaveLength(1);
      expect(replayAudits()[0]).toMatchObject({ outcome: "allowed", reason: "rebuild", after: { status: "promoted" } });
    });

    it("builds a new version beside the live one without touching it", async () => {
      await replayProjection(balances(1), deps(store, memorySource(log)), { promote: true });
      const live = store.getSlot("balances", 1);

      const result = await replayProjection(balances(2), deps(store, memorySource(log)), { promote: false });

      expect(result.ok && result.value.status).toBe("ready");
      expect(store.getActive("balances")?.version).toBe(1);
      expect(store.getSlot("balances", 1)).toBe(live);

      expect(promoteProjection("balances", 2, deps(store, memorySource([])))).toMatchObject({
        ok: true,
        value: { fromVersion: 1, toVersion: 2 }
      });
      expect(store.getActive("balances")).toEqual({ version: 2, previousVersion: 1 });
    });

    it("dry run returns the state without writing slots, promoting or locking", async () => {
      const result = await replayProjection(balances(1), deps(store, memorySource(log)), { dryRun: true });

      expect(result.ok && result.value.status).toBe("dry_run");
      expect(result.ok && result.value.state).toEqual({ GA: 15_000_000, GB: 30 });
      expect(store.getSlot("balances", 1)).toBeUndefined();
      expect(store.getActive("balances")).toBeUndefined();
      expect(replayAudits()[0]).toMatchObject({ reason: "dry_run" });
    });

    it("stops at untilSequence for a point-in-time rebuild", async () => {
      const result = await replayProjection(balances(1), deps(store, memorySource(log)), { untilSequence: 4 });

      expect(result.ok && result.value.toSequence).toBe(4);
      expect(store.getSlot<Balances>("balances", 1)?.state).toEqual({ GA: 15_000_000 });
    });

    it("catches up the live version in a single commit", async () => {
      const events = [...log];
      await replayProjection(balances(1), deps(store, memorySource(events)), { promote: true });
      events.push(event(9, "payment.recorded", 2, { account: "GA", stroops: 5 }));

      const result = await replayProjection(balances(1), deps(store, memorySource(events)), { mode: "resume" });

      expect(result.ok && result.value).toMatchObject({ fromSequence: 7, toSequence: 9, eventsApplied: 1 });
      expect(store.getSlot<Balances>("balances", 1)).toMatchObject({ status: "ready", state: { GA: 15_000_005 } });
      expect(store.getActive("balances")?.version).toBe(1);
    });
  });

  describe("failure paths", () => {
    it("halts on a poison event, keeps the last good checkpoint and resumes after a fix", async () => {
      const poisoned = [...log.slice(0, 2), event(3, "payment.recorded", 2, { account: "GZ", stroops: 1 }), ...log.slice(2)];
      const failed = await replayProjection(balances(1), deps(store, memorySource(poisoned)), { promote: true });

      expect(failed).toMatchObject({ ok: false, code: "poison_event", detail: { checkpoint: 2, sequence: 3, eventId: "evt-3" } });
      expect(store.getSlot("balances", 1)).toMatchObject({ status: "failed", checkpoint: 2 });
      expect(store.getActive("balances")).toBeUndefined();
      expect(replayAudits()[0]).toMatchObject({ errorCode: "poison_event", after: { status: "failed" } });

      // Forward fix: the projection now tolerates unknown accounts.
      const tolerant = balances(1, {
        apply: (state, e) => {
          if (e.type === "account.opened") return { ...state, [(e.payload as { account: string }).account]: 0 };
          const { account, stroops } = e.payload as { account: string; stroops: number };
          return { ...state, [account]: (state[account] ?? 0) + stroops };
        }
      });
      const resumed = await replayProjection(tolerant, deps(store, memorySource(poisoned)), { mode: "resume", promote: true });

      expect(resumed.ok && resumed.value).toMatchObject({ fromSequence: 2, toSequence: 7, status: "promoted" });
      expect(store.getSlot<Balances>("balances", 1)?.state).toEqual({ GA: 15_000_000, GZ: 1, GB: 30 });
    });

    it("skips poison events up to maxSkipped, then fails", async () => {
      const poisoned = [...log, event(8, "payment.recorded", 1, { account: "GA", amount: "NaN" })];

      const skipped = await replayProjection(balances(1), deps(store, memorySource(poisoned)), {
        poisonPolicy: "skip",
        maxSkipped: 1
      });
      expect(skipped.ok && skipped.value.skipped).toEqual([
        { eventId: "evt-8", sequence: 8, reason: expect.stringContaining("bad amount") }
      ]);

      const strict = await replayProjection(balances(2), deps(store, memorySource(poisoned)), {
        poisonPolicy: "skip",
        maxSkipped: 0
      });
      expect(strict).toMatchObject({ ok: false, code: "too_many_skipped", detail: { checkpoint: 7 } });
    });

    it("never skips an event with no upcaster path: that is a deploy gap", async () => {
      const future = [...log, event(8, "payment.recorded", 3, { account: "GA", stroops: 1 })];

      const result = await replayProjection(balances(1), deps(store, memorySource(future)), { poisonPolicy: "skip", maxSkipped: 10 });

      expect(result).toMatchObject({ ok: false, code: "unsupported_event_version", detail: { sequence: 8 } });
    });

    it("rejects out-of-order or duplicate sequences from the source", async () => {
      const broken = [log[0], log[1], { ...log[1], id: "evt-dup" }];
      const source: EventSource = { read: async (after) => (after === 0 ? broken : []) };

      const result = await replayProjection(balances(1), deps(store, source));

      expect(result).toMatchObject({ ok: false, code: "sequence_out_of_order", detail: { eventId: "evt-dup", checkpoint: 2 } });
    });

    it("refuses to promote a build that fails validation", async () => {
      const negative = [...log, event(8, "payment.recorded", 2, { account: "GB", stroops: -100 })];

      const result = await replayProjection(balances(1), deps(store, memorySource(negative)), { promote: true });

      expect(result).toMatchObject({ ok: false, code: "validation_failed", detail: { violations: ["negative balance GB"] } });
      expect(store.getActive("balances")).toBeUndefined();
      expect(store.getSlot("balances", 1)?.status).toBe("failed");
    });

    it("leaves the live slot untouched when a catch-up fails", async () => {
      const events = [...log];
      await replayProjection(balances(1), deps(store, memorySource(events)), { promote: true });
      const live = store.getSlot("balances", 1);
      events.push(event(9, "payment.recorded", 2, { account: "GB", stroops: -100 }));

      const result = await replayProjection(balances(1), deps(store, memorySource(events)), { mode: "resume" });

      expect(result).toMatchObject({ ok: false, code: "validation_failed" });
      expect(store.getSlot("balances", 1)).toBe(live);
    });

    it("refuses to rebuild over the live version", async () => {
      await replayProjection(balances(1), deps(store, memorySource(log)), { promote: true });

      expect(await replayProjection(balances(1), deps(store, memorySource(log)))).toMatchObject({ ok: false, code: "version_active" });
    });

    it("refuses to resume a version that was never built", async () => {
      expect(await replayProjection(balances(1), deps(store, memorySource(log)), { mode: "resume" })).toMatchObject({
        ok: false,
        code: "nothing_to_resume"
      });
    });

    it("rejects concurrent replays of the same projection until the lock expires", async () => {
      let now = 0;
      const d = { ...deps(store, memorySource(log)), now: () => now };
      expect(store.acquireLock("balances", "crashed-run", 0, 1000)).toBe(true);

      expect(await replayProjection(balances(1), d, { lockTtlMs: 1000 })).toMatchObject({ ok: false, code: "replay_in_progress" });

      now = 1001;
      expect((await replayProjection(balances(1), d, { lockTtlMs: 1000 })).ok).toBe(true);
      // The lock is released afterwards.
      expect(store.acquireLock("balances", "next", now, 1000)).toBe(true);
    });

    it("validates options before doing any work", async () => {
      const source = memorySource(log);
      for (const options of [{ batchSize: 0 }, { maxRetries: -1 }, { maxRetries: 99 }, { dryRun: true, promote: true }, { untilSequence: 1.5 }]) {
        expect(await replayProjection(balances(1), deps(store, source), options)).toMatchObject({ ok: false, code: "invalid_options" });
      }
      expect(source.reads).toBe(0);
    });
  });

  describe("retry path", () => {
    it("retries transient source failures with exponential backoff", async () => {
      const source = memorySource(log, { failNext: 2 });
      const d = deps(store, source);

      const result = await replayProjection(balances(1), d, { retryDelayMs: 100, maxRetries: 3 });

      expect(result.ok && result.value.retries).toBe(2);
      expect(d.sleeps).toEqual([100, 200]);
      expect(store.getSlot("balances", 1)?.status).toBe("ready");
    });

    it("gives up after maxRetries and keeps the checkpoint for a later resume", async () => {
      const failures = { failNext: 0 };
      const source = memorySource(log, failures);
      const d = deps(store, source);
      // First batch succeeds, then the source goes down.
      const original = source.read;
      let calls = 0;
      source.read = async (after, limit) => {
        calls += 1;
        if (calls > 1) failures.failNext = 1;
        return original(after, limit);
      };

      const failed = await replayProjection(balances(1), d, { batchSize: 2, maxRetries: 2, retryDelayMs: 10 });

      expect(failed).toMatchObject({ ok: false, code: "source_unavailable", detail: { checkpoint: 2, retries: 2 } });
      expect(d.sleeps).toEqual([10, 20]);
      expect(store.getSlot("balances", 1)).toMatchObject({ status: "failed", checkpoint: 2 });

      const resumed = await replayProjection(balances(1), deps(store, memorySource(log)), { mode: "resume", promote: true });
      expect(resumed.ok && resumed.value).toMatchObject({ fromSequence: 2, toSequence: 7, status: "promoted" });
      expect(store.getSlot<Balances>("balances", 1)?.state).toEqual({ GA: 15_000_000, GB: 30 });
    });
  });

  describe("authorization path", () => {
    it.each(["viewer", "service"] as const)("denies a %s and records the refusal", async (role) => {
      const source = memorySource(log);

      const result = await replayProjection(balances(1), deps(store, source, { role, userId: "u-1" }), { promote: true });

      expect(result).toMatchObject({ ok: false, code: "replay_unauthorized" });
      expect(source.reads).toBe(0);
      expect(store.getSlot("balances", 1)).toBeUndefined();
      expect(replayAudits()[0]).toMatchObject({ outcome: "denied", errorCode: "replay_unauthorized" });
    });

    it("denies promote and rollback to non-maintainers", async () => {
      await replayProjection(balances(1), deps(store, memorySource(log)), { promote: true });
      await replayProjection(balances(2), deps(store, memorySource(log)), { promote: true });
      const viewer = deps(store, memorySource([]), { role: "viewer" });

      expect(rollbackProjection("balances", viewer)).toMatchObject({ ok: false, code: "replay_unauthorized" });
      expect(promoteProjection("balances", 1, viewer)).toMatchObject({ ok: false, code: "replay_unauthorized" });
      expect(store.getActive("balances")?.version).toBe(2);
    });
  });

  describe("rollback", () => {
    it("swaps back to the previous ready version, and a second rollback rolls forward", async () => {
      await replayProjection(balances(1), deps(store, memorySource(log)), { promote: true });
      await replayProjection(balances(2), deps(store, memorySource(log)), { promote: true });
      const d = deps(store, memorySource([]));

      expect(rollbackProjection("balances", d)).toMatchObject({ ok: true, value: { fromVersion: 2, toVersion: 1, checkpoint: 7 } });
      expect(store.getActive("balances")).toEqual({ version: 1, previousVersion: 2 });
      expect(rollbackProjection("balances", d)).toMatchObject({ ok: true, value: { toVersion: 2 } });
      expect(replayAudits().filter((e) => e.action === "projection.activated")).toHaveLength(2);
    });

    it("refuses when there is no previous version or it is not ready", async () => {
      const d = deps(store, memorySource(log));
      expect(rollbackProjection("balances", d)).toMatchObject({ ok: false, code: "no_previous_version" });

      await replayProjection(balances(1), d, { promote: true });
      expect(rollbackProjection("balances", d)).toMatchObject({ ok: false, code: "no_previous_version" });

      await replayProjection(balances(2), deps(store, memorySource([...log, event(8, "x", 1, {})])), { untilSequence: 2 });
      store.putSlot({ ...store.getSlot("balances", 2)!, status: "failed" });
      expect(promoteProjection("balances", 2, d)).toMatchObject({ ok: false, code: "no_previous_version" });
      expect(store.getActive("balances")?.version).toBe(1);
    });
  });

  describe("upcaster registry", () => {
    it("rejects duplicate steps and events newer than the target", () => {
      expect(() =>
        createUpcasterRegistry([
          { type: "a", fromVersion: 1, upcast: (p) => p },
          { type: "a", fromVersion: 1, upcast: (p) => p }
        ])
      ).toThrow(/Duplicate/);
      expect(upcasters.upcast(event(1, "payment.recorded", 3, {}), 2)).toMatchObject({ ok: false, code: "unsupported_event_version" });
    });
  });
});
