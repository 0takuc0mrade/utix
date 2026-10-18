/**
 * Deterministic test harness for the versioned replay runner.
 *
 * The runner is asynchronous, so "concurrent" tests must not depend on wall
 * clock time, timers or the platform's microtask ordering. This harness gives
 * every run an injected clock and an append-only log whose writes are scripted
 * per read attempt: a write lands at an exact read boundary, and a source
 * failure is consumed in a deterministic order. Running the same scenario
 * twice produces the same read trace, backoff sequence and final state.
 */

import type { EventSource, ReplayEvent } from "../index";

/** Scripted event time; fixed so reports are byte-identical between runs. */
export const REPLAY_TEST_TIME = "2026-10-17T00:00:00.000Z";

export function createReplayEvent(
  sequence: number,
  type: string,
  version: number,
  payload: unknown,
  id = `evt-${sequence}`
): ReplayEvent {
  return { id, sequence, type, version, payload, occurredAt: REPLAY_TEST_TIME };
}

export interface DeterministicClock {
  now(): number;
  set(value: number): void;
  advance(ms: number): void;
}

/** A clock the test moves explicitly; nothing here reads `Date.now()`. */
export function createDeterministicClock(start = 0): DeterministicClock {
  let value = start;
  return {
    now: () => value,
    set: (next) => {
      value = next;
    },
    advance: (ms) => {
      value += ms;
    }
  };
}

/** Deterministic PRNG (mulberry32). Same seed, same write plan, every run. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export interface ScriptedRead {
  readonly index: number;
  readonly after: number;
  readonly limit: number;
  readonly returned: readonly number[];
  readonly failed: boolean;
  readonly error?: string;
}

export interface ScriptedLogOptions {
  /**
   * Events appended immediately before read `index`. This is the write window
   * a concurrent producer sees while the replay awaits the source.
   */
  readonly appendPlan?: Readonly<Record<number, readonly ReplayEvent[]>>;
  /** Consecutive failures before the read at `index` can succeed. */
  readonly failures?: Readonly<Record<number, number>>;
  /** Runs after planned appends but before the batch is selected. */
  readonly beforeRead?: (index: number, log: ScriptedEventLog) => void | Promise<void>;
  /** Lets a test corrupt the batch a racing source would return. */
  readonly mapBatch?: (batch: readonly ReplayEvent[], index: number) => readonly ReplayEvent[];
}

/** Append-only log with a deterministic read trace. */
export class ScriptedEventLog implements EventSource {
  private events: ReplayEvent[];
  private readonly failures: Map<number, number>;
  readonly reads: ScriptedRead[] = [];
  readonly appended: ReplayEvent[] = [];

  constructor(
    initial: readonly ReplayEvent[],
    private readonly options: ScriptedLogOptions = {}
  ) {
    this.events = [...initial].sort((left, right) => left.sequence - right.sequence);
    this.failures = new Map(Object.entries(options.failures ?? {}).map(([key, value]) => [Number(key), value]));
  }

  append(event: ReplayEvent): void {
    if (!Number.isInteger(event.sequence) || event.sequence < 1) {
      throw new Error(`invalid sequence ${event.sequence}`);
    }
    if (this.events.some((existing) => existing.sequence === event.sequence)) {
      throw new Error(`duplicate sequence ${event.sequence}`);
    }
    this.events.push(event);
    this.events.sort((left, right) => left.sequence - right.sequence);
    this.appended.push(event);
  }

  appendAll(events: readonly ReplayEvent[]): void {
    for (const event of events) this.append(event);
  }

  snapshot(): readonly ReplayEvent[] {
    return [...this.events];
  }

  head(): number {
    return this.events.length === 0 ? 0 : this.events[this.events.length - 1].sequence;
  }

  get readCount(): number {
    return this.reads.length;
  }

  async read(after: number, limit: number): Promise<readonly ReplayEvent[]> {
    const index = this.reads.length;
    const planned = this.options.appendPlan?.[index];
    if (planned) this.appendAll(planned);

    await this.options.beforeRead?.(index, this);

    const remaining = this.failures.get(index) ?? 0;
    if (remaining > 0) {
      this.failures.set(index, remaining - 1);
      const error = `scripted failure on read ${index}`;
      this.reads.push({ index, after, limit, returned: [], failed: true, error });
      throw new Error(error);
    }

    const selected = this.events.filter((event) => event.sequence > after).slice(0, limit);
    const batch = this.options.mapBatch ? this.options.mapBatch(selected, index) : selected;
    this.reads.push({
      index,
      after,
      limit,
      returned: batch.map((event) => event.sequence),
      failed: false
    });
    return batch;
  }
}

export interface SeededWritePlan {
  readonly appendPlan: Readonly<Record<number, readonly ReplayEvent[]>>;
  readonly events: readonly ReplayEvent[];
}

/**
 * Builds a seeded plan of concurrent payments for `readCount` read windows.
 * Sequences start after `startSequence`; passing `accounts` that are already
 * opened keeps every appended event valid for the balances projection.
 */
export function makeSeededWritePlan(
  seed: number,
  startSequence: number,
  readCount: number,
  accounts: readonly string[]
): SeededWritePlan {
  if (accounts.length === 0) throw new Error("a write plan needs at least one opened account");
  const random = mulberry32(seed);
  const appendPlan: Record<number, readonly ReplayEvent[]> = {};
  const events: ReplayEvent[] = [];
  let sequence = startSequence;

  for (let index = 0; index < readCount; index += 1) {
    if (random() >= 0.55) continue;
    const count = 1 + Math.floor(random() * 2);
    const appended: ReplayEvent[] = [];
    for (let offset = 0; offset < count; offset += 1) {
      sequence += 1;
      const account = accounts[Math.floor(random() * accounts.length)];
      const stroops = 1 + Math.floor(random() * 500);
      const event = createReplayEvent(sequence, "payment.recorded", 2, { account, stroops });
      appended.push(event);
      events.push(event);
    }
    appendPlan[index] = appended;
  }

  return { appendPlan, events };
}

/**
 * Places the same events into different read windows without reordering them.
 * Seeds therefore differ only in *when* a concurrent write becomes visible,
 * which is what a convergence test needs: the expected state is identical.
 */
export function makeSeededPlacementPlan(
  seed: number,
  events: readonly ReplayEvent[],
  readCount: number
): Readonly<Record<number, readonly ReplayEvent[]>> {
  if (readCount < 1) throw new Error("a placement plan needs at least one read window");
  const random = mulberry32(seed);
  const plan: Record<number, ReplayEvent[]> = {};
  let window = 0;
  for (const event of events) {
    window = Math.min(readCount - 1, window + Math.floor(random() * 2));
    (plan[window] ??= []).push(event);
  }
  for (const batch of Object.values(plan)) batch.sort((left, right) => left.sequence - right.sequence);
  return plan;
}

export interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

/** A promise a test resolves explicitly, so interleavings are chosen, not timed. */
export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}
