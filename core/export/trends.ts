/**
 * Historical trend export for operational and financial metrics (#191).
 *
 * Maintainers need to see how operations, failures and volume move over time.
 * This module buckets raw operation events into fixed UTC windows and hands the
 * result to the privacy-safe exporter (`exportRecords`), so a trend export
 * inherits everything an export already guarantees: a schema version,
 * generation metadata and expiry, redaction, pagination, the `export.generate`
 * quota, idempotency and an audit entry for every attempt, denied ones included.
 *
 * What a trend row contains (schema `1.0`), one row per window and operation:
 *
 * - `windowStart` / `windowEnd`: the UTC window, `[start, end)`;
 * - `op`: the operation name, e.g. `ticket.redeem`;
 * - `total`, `successes`, `failures`, `failureRate`;
 * - `volumeStroops`: the sum of `amountStroops` over *successful* events, as a
 *   decimal string so large totals never lose precision.
 *
 * What it never contains: accounts, addresses, sessions, IPs or any other
 * per-principal dimension. Events may carry them, but aggregation reads only
 * the fields above, so they cannot reach an export. Trends are maintainer
 * scope only: any other actor is refused with `export_denied`.
 *
 * Aggregation is pure and uses UTC, so the same events always produce the same
 * rows regardless of the host's time zone.
 */

import {
  EXPORT_CURRENT_SCHEMA_VERSION,
  authorizeExport,
  exportRecords,
  type ExportActor,
  type ExportEnvelope,
  type ExportErrorCode,
  type ExportRecord,
  type ExportRecordSource
} from "@/core/export/exporter";
import { err, ok, type Result } from "@/core/result/result";

export type TrendWindow = "hour" | "day" | "week";

export type TrendErrorCode =
  | "trend_invalid_window"
  | "trend_invalid_range"
  | "trend_range_too_large"
  | "trend_invalid_event";

export const TREND_RECORD_TYPE = "metric_trend";

/** Upper bound on windows in one export, so a request cannot ask for years of minutes. */
export const TREND_MAX_WINDOWS = 1_000;

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
/** 1970-01-01 is a Thursday; this is the Monday before it. */
const WEEK_ORIGIN_MS = -3 * DAY_MS;

const WINDOW_MS: Record<TrendWindow, number> = { hour: HOUR_MS, day: DAY_MS, week: WEEK_MS };

/** One raw operation event. Only the fields below are ever read. */
export interface TrendEvent {
  /** ISO-8601 string or epoch milliseconds. */
  readonly at: string | number;
  readonly op: string;
  readonly result: "success" | "failure";
  /** Integer stroops moved by a successful event. Ignored for failures. */
  readonly amountStroops?: number;
}

export interface TrendRow extends ExportRecord {
  windowStart: string;
  windowEnd: string;
  op: string;
  total: number;
  successes: number;
  failures: number;
  failureRate: number;
  volumeStroops: string;
}

export interface TrendQuery {
  readonly window: TrendWindow;
  /** Inclusive start of the range. */
  readonly from: string | number;
  /** Exclusive end of the range. */
  readonly to: string | number;
}

function toMillis(value: string | number): number {
  return typeof value === "number" ? value : Date.parse(value);
}

function windowStart(at: number, window: TrendWindow): number {
  const size = WINDOW_MS[window];
  const origin = window === "week" ? WEEK_ORIGIN_MS : 0;
  return origin + Math.floor((at - origin) / size) * size;
}

/**
 * Buckets events into windows. Events outside `[from, to)` are ignored; an
 * event that cannot be read is an error, not a silent skip, so a total never
 * quietly under-counts.
 */
export function aggregateTrends(
  events: readonly TrendEvent[],
  query: TrendQuery
): Result<TrendRow[], TrendErrorCode, { index?: number }> {
  if (!Object.prototype.hasOwnProperty.call(WINDOW_MS, query.window)) {
    return err("trend_invalid_window");
  }
  const from = toMillis(query.from);
  const to = toMillis(query.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
    return err("trend_invalid_range");
  }
  const windows = Math.ceil((to - windowStart(from, query.window)) / WINDOW_MS[query.window]);
  if (windows > TREND_MAX_WINDOWS) return err("trend_range_too_large");

  const buckets = new Map<string, { start: number; op: string; successes: number; failures: number; volume: bigint }>();

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const at = toMillis(event.at);
    const validAmount =
      event.amountStroops === undefined ||
      (Number.isSafeInteger(event.amountStroops) && event.amountStroops >= 0);
    if (
      !Number.isFinite(at) ||
      typeof event.op !== "string" ||
      event.op.length === 0 ||
      (event.result !== "success" && event.result !== "failure") ||
      !validAmount
    ) {
      return err("trend_invalid_event", { index });
    }
    if (at < from || at >= to) continue;

    const start = windowStart(at, query.window);
    const key = `${start}\u0000${event.op}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { start, op: event.op, successes: 0, failures: 0, volume: 0n };
      buckets.set(key, bucket);
    }
    if (event.result === "success") {
      bucket.successes += 1;
      bucket.volume += BigInt(event.amountStroops ?? 0);
    } else {
      bucket.failures += 1;
    }
  }

  const size = WINDOW_MS[query.window];
  const rows = [...buckets.values()]
    .sort((a, b) => a.start - b.start || (a.op < b.op ? -1 : a.op > b.op ? 1 : 0))
    .map((bucket): TrendRow => {
      const total = bucket.successes + bucket.failures;
      return {
        windowStart: new Date(bucket.start).toISOString(),
        windowEnd: new Date(bucket.start + size).toISOString(),
        op: bucket.op,
        total,
        successes: bucket.successes,
        failures: bucket.failures,
        failureRate: Math.round((bucket.failures / total) * 10_000) / 10_000,
        volumeStroops: bucket.volume.toString()
      };
    });

  return ok(rows);
}

export interface TrendExportRequest extends TrendQuery {
  readonly actor: ExportActor;
  readonly pageSize?: number;
  readonly cursor?: string;
  readonly correlationId?: string;
  readonly idempotencyKey?: string;
  /** Who the `export.generate` quota is charged to. */
  readonly principal?: string;
  readonly ttlMs?: number;
}

/**
 * Generates a versioned, maintainer-scope trend export. The envelope is the
 * standard export envelope, so `schemaVersion`, `generatedAt`, `generator`,
 * `expiresAt` and the pagination fields are present on every result.
 */
export function exportTrends(
  request: TrendExportRequest,
  events: readonly TrendEvent[]
): Result<ExportEnvelope, ExportErrorCode | TrendErrorCode, unknown> {
  // Aggregate only for an actor who may see the result; a refused actor still
  // goes through `exportRecords` so the denial is audited like any other.
  const authorized = authorizeExport(request.actor, "maintainer").ok;
  let rows: TrendRow[] = [];
  if (authorized) {
    const aggregated = aggregateTrends(events, request);
    if (!aggregated.ok) return aggregated;
    rows = aggregated.value;
  }

  const source: ExportRecordSource = {
    recordType: TREND_RECORD_TYPE,
    schemaVersion: EXPORT_CURRENT_SCHEMA_VERSION,
    scope: "maintainer",
    collect: () => rows
  };

  return exportRecords(
    {
      schemaVersion: EXPORT_CURRENT_SCHEMA_VERSION,
      scope: "maintainer",
      actor: request.actor,
      pageSize: request.pageSize,
      cursor: request.cursor,
      correlationId: request.correlationId,
      idempotencyKey: request.idempotencyKey,
      principal: request.principal,
      ttlMs: request.ttlMs
    },
    [source]
  );
}
