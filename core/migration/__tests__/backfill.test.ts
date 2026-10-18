import { describe, expect, it } from "vitest";
import {
  createMemoryBackfillTarget,
  createMemoryCheckpointStore,
  rollbackBackfill,
  runBackfill,
  type BackfillDefinition,
  type BackfillRecord,
  type BackfillTarget
} from "../backfill";
import { err, ok } from "@/core/result/result";

interface Row extends BackfillRecord {
  readonly id: string;
  readonly schema: number;
  readonly label?: string;
}

const NOW = Date.parse("2026-10-18T00:00:00.000Z");
const clock = () => NOW;

/** r-01..r-10 on the old schema, plus rows the transform must skip, leave alone, or choke on. */
function fixture(): Row[] {
  const rows: Row[] = Array.from({ length: 10 }, (_, index) => ({
    id: `r-${String(index + 1).padStart(2, "0")}`,
    schema: 1,
    label: `  Label ${index + 1} `
  }));
  rows.push({ id: "r-11", schema: 1 }); // no label: skipped
  rows.push({ id: "r-12", schema: 2, label: "done" }); // already migrated: unchanged
  return rows;
}

const definition: BackfillDefinition<Row> = {
  id: "label-normalise",
  version: "1",
  transform: (row) => {
    if (row.label === undefined) return err("missing_label");
    if (row.id === "r-poison") throw new Error("boom for G-secret-token");
    return ok({ ...row, schema: 2, label: row.label.trim().toLowerCase() });
  }
};

function counting(target: BackfillTarget<Row>) {
  const writes: string[] = [];
  let reads = 0;
  const wrapped: BackfillTarget<Row> = {
    readBatch: (afterId, limit) => {
      reads += 1;
      return target.readBatch(afterId, limit);
    },
    write: async (record) => {
      writes.push(record.id);
      return target.write(record);
    }
  };
  return { wrapped, writes, reads: () => reads };
}

const maintainer = { role: "maintainer" } as const;

describe("dry run", () => {
  it("previews changes without writing or checkpointing", async () => {
    const target = createMemoryBackfillTarget(fixture());
    const store = createMemoryCheckpointStore<Row>();

    const result = await runBackfill(definition, target, { ...maintainer, batchSize: 4, sampleSize: 3, checkpoints: store });
    if (!result.ok) throw new Error(result.code);
    const report = result.value;

    expect(report).toMatchObject({
      mode: "dry_run",
      status: "completed",
      scanned: 12,
      updated: 10,
      unchanged: 1,
      skippedCount: 1,
      failedCount: 0,
      checkpointRevision: null
    });
    expect(report.skipped).toEqual([{ id: "r-11", reason: "missing_label" }]);
    expect(report.diffs).toHaveLength(3);
    expect(report.diffs[0]).toMatchObject({
      recordId: "r-01",
      action: "update",
      before: { schema: 1, label: "  Label 1 " },
      after: { schema: 2, label: "label 1" }
    });
    expect(target.records()).toEqual(fixture());
    expect(await store.load(definition.id)).toBeUndefined();
  });

  it("redacts secret-shaped values in the diff sample", async () => {
    const secret = "S" + "A".repeat(55);
    const target = createMemoryBackfillTarget<Row>([{ id: "r-01", schema: 1, label: secret }]);
    const result = await runBackfill(definition, target, maintainer);
    if (!result.ok) throw new Error(result.code);
    expect(JSON.stringify(result.value.diffs)).not.toContain(secret);
  });
});

describe("option and permission checks", () => {
  it("refuses roles without admin:recovery", async () => {
    for (const role of ["viewer", "service"] as const) {
      const result = await runBackfill(definition, createMemoryBackfillTarget(fixture()), { role });
      expect(result).toMatchObject({ ok: false, code: "backfill_unauthorized" });
    }
  });

  it("refuses to apply without a checkpoint store and rejects bad numbers", async () => {
    const target = createMemoryBackfillTarget(fixture());
    expect(await runBackfill(definition, target, { ...maintainer, apply: true })).toMatchObject({
      ok: false,
      code: "backfill_invalid_options"
    });
    for (const bad of [{ batchSize: 0 }, { batchSize: 1.5 }, { maxFailures: -1 }, { sampleSize: -1 }]) {
      expect(await runBackfill(definition, target, { ...maintainer, ...bad })).toMatchObject({
        ok: false,
        code: "backfill_invalid_options"
      });
    }
    expect(target.records()).toEqual(fixture());
  });
});

describe("apply", () => {
  it("writes each changed record once, checkpoints per batch, and is idempotent", async () => {
    const target = createMemoryBackfillTarget(fixture());
    const spy = counting(target);
    const store = createMemoryCheckpointStore<Row>();

    const first = await runBackfill(definition, spy.wrapped, { ...maintainer, apply: true, checkpoints: store, batchSize: 5, now: clock });
    if (!first.ok) throw new Error(first.code);
    expect(first.value).toMatchObject({ mode: "apply", status: "completed", scanned: 12, updated: 10, unchanged: 1, skippedCount: 1 });
    expect(first.value.checkpointRevision).toBe(3); // 12 rows in batches of 5, 5, 2
    expect(spy.writes).toHaveLength(10);
    expect(target.records().filter((row) => row.schema === 2)).toHaveLength(11);
    expect(target.records().find((row) => row.id === "r-01")).toEqual({ id: "r-01", schema: 2, label: "label 1" });

    const saved = await store.load(definition.id);
    expect(saved).toMatchObject({ status: "completed", lastId: "r-12", updated: 10, updatedAt: "2026-10-18T00:00:00.000Z" });
    expect(saved!.journal).toHaveLength(10);

    // A completed backfill is not silently run again...
    expect(await runBackfill(definition, spy.wrapped, { ...maintainer, apply: true, checkpoints: store })).toMatchObject({
      ok: false,
      code: "backfill_already_completed"
    });
    // ...but a deliberate restart finds nothing left to write.
    const again = await runBackfill(definition, spy.wrapped, { ...maintainer, apply: true, checkpoints: store, restart: true });
    if (!again.ok) throw new Error(again.code);
    expect(again.value).toMatchObject({ updated: 0, unchanged: 11, skippedCount: 1 });
    expect(spy.writes).toHaveLength(10);
    // The restart keeps the first run's before-images, so rollback still works.
    expect((await store.load(definition.id))!.journal).toHaveLength(10);
  });

  it("resumes after the last committed batch when the source drops mid-run", async () => {
    const target = createMemoryBackfillTarget(fixture());
    const spy = counting(target);
    const store = createMemoryCheckpointStore<Row>();
    let calls = 0;
    const flaky: BackfillTarget<Row> = {
      readBatch: (afterId, limit) => {
        calls += 1;
        if (calls === 3) return Promise.reject(new Error("connection reset"));
        return spy.wrapped.readBatch(afterId, limit);
      },
      write: spy.wrapped.write
    };

    const interrupted = await runBackfill(definition, flaky, { ...maintainer, apply: true, checkpoints: store, batchSize: 4 });
    expect(interrupted).toMatchObject({ ok: false, code: "backfill_source_unavailable" });
    const midway = await store.load(definition.id);
    expect(midway).toMatchObject({ status: "halted", lastId: "r-08", scanned: 8 });
    expect(spy.writes).toEqual(["r-01", "r-02", "r-03", "r-04", "r-05", "r-06", "r-07", "r-08"]);

    const resumed = await runBackfill(definition, flaky, { ...maintainer, apply: true, checkpoints: store, batchSize: 4 });
    if (!resumed.ok) throw new Error(resumed.code);
    expect(resumed.value).toMatchObject({ status: "completed", resumedAfter: "r-08", scanned: 12, updated: 10 });
    // Each record was written exactly once across both runs.
    expect(spy.writes).toEqual(["r-01", "r-02", "r-03", "r-04", "r-05", "r-06", "r-07", "r-08", "r-09", "r-10"]);

    const complete = createMemoryBackfillTarget(fixture());
    await runBackfill(definition, complete, { ...maintainer, apply: true, checkpoints: createMemoryCheckpointStore<Row>() });
    expect(target.records()).toEqual(complete.records());
  });

  it("refuses to resume a checkpoint from a different transform version", async () => {
    const target = createMemoryBackfillTarget(fixture());
    const store = createMemoryCheckpointStore<Row>();
    let calls = 0;
    const flaky: BackfillTarget<Row> = {
      readBatch: (afterId, limit) => (++calls === 2 ? Promise.reject(new Error("down")) : target.readBatch(afterId, limit)),
      write: target.write
    };
    await runBackfill(definition, flaky, { ...maintainer, apply: true, checkpoints: store, batchSize: 4 });

    const changed = { ...definition, version: "2" };
    expect(await runBackfill(changed, target, { ...maintainer, apply: true, checkpoints: store })).toMatchObject({
      ok: false,
      code: "backfill_version_mismatch"
    });
  });

  it("stops the second of two simultaneous operators instead of letting both advance", async () => {
    const target = createMemoryBackfillTarget(fixture());
    const store = createMemoryCheckpointStore<Row>();
    const run = () => runBackfill(definition, target, { ...maintainer, apply: true, checkpoints: store });

    const outcomes = await Promise.all([run(), run()]);
    expect(outcomes.map((outcome) => (outcome.ok ? "ok" : outcome.code))).toEqual(["ok", "backfill_checkpoint_conflict"]);
    expect(await store.load(definition.id)).toMatchObject({ revision: 1, status: "completed" });
  });
});

describe("skipped and failed records", () => {
  const rows = (): Row[] => [
    { id: "a-1", schema: 1, label: "One" },
    { id: "a-2", schema: 1 },
    { id: "r-poison", schema: 1, label: "Bad" },
    { id: "z-1", schema: 1, label: "Last" }
  ];

  it("reports skipped and failed records and keeps going below the failure limit", async () => {
    const target = createMemoryBackfillTarget(rows());
    const result = await runBackfill(definition, target, { ...maintainer, apply: true, checkpoints: createMemoryCheckpointStore<Row>() });
    if (!result.ok) throw new Error(result.code);

    expect(result.value).toMatchObject({ status: "completed", scanned: 4, updated: 2, skippedCount: 1, failedCount: 1 });
    expect(result.value.skipped).toEqual([{ id: "a-2", reason: "missing_label" }]);
    expect(result.value.failed).toHaveLength(1);
    expect(result.value.failed[0].id).toBe("r-poison");
    expect(target.records().find((row) => row.id === "r-poison")!.schema).toBe(1);
  });

  it("halts after the batch that exceeds maxFailures and resumes past it", async () => {
    const target = createMemoryBackfillTarget(rows());
    const store = createMemoryCheckpointStore<Row>();
    const options = { ...maintainer, apply: true, checkpoints: store, batchSize: 3, maxFailures: 0 } as const;

    const halted = await runBackfill(definition, target, options);
    if (!halted.ok) throw new Error(halted.code);
    expect(halted.value).toMatchObject({ status: "halted", lastId: "r-poison", failedCount: 1 });
    expect(await store.load(definition.id)).toMatchObject({ status: "halted" });

    const resumed = await runBackfill(definition, target, options);
    if (!resumed.ok) throw new Error(resumed.code);
    expect(resumed.value).toMatchObject({ status: "completed", resumedAfter: "r-poison", scanned: 4 });
  });

  it("counts a failed write as failed and does not journal it", async () => {
    const inner = createMemoryBackfillTarget(fixture());
    const target: BackfillTarget<Row> = {
      readBatch: inner.readBatch,
      write: (record) => (record.id === "r-03" ? Promise.reject(new Error("disk full")) : inner.write(record))
    };
    const store = createMemoryCheckpointStore<Row>();
    const result = await runBackfill(definition, target, { ...maintainer, apply: true, checkpoints: store });
    if (!result.ok) throw new Error(result.code);

    expect(result.value).toMatchObject({ updated: 9, failedCount: 1 });
    expect(result.value.failed).toEqual([{ id: "r-03", error: "disk full" }]);
    expect((await store.load(definition.id))!.journal.map((entry) => entry.id)).not.toContain("r-03");
    expect(inner.records().find((row) => row.id === "r-03")!.schema).toBe(1);
  });

  it("stops when the source returns records out of order", async () => {
    const store = createMemoryCheckpointStore<Row>();
    const target: BackfillTarget<Row> = {
      readBatch: async () => [
        { id: "b", schema: 1, label: "B" },
        { id: "a", schema: 1, label: "A" }
      ],
      write: async () => undefined
    };
    expect(await runBackfill(definition, target, { ...maintainer, apply: true, checkpoints: store })).toMatchObject({
      ok: false,
      code: "backfill_source_unavailable"
    });
  });
});

describe("rollback", () => {
  it("restores every journaled before-image and marks the checkpoint rolled back", async () => {
    const target = createMemoryBackfillTarget(fixture());
    const store = createMemoryCheckpointStore<Row>();
    await runBackfill(definition, target, { ...maintainer, apply: true, checkpoints: store });
    expect(target.records()).not.toEqual(fixture());

    const result = await rollbackBackfill(definition.id, target, store, { role: "maintainer" });
    if (!result.ok) throw new Error(result.code);
    expect(result.value).toEqual({ backfillId: definition.id, restored: 10, failed: [] });
    expect(target.records()).toEqual(fixture());
    expect(await store.load(definition.id)).toMatchObject({ status: "rolled_back", journal: [] });
  });

  it("keeps unrestored entries journaled so rollback can be re-run", async () => {
    const inner = createMemoryBackfillTarget(fixture());
    const store = createMemoryCheckpointStore<Row>();
    await runBackfill(definition, inner, { ...maintainer, apply: true, checkpoints: store });

    let broken = true;
    const flaky: BackfillTarget<Row> = {
      readBatch: inner.readBatch,
      write: (record) => (broken && record.id === "r-05" ? Promise.reject(new Error("locked")) : inner.write(record))
    };
    const first = await rollbackBackfill(definition.id, flaky, store, { role: "maintainer" });
    if (!first.ok) throw new Error(first.code);
    expect(first.value.restored).toBe(9);
    expect(first.value.failed).toEqual([{ id: "r-05", error: "locked" }]);
    expect(await store.load(definition.id)).toMatchObject({ status: "completed" });

    broken = false;
    const second = await rollbackBackfill(definition.id, flaky, store, { role: "maintainer" });
    if (!second.ok) throw new Error(second.code);
    expect(second.value).toMatchObject({ restored: 1, failed: [] });
    expect(inner.records()).toEqual(fixture());
  });

  it("needs a checkpoint and the right role", async () => {
    const target = createMemoryBackfillTarget(fixture());
    const store = createMemoryCheckpointStore<Row>();
    expect(await rollbackBackfill("missing", target, store, { role: "maintainer" })).toMatchObject({
      ok: false,
      code: "backfill_no_checkpoint"
    });
    expect(await rollbackBackfill("missing", target, store, { role: "viewer" })).toMatchObject({
      ok: false,
      code: "backfill_unauthorized"
    });
  });
});
