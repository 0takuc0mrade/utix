# Data Export Workflow

`core/export/exporter.ts` is the only sanctioned way to generate structured
exports of operational data. It is privacy-safe by construction:

- **Schema versioning** — every export declares `schemaVersion` (currently
  `1.0`), and generating against an unsupported version fails with
  `schema_unsupported`.
- **Authorization** — exports are scoped. A plain `user` actor may only export
  `scope: "own"` records; `scope: "maintainer"` requires a maintainer actor.
  Anything else returns `export_denied` and records are filtered so a user
  never sees maintainer-only sources.
- **Retention** — every envelope carries `expiresAt`
  (`generatedAt + EXPORT_DEFAULT_TTL_MS`, override with `ttlMs`). Check
  `isExportExpired(envelope)` before serving a stored artifact.
- **Redaction** — secret-shaped values (`S…`/`M…& seeds, keys named
  `secret`/`seed`/`key`/`token`) become `[REDACTED]` before emission.
- **Idempotency** — pass `idempotencyKey` and a retried request replays the
  recorded envelope instead of minting a second artifact. See
  [IDEMPOTENCY.mdd](Lidempotency.md).

## Generating an export

```ts
import { exportRecords, EXPORT_CURRENT_SCHEMA_VERSION } from "@/core/export/exporter";

const result = exportRecords(
  {
    schemaVersion: EXPORT_CURRENT_SCHEMA_VERSION,
    scope: "own",
    actor: { kind: "user" },
    pageSize: 100,
    page: 1,
    // Optional, but required for any caller that can retry: a repeated request
    // with the same key returns this same envelope.
    idempotencyKey: "export:demo:1"
  },
  mySources // ExportRecordSource[]
);
```

For consumers that page through changing collections, pass the returned
`nextCursor` on the next request instead of calculating an offset:

```ts
const next = exportRecords(
  { ...request, pageSize: 100, cursor: first.value.nextCursor ?? undefined },
  mySources
);
```

The cursor is anchored to a record key, so inserting records before the
anchor does not repeat the current page. The legacy `page` field remains
available for offset-based callers. Filtering by authorization happens before cursor keys are generated, so a cursor cannot cross an authorization scope.

A source supplies records and declares its own scope:

```ts
const source = {
  recordType: "operation_log",
  schemaVersion: EXPORT_CURRENT_SCHEMA_VERSION,
  scope: "own",
  collect: () => telemetryEvents
};
```

## Streaming large exports

`streamExportRecords(request, sources, { chunkSize, signal })` applies the same
authorization, schema, strict-field, quota, field-level filtering and redaction
rules as `exportRecords`, but pulls records lazily and yields bounded chunks, so
memory stays at one chunk (default 500 records) regardless of dataset size.

```ts
const stream = streamExportRecords(request, sources, { chunkSize: 500, signal });
if (!stream.ok) return stream; // refused before any record is read
for (const chunk of stream.value) send(chunk.records);
```

A source may add `stream: () => Iterable<ExportRecord>` so the data is never
materialised; without it the stream falls back to `collect`.

- **Cancellation.** Abort the `signal`, or stop iterating (`break` / `return()`).
  No further record is pulled, the unfinished buffer is dropped and the
  source iterator is closed. The generator returns
  `{ status: "cancelled", recordCount, ... }` counting only chunks already
  handed out.
- **Audit.** One `export.generated` event is written when the stream ends,
  whether completed or cancelled (`cancelled` in the context). A stream that is
  never iterated writes none, but its quota charge is spent.
- **Not an artifact.** There is no envelope, expiry or idempotency key. A
  consumer that needs a retry-safe artifact keeps using `exportRecords`.
- **Mid-stream failure.** If a source throws, the generator throws after
  the chunks already delivered; start a new stream to retry, nothing is persisted.

## Testing

`npm run test` covers large exports (5 500 records, paged without loss), empty
exports, denied (`export_denied`) and unsupported-version exports, redaction,
and retention expiry — see `core/export/__tests__/exporter.test.ts`. Trend
aggregation, date ranges, empty data, permission denial and a 5 000 event paged export are covered in `core/export/__tests__/trends.test.ts`.

### Sensitive-content boundary tests

`core/export/__tests__/sensitiveContent.test.ts` exercises the export boundary
against hostile input. It asserts that untrusted record content cannot:

- **Execute** — values containing HTML/script payloads, `javascript:` URLs and
  template syntax are emitted as inert data (never evaluated, never rendered as
  markup by the exporter).
- **Escape sandboxing** — nested objects, arrays and prototype-pollution keys
  (`__proto__`, `constructor`, `prototype`) are rejected or neutralised by the
  strict-field filter rather than merged into the envelope.
- **Leak private fields** — maintainer-only sources stay invisible to `user`
  actors, and fields outside the allow-list are dropped before emission.
- **Bypass allow-lists** — unknown record types, unexpected fields and
  out-of-scope cursors are refused with the documented error codes.

Run just this suite with `npm run test -- sensitiveContent`.

### Operational edge cases and failure modes

- **Redaction gaps.** Redaction is pattern-based; a secret that does not match
  the `S…`/`M…& shape or a known key name is not caught. Treat exports as
  sensitive and review new record types before enabling them.
- **Allow-list drift.** Adding a field to a source without updating the
  allow-list silently drops it. The boundary tests fail loudly when a source
  emits a field the exporter does not expect.
- **Cursor tampering.** A cursor minted under one authorization scope is
  rejected when replayed under another; callers must not persist cursors across
  actors.
- **Mid-stream failure.** A throwing source aborts the stream after delivered
  chunks; nothing is persisted, so recovery is to start a new stream.

### Rollback / recovery

- Exports are derived artifacts: to recover from a bad export, discard the
  envelope (or let it expire via `expiresAt`) and regenerate from source. No
  source data is mutated by export.
- If a redaction or allow-list regression ships, revert the exporter change and
  invalidate stored artifacts by bumping `schemaVersion`; consumers on the old
  version receive `schema_unsupported` and must regenerate.
- Idempotency records are keyed by `idempotencyKey`; to force a fresh artifact
  after a rollback, use a new key rather than replaying the poisoned one.

Each export emits `export.generate` and `export.authorize` telemetry; see
[docs/TELEMETRY.md](./TELEMETRY.md).

Streaming, lazy pulling, cancellation and forbidden fields are covered in
`core/export/__tests__/exportStream.test.ts`.
