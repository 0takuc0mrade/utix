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
import {
  createDeterministicClock,
  createReplayEvent,
  deferred,
  makeSeededPlacementPlan,
  makeSeededWritePlan,
  mulberry32,
  ScriptedEventLog
} from "./deterministicHarness";

type Balances = Readonly<Record<string, number>>;

const maintainer = { role: "maintainer" as const, userId: "ops-1" };
const viewer = { role: "viewer" as const, userId: "viewer-1" };
const service = { role: "service" as const, userId: "service-1" };

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

/**
 * The test projection. `applied` records the exact event order the reducer saw,
 * so a test can prove a concurrent writer never caused a duplicate or a gap.
 */
function balances(version: number, applied?: string[]): ProjectionDefinition<Balances> {
  return {
    name: "balances",
    version,
    eventVersions: { "account.opened": 1, "payment.recorded": 2 },
    initial: () => ({}),
    apply: (state, event) => {
      applied?.push(event.id);
      if (event.type === "account.opened") {
        return { ...state, [(event.payload as { account: string }).account]: 0 };
      }
      const { account, stroops } = event.payload as { account: string; stroops: number };
      if (!(account in state)) throw new Error(`payment to unknown account ${account}`);
      return { ...state, [account]: state[account] + stroops };
    },
    validate: (state) => Object.entries(state).filter(([, value]) => value < 0).map(([key]) => `negative balance ${key}`)
  };
}

/** The same reducer, but a payment may open an unknown account (forward fix). */
function tolerantBalances(version: number, applied?: string[]): ProjectionDefinition<Balances> {
  return {
    ...balances(version, applied),
    apply: (state, event) => {
      applied?.push(event.id);
      if (event.type === "account.opened") {
        return { ...state, [(event.payload as { account: string }).account]: 0 };
      }
      const { account, stroops } = event.payload as { account: string; stroops: number };
      return { ...state, [account]: (state[account] ?? 0) + stroops };
    }
  };
}

/** A second projection with no events in common, for the lock-scope test. */
function openedAccounts(version: number): ProjectionDefinition<string[]> {
  return {
    name: "opened-accounts",
    version,
    eventVersions: { "account.opened": 1 },
    initial: () => [],
    apply: (state, event) => [...state, (event.payload as { account: string }).account]
  };
}

const baseLog: readonly ReplayEvent[] = [
  createReplayEvent(1, "account.opened", 1, { account: "GA" }),
  createReplayEvent(2, "payment.recorded", 1, { account: "GA", amount: "1.5" }),
  createReplayEvent(4, "audit.noise", 1, {}),
  createReplayEvent(5, "account.opened", 1, { account: "GB" }),
  createReplayEvent(7, "payment.recorded", 2, { account: "GB", stroops: 30 })
];

/** Serial fold of the same log, used as the expected result of a replay. */
function expectedBalances(events: readonly ReplayEvent[], options: { tolerant?: boolean } = {}): Balances {
  const state: Record<string, number> = {};
  for (const event of events) {
    if (event.type === "account.opened") {
      state[(event.payload as { account: string }).account] = 0;
      continue;
    }
    if (event.type !== "payment.recorded") continue;
    const payload = event.payload as { account: string; stroops?: number; amount?: string };
    const stroops = payload.stroops ?? Math.round(Number(payload.amount) * 10_000_000);
    if (!(payload.account in state)) {
      if (!options.tolerant) throw new Error(`serial fold saw a payment to ${payload.account} before it opened`);
      state[payload.account] = 0;
    }
    state[payload.account] += stroops;
  }
  return state;
}

function deps(
  store: ProjectionStore,
  source: EventSource,
  clock: ReturnType<typeof createDeterministicClock>,
  auth: ReplayDeps["auth"] = maintainer
): ReplayDeps & { sleeps: number[] } {
  const sleeps: number[] = [];
  return {
    source,
    store,
    auth,
    upcasters,
    now: clock.now,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    sleeps
  };
}

function replayAudits() {
  return getAuditTrail()
    .all()
    .filter((event) => event.action.startsWith("projection."));
}

/** Deterministic failure windows; a retry consumes the next read index. */
function makeSeededFailures(seed: number, readCount: number): Record<number, number> {
  const random = mulberry32(seed);
  const failures: Record<number, number> = {};
  for (let index = 0; index < readCount; index += 1) {
    if (random() < 0.45) failures[index] = 1 + Math.floor(random() * 2);
  }
  return failures;
}

describe("deterministic replay under concurrent writes and retries", () => {
  let store: ProjectionStore;

  beforeEach(() => {
    getAuditTrail().reset();
    store = createMemoryProjectionStore();
  });

  describe("concurrent writes", () => {
    it("folds writes appended while the source read is in flight, then promotes once at the head", async () => {
      const clock = createDeterministicClock(0);
      const applied: string[] = [];
      const log = new ScriptedEventLog(baseLog, {
        appendPlan: {
          0: [createReplayEvent(3, "payment.recorded", 2, { account: "GA", stroops: 5 })],
          1: [createReplayEvent(6, "payment.recorded", 2, { account: "GB", stroops: 1 })],
          2: [createReplayEvent(8, "account.opened", 1, { account: "GC" })]
        }
      });

      const result = await replayProjection(balances(1, applied), deps(store, log, clock), {
        batchSize: 2,
        promote: true,
        runId: "run-238-concurrent-writes"
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toMatchObject({
        status: "promoted",
        fromSequence: 0,
        toSequence: 8,
        batches: 4,
        eventsRead: 8,
        eventsApplied: 7,
        eventsIgnored: 1,
        eventsUpcast: 1,
        retries: 0
      });
      // Every read saw the writes that landed before it, and the run stopped
      // only after an empty batch at the live head.
      expect(log.reads.map((read) => read.returned)).toEqual([[1, 2], [3, 4], [5, 6], [7, 8], []]);
      expect(log.appended.map((event) => event.sequence)).toEqual([3, 6, 8]);
      // No event was applied twice, and none was skipped.
      expect(applied).toEqual(["evt-1", "evt-2", "evt-3", "evt-5", "evt-6", "evt-7", "evt-8"]);
      expect(new Set(applied).size).toBe(applied.length);
      expect(store.getSlot<Balances>("balances", 1)?.state).toEqual({
        GA: 15_000_005,
        GB: 31,
        GC: 0
      });
      expect(store.getActive("balances")).toEqual({ version: 1, previousVersion: undefined });
    });

    it("does not read past untilSequence when a writer appends during the snapshot", async () => {
      const clock = createDeterministicClock(0);
      const log = new ScriptedEventLog(baseLog, {
        appendPlan: {
          0: [createReplayEvent(3, "payment.recorded", 2, { account: "GA", stroops: 99 })]
        }
      });

      const result = await replayProjection(balances(1), deps(store, log, clock), {
        batchSize: 2,
        untilSequence: 2,
        promote: true
      });

      expect(result.ok && result.value).toMatchObject({ status: "promoted", toSequence: 2, eventsRead: 2 });
      expect(log.reads.at(-1)?.returned).toEqual([1, 2]);
      expect(store.getSlot<Balances>("balances", 1)?.state).toEqual({ GA: 15_000_000 });
      // The concurrent write exists in the log but is not part of this snapshot.
      expect(log.appended.map((event) => event.sequence)).toEqual([3]);
      expect(log.head()).toBe(7);
    });

    it("produces the same trace for the same seed and converges for every seed", async () => {
      const traces: string[] = [];
      // The same six writes land in different read windows per seed.
      const scheduled = [
        createReplayEvent(8, "payment.recorded", 2, { account: "GA", stroops: 5 }),
        createReplayEvent(9, "payment.recorded", 2, { account: "GB", stroops: 1 }),
        createReplayEvent(10, "account.opened", 1, { account: "GC" }),
        createReplayEvent(11, "payment.recorded", 2, { account: "GC", stroops: 2 }),
        createReplayEvent(12, "payment.recorded", 2, { account: "GA", stroops: 3 }),
        createReplayEvent(13, "payment.recorded", 2, { account: "GB", stroops: 4 })
      ] satisfies ReplayEvent[];

      for (const seed of [1, 2, 3, 4, 5, 6]) {
        const placement = makeSeededPlacementPlan(seed, scheduled, 5);
        const log = new ScriptedEventLog(baseLog, { appendPlan: placement });
        const applied: string[] = [];

        const result = await replayProjection(balances(1, applied), deps(store, log, createDeterministicClock(0)), {
          batchSize: 3,
          promote: true,
          runId: `seed-${seed}`
        });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const state = store.getSlot<Balances>("balances", 1)?.state;
        expect(result.value.toSequence).toBe(log.head());
        expect(state).toEqual(expectedBalances([...baseLog, ...scheduled]));
        expect(new Set(applied).size).toBe(applied.length);
        traces.push(JSON.stringify({ reads: log.reads, state }));
        store = createMemoryProjectionStore();
        getAuditTrail().reset();
      }

      // Every seed ends in the same converged state; the interleavings differ.
      expect(new Set(traces.map((trace) => JSON.stringify(JSON.parse(trace).state))).size).toBe(1);
      expect(new Set(traces).size).toBeGreaterThan(1);

      // Replaying the same scenario with the same seed is byte-identical.
      const runOnce = async () => {
        const log = new ScriptedEventLog(baseLog, {
          appendPlan: makeSeededWritePlan(42, baseLog.at(-1)!.sequence, 5, ["GA", "GB"]).appendPlan,
          failures: makeSeededFailures(42, 6)
        });
        const applied: string[] = [];
        const runDeps = deps(store, log, createDeterministicClock(0));
        const result = await replayProjection(balances(1, applied), runDeps, {
          batchSize: 2,
          maxRetries: 3,
          retryDelayMs: 10,
          promote: true,
          runId: "seed-42"
        });
        return { result, reads: log.reads, sleeps: runDeps.sleeps, applied, slot: store.getSlot<Balances>("balances", 1) };
      };

      store = createMemoryProjectionStore();
      getAuditTrail().reset();
      const first = await runOnce();
      store = createMemoryProjectionStore();
      getAuditTrail().reset();
      const second = await runOnce();

      expect(first.result.ok).toBe(true);
      expect(second.result.ok).toBe(true);
      expect(second.result).toEqual(first.result);
      expect(second.reads).toEqual(first.reads);
      expect(second.sleeps).toEqual(first.sleeps);
      expect(second.applied).toEqual(first.applied);
      expect(second.slot).toEqual(first.slot);
    });
  });

  describe("concurrent replay runs and lock ownership", () => {
    it("lets exactly one simultaneous rebuild of a projection run", async () => {
      const clock = createDeterministicClock(0);
      const source = new ScriptedEventLog(baseLog);
      const firstApplied: string[] = [];
      const secondApplied: string[] = [];

      const first = replayProjection(balances(1, firstApplied), deps(store, source, clock), {
        batchSize: 2,
        promote: true,
        runId: "first-run"
      });
      const second = replayProjection(balances(1, secondApplied), deps(store, source, clock), {
        batchSize: 2,
        promote: true,
        runId: "second-run"
      });

      const [winner, loser] = await Promise.all([first, second]);

      expect(winner.ok).toBe(true);
      expect(loser).toMatchObject({
        ok: false,
        code: "replay_in_progress",
        detail: { checkpoint: 0, retries: 0 }
      });
      expect(secondApplied).toEqual([]);
      expect(source.reads.every((read) => !read.failed)).toBe(true);
      expect(store.getSlot<Balances>("balances", 1)).toMatchObject({ status: "ready", checkpoint: 7 });
      expect(replayAudits().filter((event) => event.errorCode === "replay_in_progress")).toHaveLength(1);

      // The loser's key is free again once the winner releases the lock.
      const resumed = await replayProjection(balances(1, secondApplied), deps(store, source, clock), {
        mode: "resume",
        batchSize: 2,
        runId: "second-run-retry"
      });
      expect(resumed.ok && resumed.value).toMatchObject({ fromSequence: 7, toSequence: 7 });
    });

    it("keeps retries and their backoff inside the lock", async () => {
      const clock = createDeterministicClock(0);
      const source = new ScriptedEventLog(baseLog, { failures: { 0: 1 } });
      const competingSource = new ScriptedEventLog(baseLog);
      const runDeps = deps(store, source, clock);
      let competitor: Awaited<ReturnType<typeof replayProjection>> | undefined;

      runDeps.sleep = async (ms) => {
        runDeps.sleeps.push(ms);
        competitor = await replayProjection(balances(1), deps(store, competingSource, clock), {
          batchSize: 2,
          runId: "competitor"
        });
      };

      const result = await replayProjection(balances(1), runDeps, {
        batchSize: 2,
        maxRetries: 2,
        retryDelayMs: 100,
        promote: true,
        runId: "retrying-run"
      });

      expect(result.ok && result.value).toMatchObject({ status: "promoted", retries: 1 });
      expect(runDeps.sleeps).toEqual([100]);
      expect(competitor).toMatchObject({ ok: false, code: "replay_in_progress" });
      expect(competingSource.readCount).toBe(0);
    });

    it("stops a run that lost its lock without overwriting the new owner's slot", async () => {
      const clock = createDeterministicClock(0);
      const bStarted = deferred<void>();
      const releaseB = deferred<void>();
      const bLog = new ScriptedEventLog(baseLog);
      let bFirstRead = true;
      const bSource: EventSource = {
        async read(after, limit) {
          if (bFirstRead) {
            bFirstRead = false;
            bStarted.resolve(undefined);
            await releaseB.promise;
          }
          return bLog.read(after, limit);
        }
      };
      const bDeps = deps(store, bSource, clock);
      let bRun: Promise<Awaited<ReturnType<typeof replayProjection>>> | undefined;

      const aLog = new ScriptedEventLog(baseLog, {
        beforeRead: async (index) => {
          if (index !== 0) return;
          // A's first lock was taken at t=0 with a 1s TTL. By the time its read
          // returns, the lock has expired and B takes it.
          clock.set(2000);
          bRun = replayProjection(balances(1), bDeps, {
            batchSize: 2,
            promote: true,
            lockTtlMs: 1000,
            runId: "new-owner"
          });
          await bStarted.promise;
        }
      });

      const lost = await replayProjection(balances(1), deps(store, aLog, clock), {
        batchSize: 2,
        promote: true,
        lockTtlMs: 1000,
        runId: "stale-owner"
      });

      expect(lost).toMatchObject({
        ok: false,
        code: "replay_in_progress",
        // The batch A applied in memory was never committed; B owns a slot at 0.
        detail: { checkpoint: 0, retries: 0 }
      });
      expect(!lost.ok && lost.detail?.message).toContain("lost the replay lock");
      // B owns the slot now; the stale run did not write a `failed` slot over it.
      expect(store.getSlot<Balances>("balances", 1)).toMatchObject({
        status: "building",
        checkpoint: 0,
        eventsApplied: 0,
        state: {}
      });
      expect(store.getActive("balances")).toBeUndefined();

      releaseB.resolve(undefined);
      const owner = await bRun!;
      expect(owner.ok && owner.value.status).toBe("promoted");
      expect(store.getSlot<Balances>("balances", 1)?.state).toEqual(expectedBalances(baseLog));
      expect(store.getActive("balances")?.version).toBe(1);
    });

    it("runs different projections concurrently because the lock is per projection", async () => {
      const clock = createDeterministicClock(0);
      const firstSource = new ScriptedEventLog(baseLog);
      const secondSource = new ScriptedEventLog(baseLog);

      const [balancesRun, accountsRun] = await Promise.all([
        replayProjection(balances(1), deps(store, firstSource, clock), { batchSize: 2, promote: true, runId: "balances-run" }),
        replayProjection(openedAccounts(1), deps(store, secondSource, clock), {
          batchSize: 2,
          promote: true,
          runId: "accounts-run"
        })
      ]);

      expect(balancesRun.ok && balancesRun.value.status).toBe("promoted");
      expect(accountsRun.ok && accountsRun.value.status).toBe("promoted");
      expect(store.getActive("balances")?.version).toBe(1);
      expect(store.getActive("opened-accounts")?.version).toBe(1);
      expect(store.getSlot<string[]>("opened-accounts", 1)?.state).toEqual(["GA", "GB"]);
    });
  });

  describe("failure paths with concurrent writes", () => {
    it("resumes a poison halt from its checkpoint and picks up writes appended after the halt", async () => {
      const clock = createDeterministicClock(0);
      const poison = createReplayEvent(3, "payment.recorded", 2, { account: "GZ", stroops: 1 });
      const log = new ScriptedEventLog([...baseLog, poison], {
        appendPlan: {
          1: [createReplayEvent(8, "payment.recorded", 2, { account: "GB", stroops: 5 })]
        }
      });
      const firstApplied: string[] = [];

      const failed = await replayProjection(balances(1, firstApplied), deps(store, log, clock), {
        batchSize: 2,
        promote: true,
        runId: "poison-run"
      });

      expect(failed).toMatchObject({
        ok: false,
        code: "poison_event",
        detail: { checkpoint: 2, sequence: 3, eventId: "evt-3" }
      });
      expect(store.getSlot("balances", 1)).toMatchObject({ status: "failed", checkpoint: 2 });
      expect(store.getActive("balances")).toBeUndefined();
      // The writer appended while the failing read was in flight.
      expect(log.head()).toBe(8);

      const resumedApplied: string[] = [];
      const resumeLog = new ScriptedEventLog(log.snapshot());
      const resumed = await replayProjection(tolerantBalances(1, resumedApplied), deps(store, resumeLog, clock), {
        mode: "resume",
        batchSize: 2,
        promote: true,
        runId: "poison-resume"
      });

      expect(resumed.ok && resumed.value).toMatchObject({ fromSequence: 2, toSequence: 8, status: "promoted" });
      expect(resumedApplied).not.toContain("evt-1");
      expect(resumedApplied).not.toContain("evt-2");
      expect(store.getSlot<Balances>("balances", 1)?.state).toEqual(
        expectedBalances(log.snapshot(), { tolerant: true })
      );
      expect(store.getActive("balances")?.version).toBe(1);
    });

    it("rejects a duplicate sequence from a racing source and leaves the slot unpromoted", async () => {
      const clock = createDeterministicClock(0);
      const log = new ScriptedEventLog(baseLog, {
        mapBatch: (batch, index) => (index === 1 ? [{ ...batch[0], id: "evt-dup", sequence: 2 }] : batch)
      });

      const result = await replayProjection(balances(1), deps(store, log, clock), {
        batchSize: 3,
        promote: true
      });

      expect(result).toMatchObject({
        ok: false,
        code: "sequence_out_of_order",
        detail: { eventId: "evt-dup", sequence: 2, checkpoint: 4 }
      });
      expect(store.getSlot("balances", 1)).toMatchObject({ status: "failed", checkpoint: 4 });
      expect(store.getActive("balances")).toBeUndefined();
    });

    it("keeps the live slot untouched when a catch-up fails while writes are appended", async () => {
      const clock = createDeterministicClock(0);
      const initial = new ScriptedEventLog(baseLog);
      await replayProjection(balances(1), deps(store, initial, clock), { batchSize: 2, promote: true });
      const live = store.getSlot<Balances>("balances", 1);

      const log = new ScriptedEventLog([
        ...baseLog,
        createReplayEvent(8, "payment.recorded", 2, { account: "GB", stroops: -100 }),
        createReplayEvent(9, "payment.recorded", 2, { account: "GA", stroops: 5 })
      ]);

      const result = await replayProjection(balances(1), deps(store, log, clock), {
        mode: "resume",
        batchSize: 2,
        runId: "live-catch-up"
      });

      expect(result).toMatchObject({ ok: false, code: "validation_failed" });
      expect(store.getSlot("balances", 1)).toBe(live);
      expect(store.getActive("balances")?.version).toBe(1);
    });
  });

  describe("retry paths", () => {
    it("exhausts retries at a batch boundary, then a concurrent resume converges from the checkpoint", async () => {
      const clock = createDeterministicClock(0);
      const log = new ScriptedEventLog(baseLog, {
        appendPlan: {
          1: [createReplayEvent(8, "payment.recorded", 2, { account: "GA", stroops: 5 })],
          2: [createReplayEvent(9, "payment.recorded", 2, { account: "GB", stroops: 1 })]
        },
        failures: { 1: 1, 2: 1, 3: 1 }
      });
      const runDeps = deps(store, log, clock);

      const failed = await replayProjection(balances(1), runDeps, {
        batchSize: 2,
        maxRetries: 2,
        retryDelayMs: 10,
        promote: true,
        runId: "exhausted-run"
      });

      expect(failed).toMatchObject({
        ok: false,
        code: "source_unavailable",
        detail: { checkpoint: 2, retries: 2 }
      });
      expect(runDeps.sleeps).toEqual([10, 20]);
      expect(store.getSlot("balances", 1)).toMatchObject({ status: "failed", checkpoint: 2 });
      expect(store.getActive("balances")).toBeUndefined();
      expect(log.head()).toBe(9);

      const resumeLog = new ScriptedEventLog(log.snapshot());
      const resumed = await replayProjection(balances(1), deps(store, resumeLog, clock), {
        mode: "resume",
        batchSize: 2,
        promote: true,
        runId: "resume-after-retries"
      });

      expect(resumeLog.reads[0].after).toBe(2);

      expect(resumed.ok && resumed.value).toMatchObject({ fromSequence: 2, toSequence: 9, status: "promoted" });
      expect(store.getSlot<Balances>("balances", 1)?.state).toEqual(expectedBalances(log.snapshot()));
    });

    it("matches the retry schedule across repeated seeded runs", async () => {
      const scenarios = [7, 11].map((seed) => {
        const plan = makeSeededWritePlan(seed, baseLog.at(-1)!.sequence, 6, ["GA", "GB"]);
        const failures = makeSeededFailures(seed, 8);
        return { seed, plan, failures };
      });

      for (const scenario of scenarios) {
        const run = async () => {
          store = createMemoryProjectionStore();
          getAuditTrail().reset();
          const log = new ScriptedEventLog(baseLog, {
            appendPlan: scenario.plan.appendPlan,
            failures: scenario.failures
          });
          const runDeps = deps(store, log, createDeterministicClock(0));
          const result = await replayProjection(balances(1), runDeps, {
            batchSize: 2,
            maxRetries: 3,
            retryDelayMs: 25,
            promote: true,
            runId: `retry-seed-${scenario.seed}`
          });
          return {
            result,
            reads: log.reads,
            sleeps: runDeps.sleeps,
            slot: store.getSlot<Balances>("balances", 1),
            snapshot: log.snapshot()
          };
        };

        const first = await run();
        const second = await run();

        expect(first.result.ok).toBe(true);
        expect(first.result.ok && first.result.value.retries).toBeGreaterThan(0);
        expect(second.result).toEqual(first.result);
        expect(second.reads).toEqual(first.reads);
        expect(second.sleeps).toEqual(first.sleeps);
        expect(second.slot).toEqual(first.slot);
        expect(first.slot?.state).toEqual(expectedBalances(first.snapshot));
      }
    });
  });

  describe("authorization paths", () => {
    it.each(["viewer", "service"] as const)("denies a concurrent %s run without taking the lock", async (role) => {
      const clock = createDeterministicClock(0);
      const deniedSource = new ScriptedEventLog(baseLog);
      const allowedSource = new ScriptedEventLog(baseLog);
      const deniedAuth = role === "viewer" ? viewer : service;

      const [denied, allowed] = await Promise.all([
        replayProjection(balances(1), deps(store, deniedSource, clock, deniedAuth), {
          batchSize: 2,
          promote: true,
          runId: `denied-${role}`
        }),
        replayProjection(balances(1), deps(store, allowedSource, clock), {
          batchSize: 2,
          promote: true,
          runId: `allowed-over-${role}`
        })
      ]);

      expect(denied).toMatchObject({ ok: false, code: "replay_unauthorized" });
      expect(deniedSource.readCount).toBe(0);
      expect(allowed.ok && allowed.value.status).toBe("promoted");
      expect(store.getActive("balances")?.version).toBe(1);
      expect(replayAudits().some((event) => event.outcome === "denied" && event.errorCode === "replay_unauthorized")).toBe(true);
    });

    it("does not let a denied rollback race an authorized promotion", async () => {
      const clock = createDeterministicClock(0);
      await replayProjection(balances(1), deps(store, new ScriptedEventLog(baseLog), clock), {
        batchSize: 2,
        promote: true
      });
      await replayProjection(balances(2), deps(store, new ScriptedEventLog(baseLog), clock), {
        batchSize: 2,
        promote: true
      });
      expect(store.getActive("balances")).toEqual({ version: 2, previousVersion: 1 });

      const [denied, promoted] = await Promise.all([
        Promise.resolve(rollbackProjection("balances", deps(store, new ScriptedEventLog(baseLog), clock, viewer))),
        Promise.resolve(promoteProjection("balances", 1, deps(store, new ScriptedEventLog(baseLog), clock)))
      ]);

      expect(denied).toMatchObject({ ok: false, code: "replay_unauthorized" });
      expect(promoted).toMatchObject({ ok: true, value: { fromVersion: 2, toVersion: 1 } });
      expect(store.getActive("balances")).toEqual({ version: 1, previousVersion: 2 });
    });
  });

  describe("rollback and recovery", () => {
    it("rolls back, then resumes the restored slot over writes appended after the rollback", async () => {
      const clock = createDeterministicClock(0);
      const later = [
        createReplayEvent(8, "payment.recorded", 2, { account: "GA", stroops: 5 }),
        createReplayEvent(9, "payment.recorded", 2, { account: "GB", stroops: 1 }),
        createReplayEvent(10, "account.opened", 1, { account: "GC" }),
        createReplayEvent(11, "payment.recorded", 2, { account: "GC", stroops: 2 })
      ];

      await replayProjection(balances(1), deps(store, new ScriptedEventLog(baseLog), clock), {
        batchSize: 2,
        promote: true
      });
      await replayProjection(balances(2), deps(store, new ScriptedEventLog([...baseLog, ...later]), clock), {
        batchSize: 2,
        promote: true
      });
      expect(store.getActive("balances")).toEqual({ version: 2, previousVersion: 1 });

      expect(rollbackProjection("balances", deps(store, new ScriptedEventLog([]), clock))).toMatchObject({
        ok: true,
        value: { fromVersion: 2, toVersion: 1, checkpoint: 7 }
      });

      const resumeLog = new ScriptedEventLog([...baseLog, ...later], {
        appendPlan: {
          0: [createReplayEvent(12, "payment.recorded", 2, { account: "GA", stroops: 3 })]
        }
      });
      const resumed = await replayProjection(balances(1), deps(store, resumeLog, clock), {
        mode: "resume",
        batchSize: 2,
        runId: "rollback-catch-up"
      });

      expect(resumed.ok && resumed.value).toMatchObject({
        fromSequence: 7,
        toSequence: 12,
        status: "ready",
        previousActiveVersion: 1
      });
      expect(store.getSlot<Balances>("balances", 1)?.state).toEqual(expectedBalances(resumeLog.snapshot()));
      expect(store.getActive("balances")).toEqual({ version: 1, previousVersion: 2 });
    });

    it("keeps a failed staging build from becoming a rollback target", async () => {
      const clock = createDeterministicClock(0);
      await replayProjection(balances(1), deps(store, new ScriptedEventLog(baseLog), clock), {
        batchSize: 2,
        promote: true
      });

      const negative = [...baseLog, createReplayEvent(8, "payment.recorded", 2, { account: "GB", stroops: -100 })];
      const failed = await replayProjection(balances(2), deps(store, new ScriptedEventLog(negative), clock), {
        batchSize: 2,
        promote: true,
        runId: "failed-staging"
      });
      expect(failed).toMatchObject({ ok: false, code: "validation_failed" });
      expect(store.getSlot("balances", 2)?.status).toBe("failed");

      // A failed version cannot be promoted or rolled back to.
      expect(promoteProjection("balances", 2, deps(store, new ScriptedEventLog([]), clock))).toMatchObject({
        ok: false,
        code: "no_previous_version"
      });
      expect(rollbackProjection("balances", deps(store, new ScriptedEventLog([]), clock))).toMatchObject({
        ok: false,
        code: "no_previous_version"
      });
      expect(store.getActive("balances")?.version).toBe(1);
    });
  });
});
