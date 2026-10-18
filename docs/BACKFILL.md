# Operator-Safe Backfill

`core/migration/backfill.ts` rewrites existing records to a new shape in a way
an operator can preview, interrupt, resume and undo. `scripts/backfill.mjs` is
the command line front end for a JSON file of records.

## Running a backfill

A backfill is a definition plus a target:

```js
// my-backfill.mjs
export default {
  id: "label-normalise", // also the checkpoint key
  version: "1", // bump whenever transform changes
  transform(record) {
    if (record.label === undefined) return { ok: false, code: "missing_label" }; // skipped
    return { ok: true, value: { ...record, schema: 2, label: record.label.trim().toLowerCase() } };
  }
};
```

`transform` must keep `id` and must be idempotent: transforming its own output
returns the same record.

```sh
# 1. Preview. Writes nothing. Prints counts and a sample of before/after diffs.
UTIX_USER_ROLE=maintainer npm run backfill -- --input records.json --definition ./my-backfill.mjs

# 2. Apply. Checkpoints after every batch; resumes automatically if run again.
UTIX_USER_ROLE=maintainer npm run backfill -- --input records.json --definition ./my-backfill.mjs --apply

# 3. Undo.
UTIX_USER_ROLE=maintainer npm run backfill -- --input records.json --definition ./my-backfill.mjs --rollback
```

Other flags: `--checkpoint <file>` (default `<input>.checkpoint.json`),
`--restart`, `--batch-size N` (default 100), `--max-failures N` (default 10),
`--sample N` (diffs shown, default 20), `--json`. The command needs the
`admin:recovery` permission (`maintainer`). It exits 1 on a refusal, a halt, or
any failed record.

In code, call `runBackfill(definition, target, { role, apply, checkpoints })` with
a `BackfillTarget` (`readBatch`, `write`) and a `CheckpointStore`
(`load`, compare-and-set `save`). `createMemoryBackfillTarget` and
`createMemoryCheckpointStore` are the reference implementations.

## What the report says

| Field | Meaning |
| --- | --- |
| `updated` | Records changed (dry run: records that would change) |
| `unchanged` | Transform returned the record as it was; not written |
| `skippedCount` / `skipped` | Records the transform declined, with its reason |
| `failedCount` / `failed` | Transform threw, changed the id, or the write failed |
| `diffs` | Bounded sample of changes; values are redacted for display |
| `resumedAfter` | The id a resumed run continued after |

`skipped` and `failed` list the first 1 000 entries; the counts are exact.

## Safety properties

- **Dry run is the default** and always scans from the start, ignoring any
  checkpoint, so the diff is complete.
- **Resume.** A checkpoint is saved after every batch. Running the same command
  again continues after the last committed record. A checkpoint from another
  `version` is refused (`backfill_version_mismatch`).
- **Idempotent.** Already-converted records come back `unchanged` and are not
  rewritten, so re-running is cheap and safe.
- **One operator at a time.** Saves are compare-and-set on a revision. The
  second of two simultaneous runs stops with `backfill_checkpoint_conflict`.
- **Failure budget.** The run halts at the end of the batch in which more than
  `--max-failures` records failed since it started. Skips do not count.

## Edge cases and failure modes

| Situation | What happens | What to do |
| --- | --- | --- |
| Source read fails mid-run | `backfill_source_unavailable`; checkpoint kept as `halted` | Fix the source, run the same command |
| Source returns ids out of order | `backfill_source_unavailable`; run stops | Fix the source ordering (ascending by `id`) |
| Crash between a write and its checkpoint | Up to one batch was written but not journaled; on resume those records read as `unchanged` | Restore those from the backup (see below) if you need to undo |
| Transform bug found after a partial run | Records already written keep the old transform's output | Fix, bump `version`, run with `--restart`; earlier before-images are kept |
| Run already completed | `backfill_already_completed` | `--restart` to rescan (it will write nothing if nothing changed) |
| Failed records | Reported, left unchanged, not retried on resume | Fix the cause, then `--restart`; unchanged records are skipped quickly |
| Two operators | Second gets `backfill_checkpoint_conflict` | Let the first finish, then resume |
| Wrong role | `backfill_unauthorized` | Run as a maintainer |

## Rollback and recovery

1. **Journal.** Every applied update records the record's before-image in the
   checkpoint. `--rollback` (or `rollbackBackfill`) writes them back, newest
   first, removes each restored entry, and marks the checkpoint `rolled_back`.
   Entries that fail to restore stay journaled, so rollback can be re-run.
2. **Overwrite warning.** Rollback restores whole records. Changes made to
   those records after the backfill are lost; check before rolling back.
3. **Backup.** Before the first write the CLI copies the input to
   `<input>.bak`. It is the recovery path for the one case the journal cannot
   cover (a crash mid-batch) and for a corrupt checkpoint.
4. **Checkpoint file.** It holds full before-images, so protect it like the
   data. If it is lost, restore from `.bak`.
5. **Rolled back or completed backfills** are not re-run silently; use
   `--restart`. A restart keeps the earlier journal.

## Compatibility

Additive only. No existing API, schema or user-facing behavior changes, and the
CLI never touches data unless `--apply` or `--rollback` is passed. No migration
is required.

## Tests

`core/migration/__tests__/backfill.test.ts` covers the dry run (no writes, no
checkpoint, bounded and redacted diffs), apply and idempotent re-run, resume
after a source failure, version mismatch, concurrent operators, skipped and
failed records, the failure limit, out-of-order sources and rollback.
