/**
 * Advanced filtering for maintainer queues (#186).
 *
 * A maintainer queue is a list of items awaiting review: failed redemptions,
 * flagged transfers, stuck operations. `queryQueue` narrows that list by
 * severity, age, actor, status, resource and failure category, then pages the
 * result with the shared cursor helper.
 *
 * Semantics: values inside one filter are OR-ed, different filters are AND-ed,
 * and an omitted filter matches everything. The result is sorted newest first
 * with the item id as tie-breaker, so the order — and therefore every cursor —
 * is identical for the same data no matter which filters are applied.
 */

import type { AuthContext } from "@/core/auth/middleware";
import { hasPermission, type Permission } from "@/core/auth/types";
import { paginateByCursor } from "@/core/pagination/cursor";
import { err, ok, type Result } from "@/core/result/result";

export const QUEUE_SEVERITIES = ["low", "medium", "high", "critical"] as const;

export type QueueSeverity = (typeof QUEUE_SEVERITIES)[number];

/** Needed to read a maintainer queue at all. */
export const QUEUE_READ_PERMISSION: Permission = "admin:health";

/** Needed to see items flagged `restricted`; other roles never receive them. */
export const QUEUE_RESTRICTED_PERMISSION: Permission = "admin:config";

export const QUEUE_DEFAULT_PAGE_SIZE = 25;
export const QUEUE_MAX_PAGE_SIZE = 100;

export interface QueueItem {
  readonly id: string;
  readonly severity: QueueSeverity;
  readonly status: string;
  /** Who raised or last touched the item. */
  readonly actor: string;
  /** The resource the item is about, e.g. `ticket:t-1`. */
  readonly resource: string;
  readonly failureCategory?: string;
  /** ISO timestamp the item entered the queue. */
  readonly createdAt: string;
  readonly restricted?: boolean;
}

export interface QueueQuery {
  readonly severity?: readonly QueueSeverity[];
  readonly status?: readonly string[];
  readonly actor?: readonly string[];
  readonly resource?: readonly string[];
  readonly failureCategory?: readonly string[];
  /** Keep only items at least this old. */
  readonly minAgeMs?: number;
  /** Keep only items at most this old. */
  readonly maxAgeMs?: number;
  readonly cursor?: string;
  readonly pageSize?: number;
  readonly now?: number | Date;
}

export type QueueErrorCode = "permission_denied" | "invalid_filter";

export interface QueuePage {
  readonly items: readonly QueueItem[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
  /** Items that matched the filters, across all pages. */
  readonly totalMatched: number;
}

function toMs(now: number | Date | undefined): number {
  if (now instanceof Date) return now.getTime();
  return typeof now === "number" ? now : Date.now();
}

function validateQuery(query: QueueQuery): string | null {
  for (const severity of query.severity ?? []) {
    if (!QUEUE_SEVERITIES.includes(severity)) return `unknown severity "${severity}"`;
  }
  for (const key of ["minAgeMs", "maxAgeMs"] as const) {
    const value = query[key];
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
      return `${key} must be a non-negative number`;
    }
  }
  if (
    query.minAgeMs !== undefined &&
    query.maxAgeMs !== undefined &&
    query.minAgeMs > query.maxAgeMs
  ) {
    return "minAgeMs must not exceed maxAgeMs";
  }
  if (
    query.pageSize !== undefined &&
    (!Number.isInteger(query.pageSize) || query.pageSize < 1 || query.pageSize > QUEUE_MAX_PAGE_SIZE)
  ) {
    return `pageSize must be an integer between 1 and ${QUEUE_MAX_PAGE_SIZE}`;
  }
  return null;
}

function oneOf<T>(allowed: readonly T[] | undefined, value: T | undefined): boolean {
  if (allowed === undefined || allowed.length === 0) return true;
  return value !== undefined && allowed.includes(value);
}

/** Newest first, id ascending as a total-order tie-breaker. */
function compareItems(a: QueueItem, b: QueueItem): number {
  const delta = Date.parse(b.createdAt) - Date.parse(a.createdAt);
  if (delta !== 0) return delta;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function queryQueue(
  items: readonly QueueItem[],
  auth: AuthContext,
  query: QueueQuery = {}
): Result<QueuePage, QueueErrorCode, string> {
  if (!hasPermission(auth.role, QUEUE_READ_PERMISSION)) return err("permission_denied");
  const problem = validateQuery(query);
  if (problem) return err("invalid_filter", problem);

  const canSeeRestricted = hasPermission(auth.role, QUEUE_RESTRICTED_PERMISSION);
  const nowMs = toMs(query.now);

  const matched = items
    .filter((item) => {
      if (item.restricted && !canSeeRestricted) return false;
      const age = nowMs - Date.parse(item.createdAt);
      if (query.minAgeMs !== undefined && age < query.minAgeMs) return false;
      if (query.maxAgeMs !== undefined && age > query.maxAgeMs) return false;
      return (
        oneOf(query.severity, item.severity) &&
        oneOf(query.status, item.status) &&
        oneOf(query.actor, item.actor) &&
        oneOf(query.resource, item.resource) &&
        oneOf(query.failureCategory, item.failureCategory)
      );
    })
    .sort(compareItems);

  const page = paginateByCursor(matched, {
    pageSize: query.pageSize ?? QUEUE_DEFAULT_PAGE_SIZE,
    getKey: (item) => item.id,
    cursor: query.cursor
  });

  return ok({
    items: page.items,
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
    totalMatched: matched.length
  });
}

function list(params: URLSearchParams, name: string): string[] | undefined {
  const values = params
    .getAll(name)
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  return values.length > 0 ? values : undefined;
}

function numeric(params: URLSearchParams, name: string): number | undefined {
  const raw = params.get(name);
  return raw === null || raw === "" ? undefined : Number(raw);
}

/**
 * Builds a `QueueQuery` from URL search params, e.g.
 * `?severity=high,critical&status=open&minAgeMs=3600000&pageSize=20`.
 * Values are not validated here; `queryQueue` rejects bad ones.
 */
export function parseQueueQuery(params: URLSearchParams): QueueQuery {
  return {
    severity: list(params, "severity") as QueueSeverity[] | undefined,
    status: list(params, "status"),
    actor: list(params, "actor"),
    resource: list(params, "resource"),
    failureCategory: list(params, "failureCategory"),
    minAgeMs: numeric(params, "minAgeMs"),
    maxAgeMs: numeric(params, "maxAgeMs"),
    cursor: params.get("cursor") || undefined,
    pageSize: numeric(params, "pageSize")
  };
}
