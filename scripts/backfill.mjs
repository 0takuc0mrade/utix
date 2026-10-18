#!/usr/bin/env node
/**
 * Operator-safe backfill CLI (#201).
 *
 * Runs a backfill definition (`core/migration/backfill.ts`) over a JSON file of
 * records. The default is a dry run: nothing is written and the diff is
 * printed. `--apply` writes, saving a checkpoint after every batch so an
 * interrupted run resumes where it stopped.
 *
 * Usage:
 *   npm run backfill -- --input records.json --definition ./my-backfill.mjs
 *   npm run backfill -- --input records.json --definition ./my-backfill.mjs --apply --checkpoint backfill.checkpoint.json
 *   npm run backfill -- --input records.json --definition ./my-backfill.mjs --rollback --checkpoint backfill.checkpoint.json
 *
 * The definition module default-exports `{ id, version, transform }`.
 * `transform(record)` returns `{ ok: true, value }` or `{ ok: false, code }`.
 *
 * Flags: --apply, --restart, --rollback, --batch-size N, --max-failures N,
 * --sample N, --json. The role comes from UTIX_USER_ROLE and needs
 * `admin:recovery` (maintainer). Exits 1 on an error, a halt, or failed records.
 *
 * Safety: before the first write `<input>.bak` is created from the untouched
 * input. Data is flushed to disk before the checkpoint that covers it, so a
 * crash can leave data ahead of the checkpoint (re-applied as "unchanged"), never
 * behind it.
 */

import { copyFile, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const { runBackfill, rollbackBackfill } = await import("../core/migration/backfill.ts");
const { getAuthContext } = await import("../core/auth/middleware.ts");

function parseArgs(argv) {
  const args = { flags: new Set(), values: {} };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`unexpected argument: ${token}`);
    const name = token.slice(2);
    if (["apply", "restart", "rollback", "json"].includes(name)) args.flags.add(name);
    else if (["input", "definition", "checkpoint", "batch-size", "max-failures", "sample"].includes(name)) {
      const value = argv[(index += 1)];
      if (value === undefined) throw new Error(`--${name} needs a value`);
      args.values[name] = value;
    } else throw new Error(`unknown flag: --${name}`);
  }
  return args;
}

function number(value) {
  return value === undefined ? undefined : Number(value);
}

async function writeJsonAtomic(file, value) {
  const temp = `${file}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temp, file);
}

async function main() {
  const { flags, values } = parseArgs(process.argv.slice(2));
  if (!values.input || !values.definition) {
    throw new Error("usage: backfill --input <records.json> --definition <module.mjs> [--apply] [--checkpoint <file>]");
  }
  const inputPath = path.resolve(values.input);
  const apply = flags.has("apply");
  const rollback = flags.has("rollback");
  const checkpointPath = path.resolve(values.checkpoint ?? `${inputPath}.checkpoint.json`);

  const definition = (await import(pathToFileURL(path.resolve(values.definition)).href)).default;
  const records = JSON.parse(await readFile(inputPath, "utf8"));
  if (!Array.isArray(records)) throw new Error("input must be a JSON array of records");
  const byId = new Map(records.map((record) => [record.id, record]));
  if (byId.size !== records.length) throw new Error("input contains duplicate record ids");

  let dirty = false;
  const target = {
    async readBatch(afterId, limit) {
      return [...byId.values()]
        .filter((record) => afterId === null || record.id > afterId)
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .slice(0, limit);
    },
    async write(record) {
      if (!dirty && !existsSync(`${inputPath}.bak`)) await copyFile(inputPath, `${inputPath}.bak`);
      byId.set(record.id, record);
      dirty = true;
    }
  };

  const checkpoints = {
    async load() {
      return existsSync(checkpointPath) ? JSON.parse(await readFile(checkpointPath, "utf8")) : undefined;
    },
    async save(checkpoint, expectedRevision) {
      const current = existsSync(checkpointPath) ? JSON.parse(await readFile(checkpointPath, "utf8")) : undefined;
      if ((current?.revision ?? null) !== expectedRevision) return false;
      // Data first, then the checkpoint that covers it.
      if (dirty) {
        await writeJsonAtomic(inputPath, [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : 1)));
        dirty = false;
      }
      await writeJsonAtomic(checkpointPath, checkpoint);
      return true;
    }
  };

  const { role } = getAuthContext();

  if (rollback) {
    const result = await rollbackBackfill(definition.id, target, checkpoints, { role });
    if (!result.ok) throw new Error(`rollback refused: ${result.code}`);
    console.log(JSON.stringify(result.value, null, 2));
    process.exitCode = result.value.failed.length > 0 ? 1 : 0;
    return;
  }

  const result = await runBackfill(definition, target, {
    role,
    apply,
    restart: flags.has("restart"),
    checkpoints,
    batchSize: number(values["batch-size"]),
    maxFailures: number(values["max-failures"]),
    sampleSize: number(values.sample)
  });
  if (!result.ok) throw new Error(`backfill refused: ${result.code}${result.detail ? ` (${result.detail})` : ""}`);

  const report = result.value;
  if (flags.has("json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`${report.mode === "apply" ? "APPLIED" : "DRY RUN (nothing written; pass --apply)"}: ${report.backfillId}@${report.version}`);
    if (report.resumedAfter) console.log(`resumed after ${report.resumedAfter}`);
    console.log(
      `status=${report.status} scanned=${report.scanned} updated=${report.updated} unchanged=${report.unchanged} ` +
        `skipped=${report.skippedCount} failed=${report.failedCount}`
    );
    for (const diff of report.diffs) console.log(`  ${diff.recordId}: ${JSON.stringify(diff.before)} -> ${JSON.stringify(diff.after)}`);
    for (const skip of report.skipped) console.log(`  skipped ${skip.id}: ${skip.reason}`);
    for (const failure of report.failed) console.log(`  FAILED ${failure.id}: ${failure.error}`);
  }
  process.exitCode = report.status === "halted" || report.failedCount > 0 ? 1 : 0;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
