# External reference verification (#188)

`verifyReference(reference, deps)` in `core/references/verification.ts` checks a URI the protocol depends on but does not host, and always settles on a `VerificationRecord` (it never throws).

## Contract

The fetcher is injected and must resolve with `{ contentHash, observedAt }` (ISO timestamp). Only `https:` and `ipfs:` URIs are fetched.

| Outcome | Code | Retried |
| --- | --- | --- |
| verified | none | n/a |
| unsupported URI | `invalid_reference` | no |
| no answer in `timeoutMs` (fetch is aborted) | `timeout` | yes |
| fetcher threw | `unreachable` | yes |
| wrong shape | `malformed_response` | no |
| `observedAt` older than `maxStalenessMs` | `stale_response` | no |
| differs from `expectedHash` | `hash_mismatch` | no |

Transient failures are retried up to `maxAttempts` with exponential backoff (`baseDelayMs`, doubled each time, capped at `maxDelayMs`). Defaults: 3 attempts, 5s timeout, 200ms base, 2s cap, 24h staleness. Retrying a malformed, stale, or mismatching response cannot help, so those fail at once.

## Persisted result

Each record stores `status`, `attempts`, `checkedAt`, `source` (`kind`, `uri`) and either the `contentHash` or a `failure` with `code`, `message`, a maintainer `action`, and `retriesExhausted`. Pass a `VerificationStore` (`createVerificationStore()` is in-memory) to keep the latest record per reference.
