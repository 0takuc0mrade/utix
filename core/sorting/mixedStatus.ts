/** A stable, total order for operational records and their event streams. */

export interface MixedStatusRecord {
  readonly id: string;
  readonly status: string;
  readonly updatedAt?: string | number | Date | null;
  readonly sequence?: number | null;
}

export interface MixedStatusEvent {
  readonly id: string;
  readonly status: string;
  readonly at?: string | number | Date | null;
  readonly sequence?: number | null;
}

/** Actionable/unsafe states precede in-flight and terminal states. */
export const STATUS_PRIORITY: Readonly<Record<string, number>> = Object.freeze({
  failed: 0,
  dead_lettered: 0,
  interrupted: 1,
  retrying: 1,
  pending: 2,
  queued: 2,
  running: 3,
  succeeded: 4,
  completed: 4,
  resolved: 4,
  skipped: 5,
  abandoned: 6,
  cancelled: 6
});

function text(a: string, b: string): number {
  return a === b ? 0 : a < b ? -1 : 1;
}

function time(value: string | number | Date | null | undefined): number {
  if (value === null || value === undefined) return Number.NEGATIVE_INFINITY;
  const parsed = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function priority(status: string): number {
  return STATUS_PRIORITY[status] ?? 7;
}

function sequence(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
}

/** Status first, then newest update, highest sequence, status text and id. */
export function compareMixedStatusRecords<T extends MixedStatusRecord>(a: T, b: T): number {
  return priority(a.status) - priority(b.status) ||
    time(b.updatedAt) - time(a.updatedAt) ||
    sequence(b.sequence) - sequence(a.sequence) ||
    text(a.status, b.status) ||
    text(a.id, b.id);
}

/** Newest event first, then status, sequence and id for timestamp ties. */
export function compareMixedStatusEvents<T extends MixedStatusEvent>(a: T, b: T): number {
  return time(b.at) - time(a.at) ||
    priority(a.status) - priority(b.status) ||
    sequence(b.sequence) - sequence(a.sequence) ||
    text(a.status, b.status) ||
    text(a.id, b.id);
}

export function sortMixedStatusRecords<T extends MixedStatusRecord>(records: readonly T[]): T[] {
  return [...records].sort(compareMixedStatusRecords);
}

export function sortMixedStatusEvents<T extends MixedStatusEvent>(events: readonly T[]): T[] {
  return [...events].sort(compareMixedStatusEvents);
}
