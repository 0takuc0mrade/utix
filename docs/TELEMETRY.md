# Telemetry & Observability

Every critical path in Utix emits one structured, JSON-parseable record per
operation. The fields are stable so maintainers can correlate failures,
hot spots and unhealthy domain operations across runs without parsing prose.

`core/telemetry/telemetry.ts` is the shared kernel:

- `measure(op, { actorType, correlationId }, fn)` — runs `fn` and emits one
  success/failure record with measured latency. Accepts both thrown errors and
  returned `Result`s in the error position.
- `measureSync(...)` — the synchronous variant.
- `emitTelemetry({...})` — raw emission when neither wrapper fits.
- `setTelemetrySink(...)` / `resetTelemetrySink()` — test seam; the default
  sink writes one JSON line to the console.

## Record shape

Every record carries exactly these fields:

| Field          | Meaning                                                        |
|----------------|----------------------------------------------------------------|
| `op`           | Dot-separated operation, e.g. `horizon.request`                |
| `actorType`    | `user` · `worker` · `client` · `system`                        |
| `result`       | `success` or `failure`                                         |
| `latencyMs`    | Time from start to settle, in milliseconds                     |
| `correlationId`| UUID shared across the requests one action fans out into       |
| `timestamp`    | ISO-8601 emission time                                         |
| `errorCode`    | Present on failure only — stable code, never English string    |
| `payload`      | Optional structured context                                     |

## Instrumented operations

| Path             | Operation names                              |
|------------------|----------------------------------------------|
| request          | `horizon.request`                            |
| Soroban RPC      | `soroban.rpc`                                 |
| wallet           | `wallet.detect`                              |
| worker           | `worker.run`, `worker.retry`, `worker.exhausted` |
| data processing  | `export.generate`, `export.authorize`, `contract.validate` |

`npm run verify:telemetry` fails if fewer than five distinct operations are
instrumented or if an instrumentation site is missing `actorType` /
`correlationId`.

## Correlating Soroban RPC and worker attempts

`sorobanRpc` uses its `correlationId` option as the JSON-RPC `id`; when omitted,
it generates a UUID. This lets the RPC provider's request logs and Utix
telemetry share an identifier without adding a custom HTTP header (which would
trigger a CORS preflight in browser clients). A worker handler should pass its
`WorkerContext.correlationId` to each RPC call it makes. The queue retains that
identifier across retries, so attempts can be grouped even when a transport
failure requires retry or the job reaches the dead-letter store.

The correlation ID is for tracing only, not authorization or idempotency. Do not
use it to authorize a request or to deduplicate side effects. A failed or
malformed RPC response still emits a failure telemetry record with the same ID;
the RPC response envelope and existing error codes remain unchanged.

## Sensitive values

Records are redacted before emission: any value that looks like a Stellar
secret seed (`S…` / `M…`), or sits under a key named `secret`, `seed`, `key`,
`token`, `password` or `passphrase`, becomes `[REDACTED]`. Public keys and
addresses are not secrets and are not redacted — but paths do not log them
unless a failure genuinely needs the context.

## Example line

```json
{"op":"horizon.request","actorType":"client","result":"failure","latencyMs":10012,"correlationId":"8f0c…","timestamp":"2026-09-25T12:00:00.000Z","errorCode":"timeout"}
```

## Suggested dashboard queries

Treat the console sink as the raw stream and proxy it into your log store.
Queries below assume a JSON log explorer that can filter on record fields.

- **Where users fail**
  `result:"failure" AND actorType:user` grouped by `op`, top error codes.
- **Latency spikes**
  `percentile(latencyMs, 0.95) BY op` over the last 24h; alert when
  `horizon.request` p95 exceeds the 10s timeout budget.
- **Unhealthy domain operations**
  `error_rate = count(result:"failure") / count(*) BY op`, alert above 0.05.
- **Worker health**
  `op:"worker.exhausted"` — a rising count means a task is burning through
  its retry budget and heading to the dead-letter store.
- **Wallet reachability**
  `op:"wallet.detect"` grouped by `errorCode`, alerting on
  `not_installed` spikes that track release regressions.