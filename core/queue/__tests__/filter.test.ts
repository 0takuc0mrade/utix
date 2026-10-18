import { describe, expect, it } from "vitest";
import {
  parseQueueQuery,
  queryQueue,
  type QueueItem,
  type QueuePage,
  type QueueQuery
} from "@/core/queue/filter";

const NOW = Date.parse("2026-01-10T00:00:00.000Z");
const HOUR = 3_600_000;
const MAINTAINER = { role: "maintainer", userId: "ada" } as const;

function item(id: string, hoursOld: number, overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    id,
    severity: "medium",
    status: "open",
    actor: "alice",
    resource: "ticket:t-1",
    failureCategory: "redemption",
    createdAt: new Date(NOW - hoursOld * HOUR).toISOString(),
    ...overrides
  };
}

const ITEMS: QueueItem[] = [
  item("q-1", 1, { severity: "critical", actor: "bob" }),
  item("q-2", 5, { severity: "high", status: "escalated", resource: "event:e-1" }),
  item("q-3", 30, { failureCategory: "transfer" }),
  item("q-4", 48, { severity: "low", status: "resolved", failureCategory: "fraud" }),
  item("q-5", 2, { severity: "high", restricted: true })
];

function ids(page: QueuePage): string[] {
  return page.items.map((entry) => entry.id);
}

function query(q: QueueQuery = {}, auth: Parameters<typeof queryQueue>[1] = MAINTAINER) {
  const result = queryQueue(ITEMS, auth, { now: NOW, ...q });
  if (!result.ok) throw new Error(`unexpected ${result.code}`);
  return result.value;
}

describe("queryQueue", () => {
  it("applies a single filter", () => {
    expect(ids(query({ severity: ["critical"] }))).toEqual(["q-1"]);
    expect(ids(query({ failureCategory: ["transfer"] }))).toEqual(["q-3"]);
  });

  it("ORs values within a filter and ANDs different filters", () => {
    expect(ids(query({ severity: ["high", "critical"] }))).toEqual(["q-1", "q-5", "q-2"]);
    expect(ids(query({ severity: ["high", "critical"], status: ["open"] }))).toEqual([
      "q-1",
      "q-5"
    ]);
  });

  it("combines age bounds with other filters", () => {
    expect(ids(query({ minAgeMs: 4 * HOUR, maxAgeMs: 40 * HOUR }))).toEqual(["q-2", "q-3"]);
    expect(ids(query({ minAgeMs: 4 * HOUR, status: ["escalated"], resource: ["event:e-1"] }))).toEqual([
      "q-2"
    ]);
  });

  it("returns an empty page when nothing matches", () => {
    const page = query({ severity: ["low"], status: ["open"] });
    expect(page).toMatchObject({ items: [], hasMore: false, nextCursor: null, totalMatched: 0 });
  });

  it("hides restricted items from roles without config access", () => {
    expect(ids(query({}, MAINTAINER))).toContain("q-5");
    const service = query({ severity: ["high"] }, { role: "service" });
    expect(ids(service)).toEqual(["q-2"]);
    expect(service.totalMatched).toBe(1);
  });

  it("denies roles that cannot read maintainer queues", () => {
    expect(queryQueue(ITEMS, { role: "viewer" }, { now: NOW })).toEqual({
      ok: false,
      code: "permission_denied"
    });
  });

  it("rejects invalid filters", () => {
    const bad = [
      { severity: ["urgent" as never] },
      { minAgeMs: -1 },
      { minAgeMs: 10, maxAgeMs: 5 },
      { pageSize: 0 },
      { pageSize: 1000 }
    ];
    for (const q of bad) {
      const result = queryQueue(ITEMS, MAINTAINER, { now: NOW, ...q });
      expect(result).toMatchObject({ ok: false, code: "invalid_filter" });
    }
  });

  it("pages a filtered result without gaps or repeats", () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = query({ status: ["open", "escalated"], pageSize: 2, cursor });
      seen.push(...ids(page));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toEqual(ids(query({ status: ["open", "escalated"] })));
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("keeps the cursor valid when a new item is queued between pages", () => {
    const first = query({ status: ["open"], pageSize: 2 });
    const withNew = [item("q-new", 0), ...ITEMS];
    const next = queryQueue(withNew, MAINTAINER, {
      now: NOW,
      status: ["open"],
      pageSize: 2,
      cursor: first.nextCursor ?? undefined
    });
    expect(next.ok && next.value.items.map((entry) => entry.id)).toEqual(
      ids(query({ status: ["open"] })).slice(2, 4)
    );
  });

  it("orders ties by id", () => {
    const tied = [item("b", 1), item("a", 1)];
    const result = queryQueue(tied, MAINTAINER, { now: NOW });
    expect(result.ok && result.value.items.map((entry) => entry.id)).toEqual(["a", "b"]);
  });
});

describe("parseQueueQuery", () => {
  it("reads comma separated and repeated params", () => {
    const parsed = parseQueueQuery(
      new URLSearchParams("severity=high,critical&status=open&status=escalated&minAgeMs=60000&pageSize=10")
    );
    expect(parsed).toMatchObject({
      severity: ["high", "critical"],
      status: ["open", "escalated"],
      minAgeMs: 60000,
      pageSize: 10
    });
    expect(parsed.actor).toBeUndefined();
  });

  it("passes non-numeric values through so queryQueue can reject them", () => {
    const parsed = parseQueueQuery(new URLSearchParams("minAgeMs=soon"));
    expect(queryQueue(ITEMS, MAINTAINER, parsed)).toMatchObject({ ok: false, code: "invalid_filter" });
  });
});
