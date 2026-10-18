import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor, paginateByCursor } from "@/core/pagination/cursor";

type Row = { id: string; value: number };

const rows: Row[] = Array.from({ length: 6 }, (_, index) => ({ id: String(index), value: index }));

describe("cursor pagination", () => {
  it("round-trips a cursor", () => {
    const cursor = encodeCursor("row-3", 2);
    expect(decodeCursor(cursor)).toEqual({ key: "row-3", offset: 2 });
    expect(decodeCursor("not-a-cursor")).toBeNull();
  });

  it("continues after the anchor when rows are inserted before it", () => {
    const first = paginateByCursor(rows, { pageSize: 2, getKey: (row) => row.id });
    const changed = [{ id: "new", value: -1 }, ...rows];
    const second = paginateByCursor(changed, {
      pageSize: 2,
      getKey: (row) => row.id,
      cursor: first.nextCursor ?? undefined
    });

    expect(first.items.map((row) => row.id)).toEqual(["0", "1"]);
    expect(second.items.map((row) => row.id)).toEqual(["2", "3"]);
    expect(second.items.map((row) => row.id)).not.toContain("1");
  });

  it("falls back to the cursor offset after its anchor is deleted", () => {
    const first = paginateByCursor(rows, { pageSize: 2, getKey: (row) => row.id });
    const changed = rows.filter((row) => row.id !== "1");
    const second = paginateByCursor(changed, {
      pageSize: 2,
      getKey: (row) => row.id,
      cursor: first.nextCursor ?? undefined
    });

    expect(second.items.map((row) => row.id)).toEqual(["2", "3"]);
  });

  it("returns no cursor after the final item", () => {
    const page = paginateByCursor(rows, { pageSize: 6, getKey: (row) => row.id });
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });
});

describe("cursor pagination under concurrent change", () => {
  const byKey = (a: string, b: string) => Number(a) - Number(b);
  const ordered: Row[] = Array.from({ length: 10 }, (_, index) => ({ id: String(index * 10), value: index }));
  const ids = (page: { items: Row[] }) => page.items.map((row) => row.id);

  it("resumes after a deleted anchor by key order, not by a stale offset", () => {
    const first = paginateByCursor(ordered, { pageSize: 3, getKey: (row) => row.id, compareKeys: byKey });
    // The anchor ("20") is deleted and two earlier rows are removed as well,
    // which would shift a raw offset past unseen rows.
    const changed = ordered.filter((row) => !["0", "10", "20"].includes(row.id));
    const second = paginateByCursor(changed, {
      pageSize: 3,
      getKey: (row) => row.id,
      compareKeys: byKey,
      cursor: first.nextCursor ?? undefined
    });

    expect(ids(first)).toEqual(["0", "10", "20"]);
    expect(ids(second)).toEqual(["30", "40", "50"]);
  });

  it("does not repeat or skip rows when the anchor is deleted and rows are inserted", () => {
    const first = paginateByCursor(ordered, { pageSize: 3, getKey: (row) => row.id, compareKeys: byKey });
    const changed = [
      { id: "5", value: -1 },
      ...ordered.filter((row) => row.id !== "20"),
      { id: "95", value: -2 }
    ].sort((a, b) => byKey(a.id, b.id));
    const second = paginateByCursor(changed, {
      pageSize: 4,
      getKey: (row) => row.id,
      compareKeys: byKey,
      cursor: first.nextCursor ?? undefined
    });

    expect(ids(second)).toEqual(["30", "40", "50", "60"]);
  });

  it("ends cleanly when the anchor was the last row and it is deleted", () => {
    const after = paginateByCursor(ordered.slice(0, 9), {
      pageSize: 2,
      getKey: (row) => row.id,
      compareKeys: byKey,
      cursor: encodeCursor("90", 9)
    });
    expect(after.items).toEqual([]);
    expect(after.hasMore).toBe(false);
    expect(after.nextCursor).toBeNull();
  });

  it("never returns a row that became invisible between pages", () => {
    const first = paginateByCursor(ordered, { pageSize: 3, getKey: (row) => row.id, compareKeys: byKey });
    const revoked = new Set(["20", "30", "50"]);
    const second = paginateByCursor(ordered, {
      pageSize: 3,
      getKey: (row) => row.id,
      compareKeys: byKey,
      isVisible: (row) => !revoked.has(row.id),
      cursor: first.nextCursor ?? undefined
    });

    // The anchor itself ("20") was revoked; paging continues past it.
    expect(ids(second)).toEqual(["40", "60", "70"]);
    expect(ids(second).some((id) => revoked.has(id))).toBe(false);
  });

  it("walks the full set exactly once while rows are inserted, deleted and hidden", () => {
    let data = [...ordered];
    const hidden = new Set<string>();
    const seen: string[] = [];
    let cursor: string | undefined;

    for (let step = 0; step < 20; step += 1) {
      const page = paginateByCursor(data, {
        pageSize: 2,
        getKey: (row) => row.id,
        compareKeys: byKey,
        isVisible: (row) => !hidden.has(row.id),
        cursor
      });
      seen.push(...ids(page));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;

      if (step === 0) data = data.filter((row) => row.id !== "10"); // delete the anchor
      if (step === 1) data = [{ id: "15", value: -1 }, ...data].sort((a, b) => byKey(a.id, b.id)); // insert behind the cursor
      if (step === 2) hidden.add("60"); // permission revoked ahead of the cursor
      if (step === 3) data = [...data, { id: "100", value: -2 }]; // insert ahead of the cursor
    }

    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).not.toContain("60");
    expect(seen).not.toContain("15");
    expect(seen).toContain("100");
    expect(seen.filter((id) => ["70", "80", "90"].includes(id))).toEqual(["70", "80", "90"]);
  });
});

