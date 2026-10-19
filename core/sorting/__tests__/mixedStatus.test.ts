import { describe, expect, it } from "vitest";
import { sortMixedStatusEvents, sortMixedStatusRecords } from "@/core/sorting";

describe("mixed-status deterministic sorting", () => {
  it("orders records by actionable status and deterministic tie-breakers", () => {
    const input = [
      { id: "done", status: "completed", updatedAt: "2026-01-03T00:00:00Z" },
      { id: "failure-b", status: "failed", updatedAt: "2026-01-02T00:00:00Z", sequence: 1 },
      { id: "pending", status: "pending", updatedAt: "2026-01-04T00:00:00Z" },
      { id: "failure-a", status: "failed", updatedAt: "2026-01-02T00:00:00Z", sequence: 2 }
    ];
    expect(sortMixedStatusRecords(input).map(({ id }) => id)).toEqual([
      "failure-a", "failure-b", "pending", "done"
    ]);
    expect(input.map(({ id }) => id)).toEqual(["done", "failure-b", "pending", "failure-a"]);
  });

  it("keeps events reverse chronological across statuses", () => {
    const events = [
      { id: "a", status: "completed", at: 10, sequence: 1 },
      { id: "c", status: "running", at: 20, sequence: 1 },
      { id: "b", status: "failed", at: 10, sequence: 1 }
    ];
    expect(sortMixedStatusEvents(events).map(({ id }) => id)).toEqual(["c", "b", "a"]);
  });

  it("sorts unknown statuses and invalid dates without relying on input order", () => {
    const records = [
      { id: "z", status: "future", updatedAt: "bad" },
      { id: "a", status: "future", updatedAt: null },
      { id: "m", status: "experimental", updatedAt: undefined }
    ];
    expect(sortMixedStatusRecords(records).map(({ id }) => id)).toEqual(["m", "a", "z"]);
    expect(sortMixedStatusRecords([...records].reverse()).map(({ id }) => id)).toEqual(["m", "a", "z"]);
  });

  it("only returns the caller-authorized input subset", () => {
    const all = [
      { id: "visible", status: "pending", updatedAt: 1, owner: "ada" },
      { id: "secret", status: "failed", updatedAt: 2, owner: "eve" }
    ];
    const authorized = all.filter((record) => record.owner === "ada");
    expect(sortMixedStatusRecords(authorized).map(({ id }) => id)).toEqual(["visible"]);
  });
});
