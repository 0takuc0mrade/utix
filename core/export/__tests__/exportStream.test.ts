import { beforeEach, describe, expect, it } from "vitest";
import {
  createExportQuotaStore,
  EXPORT_CURRENT_SCHEMA_VERSION,
  streamExportRecords,
  type ExportRecord,
  type ExportRecordSource,
  type ExportStreamSummary
} from "@/core/export/exporter";
import { createMemoryQuotaStorage, createQuotaStore } from "@/core/quota/quota";

function lazySource(
  recordType: string,
  scope: ExportRecordSource["scope"],
  count: number,
  pulled: { count: number },
  extra: ExportRecord = {}
): ExportRecordSource {
  return {
    recordType,
    schemaVersion: EXPORT_CURRENT_SCHEMA_VERSION,
    scope,
    collect: () => {
      throw new Error("collect must not be called when stream is provided");
    },
    stream: function* () {
      for (let index = 0; index < count; index += 1) {
        pulled.count += 1;
        yield { id: `${recordType}-${index}`, index, ...extra };
      }
    }
  };
}

function drain(stream: Iterator<{ index: number; records: ExportRecord[] }, ExportStreamSummary>) {
  const chunks: ExportRecord[][] = [];
  for (;;) {
    const step = stream.next();
    if (step.done) return { chunks, summary: step.value };
    chunks.push(step.value.records);
  }
}

describe("streamExportRecords", () => {
  beforeEach(() => {
    createExportQuotaStore(createQuotaStore({ storage: createMemoryQuotaStorage() }));
  });

  const request = {
    schemaVersion: EXPORT_CURRENT_SCHEMA_VERSION,
    scope: "own" as const,
    actor: { kind: "user" as const }
  };

  it("streams a large dataset in bounded chunks without loss", () => {
    const pulled = { count: 0 };
    const result = streamExportRecords(request, [lazySource("ops", "own", 20_000, pulled)], { chunkSize: 250 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { chunks, summary } = drain(result.value);
    expect(chunks.every((chunk) => chunk.length <= 250)).toBe(true);
    expect(chunks.flat()).toHaveLength(20_000);
    expect(new Set(chunks.flat().map((record) => record.id)).size).toBe(20_000);
    expect(summary).toEqual({ status: "completed", chunkCount: 80, recordCount: 20_000, fieldsFiltered: 0 });
  });

  it("pulls from the source lazily, one chunk at a time", () => {
    const pulled = { count: 0 };
    const result = streamExportRecords(request, [lazySource("ops", "own", 10_000, pulled)], { chunkSize: 100 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(pulled.count).toBe(0);
    const first = result.value.next();
    expect(first.done).toBe(false);
    expect(pulled.count).toBe(100);
    result.value.next();
    expect(pulled.count).toBe(200);
  });

  it("stops pulling and drops the partial chunk when the signal aborts", () => {
    const pulled = { count: 0 };
    const controller = new AbortController();
    const result = streamExportRecords(request, [lazySource("ops", "own", 10_000, pulled)], {
      chunkSize: 100,
      signal: controller.signal
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const first = result.value.next();
    expect(first.done).toBe(false);
    controller.abort();
    const rest = drain(result.value);

    expect(rest.chunks).toEqual([]);
    expect(rest.summary).toEqual({ status: "cancelled", chunkCount: 1, recordCount: 100, fieldsFiltered: 0 });
    expect(pulled.count).toBeLessThanOrEqual(101);
  });

  it("closes the source when the consumer abandons the stream", () => {
    let closed = false;
    const source: ExportRecordSource = {
      recordType: "ops",
      schemaVersion: EXPORT_CURRENT_SCHEMA_VERSION,
      scope: "own",
      collect: () => [],
      stream: function* () {
        try {
          for (let index = 0; ; index += 1) yield { id: String(index) };
        } finally {
          closed = true;
        }
      }
    };
    const result = streamExportRecords(request, [source], { chunkSize: 10 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    result.value.next();
    result.value.return({ status: "cancelled", chunkCount: 0, recordCount: 0, fieldsFiltered: 0 });
    expect(closed).toBe(true);
  });

  it("refuses unauthorized requests before reading any record", () => {
    const pulled = { count: 0 };
    const sources = [lazySource("report", "maintainer", 10, pulled)];

    expect(streamExportRecords({ ...request, scope: "maintainer" }, sources)).toMatchObject({
      ok: false,
      code: "export_denied"
    });
    expect(streamExportRecords({ ...request, schemaVersion: "0.1" }, sources)).toMatchObject({
      ok: false,
      code: "schema_unsupported"
    });
    expect(
      streamExportRecords({ ...request, fields: ["id", "sessionToken"], strictFields: true }, sources)
    ).toMatchObject({ ok: false, code: "field_authorization_denied" });
    expect(pulled.count).toBe(0);
  });

  it("never streams maintainer-scope sources to a user-scope request", () => {
    const pulled = { count: 0 };
    const result = streamExportRecords(
      request,
      [lazySource("ops", "own", 3, pulled), lazySource("report", "maintainer", 5, pulled)],
      { chunkSize: 2 }
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { chunks } = drain(result.value);
    expect(chunks.flat().map((record) => record.recordType)).toEqual(["ops", "ops", "ops"]);
    expect(pulled.count).toBe(3);
  });

  it("filters forbidden fields and redacts secrets in every chunk", () => {
    const pulled = { count: 0 };
    const result = streamExportRecords(
      request,
      [lazySource("ops", "own", 1_000, pulled, { sessionToken: "tok", ipAddress: "10.0.0.1", note: "ok" })],
      { chunkSize: 128 }
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { chunks, summary } = drain(result.value);
    const records = chunks.flat();
    expect(records).toHaveLength(1_000);
    expect(records.every((record) => !("sessionToken" in record))).toBe(true);
    expect(records.every((record) => record.ipAddress === "[FILTERED: UNAUTHORIZED]")).toBe(true);
    expect(records.every((record) => record.note === "ok")).toBe(true);
    expect(summary.fieldsFiltered).toBe(2_000);
  });

  it("lets a maintainer stream restricted fields", () => {
    const pulled = { count: 0 };
    const result = streamExportRecords(
      { ...request, scope: "maintainer", actor: { kind: "maintainer" } },
      [lazySource("ops", "own", 3, pulled, { nodeId: "node-1" })]
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { chunks } = drain(result.value);
    expect(chunks.flat().every((record) => record.nodeId === "node-1")).toBe(true);
  });

  it("falls back to collect for sources without a stream", () => {
    const source: ExportRecordSource = {
      recordType: "ops",
      schemaVersion: EXPORT_CURRENT_SCHEMA_VERSION,
      scope: "own",
      collect: () => [{ id: "a" }, { id: "b" }, { id: "c" }]
    };
    const result = streamExportRecords(request, [source], { chunkSize: 2 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { chunks, summary } = drain(result.value);
    expect(chunks.map((chunk) => chunk.length)).toEqual([2, 1]);
    expect(summary.status).toBe("completed");
  });
});
