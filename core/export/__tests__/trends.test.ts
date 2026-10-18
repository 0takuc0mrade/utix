import { beforeEach, describe, expect, it } from "vitest";
import {
  EXPORT_CURRENT_SCHEMA_VERSION,
  EXPORT_GENERATOR,
  createExportIdempotencyStore,
  createExportQuotaStore
} from "@/core/export/exporter";
import {
  TREND_MAX_WINDOWS,
  TREND_RECORD_TYPE,
  aggregateTrends,
  exportTrends,
  type TrendEvent,
  type TrendRow
} from "@/core/export/trends";

const MAINTAINER = { kind: "maintainer", id: "ada" } as const;

/** Fixture: two days of events across two operations. Totals are checked by hand. */
const EVENTS: TrendEvent[] = [
  { at: "2026-10-05T09:00:00.000Z", op: "ticket.redeem", result: "success", amountStroops: 100 },
  { at: "2026-10-05T09:30:00.000Z", op: "ticket.redeem", result: "success", amountStroops: 250 },
  { at: "2026-10-05T10:15:00.000Z", op: "ticket.redeem", result: "failure", amountStroops: 999 },
  { at: "2026-10-05T23:59:59.999Z", op: "ticket.transfer", result: "success", amountStroops: 1_000 },
  { at: "2026-10-06T00:00:00.000Z", op: "ticket.transfer", result: "failure" },
  { at: "2026-10-06T12:00:00.000Z", op: "ticket.transfer", result: "success", amountStroops: 500 },
  { at: "2026-10-12T08:00:00.000Z", op: "ticket.redeem", result: "success", amountStroops: 7 }
];

const DAY_RANGE = { window: "day", from: "2026-10-05T00:00:00.000Z", to: "2026-10-07T00:00:00.000Z" } as const;

function rows(events: readonly TrendEvent[], query: Parameters<typeof aggregateTrends>[1]): TrendRow[] {
  const result = aggregateTrends(events, query);
  if (!result.ok) throw new Error(`expected rows, got ${result.code}`);
  return result.value;
}

function withoutEnvelopeFields(record: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...record };
  delete copy.recordType;
  delete copy.scope;
  return copy;
}

beforeEach(() => {
  createExportQuotaStore();
  createExportIdempotencyStore();
});

describe("aggregateTrends", () => {
  it("matches the source fixture per day and operation", () => {
    expect(rows(EVENTS, DAY_RANGE)).toEqual([
      {
        windowStart: "2026-10-05T00:00:00.000Z",
        windowEnd: "2026-10-06T00:00:00.000Z",
        op: "ticket.redeem",
        total: 3,
        successes: 2,
        failures: 1,
        failureRate: 0.3333,
        volumeStroops: "350"
      },
      {
        windowStart: "2026-10-05T00:00:00.000Z",
        windowEnd: "2026-10-06T00:00:00.000Z",
        op: "ticket.transfer",
        total: 1,
        successes: 1,
        failures: 0,
        failureRate: 0,
        volumeStroops: "1000"
      },
      {
        windowStart: "2026-10-06T00:00:00.000Z",
        windowEnd: "2026-10-07T00:00:00.000Z",
        op: "ticket.transfer",
        total: 2,
        successes: 1,
        failures: 1,
        failureRate: 0.5,
        volumeStroops: "500"
      }
    ]);
  });

  it("treats the range as inclusive of from and exclusive of to", () => {
    const tight = rows(EVENTS, { window: "day", from: "2026-10-05T23:59:59.999Z", to: "2026-10-06T00:00:00.000Z" });
    expect(tight.map((row) => row.total)).toEqual([1]);
    expect(tight[0].op).toBe("ticket.transfer");
  });

  it("buckets hours and Monday-based UTC weeks", () => {
    const hourly = rows(EVENTS, { window: "hour", from: "2026-10-05T09:00:00.000Z", to: "2026-10-05T11:00:00.000Z" });
    expect(hourly.map((row) => [row.windowStart, row.total])).toEqual([
      ["2026-10-05T09:00:00.000Z", 2],
      ["2026-10-05T10:00:00.000Z", 1]
    ]);

    const weekly = rows(EVENTS, { window: "week", from: "2026-10-05T00:00:00.000Z", to: "2026-10-19T00:00:00.000Z" });
    expect(weekly.map((row) => [row.windowStart, row.op, row.total])).toEqual([
      ["2026-10-05T00:00:00.000Z", "ticket.redeem", 3],
      ["2026-10-05T00:00:00.000Z", "ticket.transfer", 3],
      ["2026-10-12T00:00:00.000Z", "ticket.redeem", 1]
    ]);
  });

  it("returns no rows for empty data or an empty range", () => {
    expect(rows([], DAY_RANGE)).toEqual([]);
    expect(rows(EVENTS, { window: "day", from: "2027-01-01T00:00:00.000Z", to: "2027-01-02T00:00:00.000Z" })).toEqual([]);
  });

  it("does not depend on event order and does not carry per-account fields", () => {
    const withAccounts = EVENTS.map((event) => ({ ...event, account: "GSECRETACCOUNT", ipAddress: "10.0.0.1" }));
    const shuffled = [...withAccounts].reverse();
    expect(rows(shuffled, DAY_RANGE)).toEqual(rows(EVENTS, DAY_RANGE));
    expect(JSON.stringify(rows(shuffled, DAY_RANGE))).not.toMatch(/GSECRETACCOUNT|10\.0\.0\.1/);
  });

  it("keeps stroop totals exact beyond the safe integer range", () => {
    const big = Number.MAX_SAFE_INTEGER;
    const result = rows(
      [
        { at: "2026-10-05T01:00:00.000Z", op: "pay", result: "success", amountStroops: big },
        { at: "2026-10-05T02:00:00.000Z", op: "pay", result: "success", amountStroops: big }
      ],
      DAY_RANGE
    );
    expect(result[0].volumeStroops).toBe((BigInt(big) * 2n).toString());
  });

  it("rejects bad windows, ranges and events instead of under-counting", () => {
    const code = (events: readonly TrendEvent[], query: Parameters<typeof aggregateTrends>[1]) => {
      const result = aggregateTrends(events, query);
      return result.ok ? "ok" : result.code;
    };
    expect(code(EVENTS, { ...DAY_RANGE, window: "minute" as never })).toBe("trend_invalid_window");
    expect(code(EVENTS, { ...DAY_RANGE, from: "not-a-date" })).toBe("trend_invalid_range");
    expect(code(EVENTS, { ...DAY_RANGE, to: DAY_RANGE.from })).toBe("trend_invalid_range");
    expect(code(EVENTS, { window: "hour", from: 0, to: (TREND_MAX_WINDOWS + 1) * 3_600_000 })).toBe(
      "trend_range_too_large"
    );
    expect(code([{ at: "garbage", op: "x", result: "success" }], DAY_RANGE)).toBe("trend_invalid_event");
    expect(code([{ at: 0, op: "x", result: "success", amountStroops: -1 }], DAY_RANGE)).toBe("trend_invalid_event");
    expect(code([{ at: 0, op: "x", result: "success", amountStroops: 1.5 }], DAY_RANGE)).toBe("trend_invalid_event");
  });
});

describe("exportTrends", () => {
  it("includes schema version and generation metadata", () => {
    const result = exportTrends({ ...DAY_RANGE, actor: MAINTAINER, correlationId: "corr-1" }, EVENTS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const envelope = result.value;
    expect(envelope.schemaVersion).toBe(EXPORT_CURRENT_SCHEMA_VERSION);
    expect(envelope.generator).toBe(EXPORT_GENERATOR);
    expect(envelope.scope).toBe("maintainer");
    expect(envelope.correlationId).toBe("corr-1");
    expect(Date.parse(envelope.generatedAt)).not.toBeNaN();
    expect(Date.parse(envelope.expiresAt)).toBeGreaterThan(Date.parse(envelope.generatedAt));
    expect(envelope.totalRecords).toBe(3);
    expect(envelope.records.every((record) => record.recordType === TREND_RECORD_TYPE)).toBe(true);
  });

  it("exports the same figures the aggregation produces", () => {
    const result = exportTrends({ ...DAY_RANGE, actor: MAINTAINER }, EVENTS);
    if (!result.ok) throw new Error(result.code);
    const expected = rows(EVENTS, DAY_RANGE);
    expect(result.value.records.map(withoutEnvelopeFields)).toEqual(expected);
  });

  it("returns an empty, still versioned envelope for empty data", () => {
    const result = exportTrends({ ...DAY_RANGE, actor: MAINTAINER }, []);
    if (!result.ok) throw new Error(result.code);
    expect(result.value.recordCount).toBe(0);
    expect(result.value.totalRecords).toBe(0);
    expect(result.value.hasMore).toBe(false);
    expect(result.value.schemaVersion).toBe(EXPORT_CURRENT_SCHEMA_VERSION);
  });

  it("denies every actor that is not a maintainer", () => {
    for (const actor of [{ kind: "user", id: "bob" }, { kind: "service", id: "cron" }] as const) {
      const result = exportTrends({ ...DAY_RANGE, actor }, EVENTS);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("export_denied");
    }
  });

  it("refuses a denied actor before reading the events", () => {
    const result = exportTrends({ ...DAY_RANGE, window: "minute" as never, actor: { kind: "user" } }, EVENTS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("export_denied");
  });

  it("reports an invalid query to a maintainer", () => {
    const result = exportTrends({ ...DAY_RANGE, to: DAY_RANGE.from, actor: MAINTAINER }, EVENTS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("trend_invalid_range");
  });

  it("pages a large result set without losing or repeating a row", () => {
    const large: TrendEvent[] = [];
    for (let index = 0; index < 5_000; index += 1) {
      large.push({
        at: Date.parse("2026-10-05T00:00:00.000Z") + index * 60_000,
        op: `op.${index % 50}`,
        result: index % 7 === 0 ? "failure" : "success",
        amountStroops: index
      });
    }
    const query = { window: "hour", from: "2026-10-05T00:00:00.000Z", to: "2026-10-09T00:00:00.000Z" } as const;
    const expected = rows(large, query);
    expect(expected.length).toBeGreaterThan(400);

    const collected: Array<Record<string, unknown>> = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = exportTrends({ ...query, actor: MAINTAINER, pageSize: 1_000, cursor }, large);
      if (!page.ok) throw new Error(page.code);
      collected.push(...page.value.records);
      cursor = page.value.nextCursor ?? undefined;
      pages += 1;
    } while (cursor && pages < 20);

    expect(collected).toHaveLength(expected.length);
    expect(collected.map(withoutEnvelopeFields)).toEqual(expected);
    const volume = collected.reduce((sum, row) => sum + BigInt(row.volumeStroops as string), 0n);
    const expectedVolume = large.reduce((sum, event) => sum + (event.result === "success" ? BigInt(event.amountStroops!) : 0n), 0n);
    expect(volume).toBe(expectedVolume);
  });
});
