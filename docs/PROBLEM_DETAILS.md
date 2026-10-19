# Problem Details Taxonomy

Utix uses a stable machine-code taxonomy for all API errors, following
[RFC 7807 Problem Details for HTTP APIs](https://www.rfc-editor.org/rfc/rfc7807).
This document is the single source of truth for the taxonomy, the wire shape,
the stability contract, and the operational edge cases.

Drift tests in `core/errors/__tests__/problem-details.contract.test.ts` enforce
that nothing here changes accidentally.

## Wire shape — `ProblemDetails`

Every error response carries this shape:

```json
{
  "type":          "https://utix.dev/problems/account-not-found",
  "title":         "Stellar Account Not Found",
  "status":        404,
  "detail":        "No account exists at this address on the selected network.",
  "code":          "account_not_found",
  "retryable":     false,
  "hint":          "Verify the address and the active network (mainnet vs testnet)…",
  "correlationId": "550e8400-e29b-41d4-a716-446655440000",
  "instance":      "/tools/balance-viewer?address=G…",
  "extensions":    { "network": "testnet" }
}
```

| Field           | Required | Type      | Notes                                        |
|-----------------|----------|-----------|----------------------------------------------|
| `type`          | ✓        | `string`  | Absolute URI; stable across releases.         |
| `title`         | ✓        | `string`  | Short summary. May change in future releases. |
| `status`        | ✓        | `number`  | HTTP status code (400–599).                  |
| `detail`        | ✓        | `string`  | Safe, sanitised, instance-specific message.  |
| `code`          | ✓        | `string`  | Stable lowercase_snake identifier.           |
| `retryable`     | ✓        | `boolean` | Whether repeating the request is safe.       |
| `hint`          | ✓        | `string`  | Actionable remediation for developers.       |
| `correlationId` | —        | `string`  | Passed through from the transport layer.     |
| `instance`      | —        | `string`  | URI to the resource that triggered the error.|
| `extensions`    | —        | `object`  | Non-breaking open-ended additions.           |

### Stability contract

- The seven **required** fields will never be removed or change type.
- `code` values are **permanent**. To evolve meaning, add a new code.
- `type` URIs are **permanent** and resolve to this documentation.
- `hint` and `detail` text may be improved over time, but semantics are stable.
- `extensions` fields are additive; consumers must ignore unknown keys.

## Code taxonomy

All codes are `lowercase_snake`. The full set lives in
`core/errors/problem-details.ts` → `PROBLEM_CODES`.

### Validation (400)

| Code                    | Title                       | Retryable |
|-------------------------|-----------------------------|-----------|
| `validation_error`      | Validation Error            | no        |
| `invalid_address`       | Invalid Stellar Address     | no        |
| `invalid_amount`        | Invalid Amount              | no        |
| `invalid_asset_code`    | Invalid Asset Code          | no        |
| `missing_required_field`| Missing Required Field      | no        |

### Stellar Account (400/404)

| Code                      | Title                        | Retryable |
|---------------------------|------------------------------|-----------|
| `account_not_found`       | Stellar Account Not Found    | no        |
| `account_unfunded`        | Account Not Funded           | no        |
| `account_merge_ineligible`| Account Merge Ineligible     | no        |

### Stellar Asset / Trustline (400/404)

| Code                     | Title                          | Retryable |
|--------------------------|--------------------------------|-----------|
| `asset_not_found`        | Asset Not Found                | no        |
| `trustline_missing`      | Trustline Missing              | no        |
| `trustline_limit_exceeded`| Trustline Limit Exceeded      | no        |
| `trustline_no_issuer`    | Trustline Issuer Not Found     | no        |

### Stellar Transaction (400/404)

| Code                     | Title                          | Retryable |
|--------------------------|--------------------------------|-----------|
| `transaction_not_found`  | Transaction Not Found          | no        |
| `transaction_malformed`  | Transaction Malformed          | no        |
| `transaction_failed`     | Transaction Failed             | no        |
| `sequence_mismatch`      | Sequence Number Mismatch       | **yes**   |
| `insufficient_fee`       | Insufficient Fee               | no        |
| `precondition_failed`    | Precondition Failed            | no        |

### Soroban / Smart Contract (400/404/500)

| Code                           | Title                              | Retryable |
|--------------------------------|------------------------------------|-----------|
| `soroban_simulation_failed`    | Soroban Simulation Failed          | no        |
| `soroban_invocation_failed`    | Soroban Contract Invocation Failed | no        |
| `soroban_resource_limit_exceeded`| Soroban Resource Limit Exceeded  | no        |
| `soroban_contract_not_found`   | Soroban Contract Not Found         | no        |
| `xdr_decode_error`             | XDR Decode Error                   | no        |
| `xdr_encode_error`             | XDR Encode Error                   | no        |

### Horizon Transport (400/404/429/503/504)

| Code                        | Title                          | Retryable |
|-----------------------------|--------------------------------|-----------|
| `horizon_not_found`         | Horizon: Resource Not Found    | no        |
| `horizon_rate_limited`      | Horizon: Rate Limited          | **yes**   |
| `horizon_bad_request`       | Horizon: Bad Request           | no        |
| `horizon_server_error`      | Horizon: Server Error          | **yes**   |
| `horizon_network_unavailable`| Horizon: Network Unavailable  | **yes**   |
| `horizon_timeout`           | Horizon: Request Timeout       | **yes**   |
| `horizon_unknown`           | Horizon: Unknown Error         | no        |

### Soroban RPC Transport (400/404/503/504)

| Code                       | Title                           | Retryable |
|----------------------------|---------------------------------|-----------|
| `rpc_parse_error`          | RPC: Parse Error                | no        |
| `rpc_invalid_request`      | RPC: Invalid Request            | no        |
| `rpc_method_not_found`     | RPC: Method Not Found           | no        |
| `rpc_invalid_params`       | RPC: Invalid Parameters         | no        |
| `rpc_server_error`         | RPC: Server Error               | **yes**   |
| `rpc_network_unavailable`  | RPC: Network Unavailable        | **yes**   |
| `rpc_timeout`              | RPC: Request Timeout            | **yes**   |
| `rpc_unknown`              | RPC: Unknown Error              | no        |

### Internal (500)

| Code             | Title          | Retryable |
|------------------|----------------|-----------|
| `internal_error` | Internal Error | **yes**   |

## Public API entry points

### `problemDetailsFromCode(code, options?)`

```ts
import { problemDetailsFromCode } from "@/core/errors/problem-details";

const pd = problemDetailsFromCode("account_not_found", {
  correlationId: "cid-123",
  instance: "/tools/balance-viewer?address=GABC…",
  extensions: { network: "testnet" }
});
```

### `horizonToProblemDetails(classified, options?)`

Bridges a `HorizonErrorClassification` (from `classifyHorizonError`) into a
`ProblemDetails` envelope without forwarding any raw Horizon error text.

```ts
import { classifyHorizonError } from "@/core/horizon/errors";
import { horizonToProblemDetails } from "@/core/errors/problem-details";

try {
  const data = await horizonClient.accounts().accountId(address).call();
} catch (err) {
  const classified = classifyHorizonError(err);
  const pd = horizonToProblemDetails(classified, { instance: "/tools/balance-viewer" });
  // pd.code === "horizon_not_found", pd.retryable === false, etc.
}
```

### `rpcToProblemDetails(classified, options?)`

Bridges a `RpcErrorClassification` (from `classifyRpcError` or
`classifyRpcTransportError`) into a `ProblemDetails` envelope.

```ts
import { classifyRpcError, classifyRpcTransportError } from "@/core/rpc/errors";
import { rpcToProblemDetails } from "@/core/errors/problem-details";
import { isRpcFailure, sorobanRpc } from "@/core/rpc/client";

const response = await sorobanRpc<SimulateTransactionResult>("simulateTransaction", params);
if (isRpcFailure(response)) {
  const classified = classifyRpcError(response);
  const pd = rpcToProblemDetails(classified);
}
```

## Safe-message invariants

1. **No user input is echoed.** The `detail` and `hint` fields are always
   derived from the taxonomy, not from user-supplied values.
2. **No raw transport errors are forwarded.** `classifyHorizonError` and
   `classifyRpcError` discard the raw server error text; only the safe taxonomy
   message is surfaced.
3. **`rawCode`** in `RpcErrorClassification` is for internal logging only and
   must never be rendered in user-facing UI.

## Operational edge cases

### Horizon `unknown` code

`classifyHorizonError` assigns `code: "unknown"` when no HTTP status is
available and the error message does not match known patterns. This maps to
`horizon_unknown` in the problem-details taxonomy.

**Action:** Log the `correlationId`, check Horizon network status, and treat it
as non-retryable until the root cause is identified.

### Soroban simulation failures vs invocation failures

`soroban_simulation_failed` (status 400) means the RPC node rejected the
transaction during preflight — the transaction was never applied. This is always
non-retryable without changing the transaction.

`soroban_invocation_failed` means the contract trapped at runtime. Inspect the
diagnostic events for the specific trap code.

### Sequence mismatch (`sequence_mismatch`)

This is the only transaction-construction code marked `retryable: true`. After
a 400 with this code, fetch the account's current sequence number, rebuild the
transaction, and resubmit. Do **not** simply increment the sequence; always
fetch the latest from Horizon.

### RPC timeout vs network unavailable

`rpc_timeout` indicates the node was reachable but did not respond in time.
`rpc_network_unavailable` indicates a pre-flight failure (DNS, TCP connect).
Both are retryable; `rpc_timeout` may benefit from a longer client timeout.

### Rate limiting (`horizon_rate_limited`)

Horizon returns HTTP 429. The `retryable: true` flag indicates the request
can be repeated after a back-off. Use an exponential back-off with jitter.
The Horizon Health tool shows real-time rate-limit thresholds.

## Failure modes and rollback

### Rolling back the taxonomy (removing a code)

**Never remove a code once it is shipped.** Downstream consumers may
`switch` on the `code` field; a missing case will fall through to their default
handler, producing silent misclassification.

To deprecate a code:

1. Add a `@deprecated superseded by <new-code>` JSDoc comment to the entry in
   `PROBLEM_CODES`.
2. Keep the entry in `PROBLEM_CODES` indefinitely.
3. Update any internal classification logic to produce the new code.
4. In a future major version (with a migration plan), the old code may map to
   the new one as a redirect alias.

### Rolling back the ProblemDetails shape (changing a required field)

Any change to the seven required fields is a **breaking change**:

1. Update `docs/API_CONTRACT.md` with the new shape.
2. Update `problemDetailsSchema` in
   `core/errors/__tests__/problem-details.contract.test.ts`.
3. Bump the schema version in the contract.
4. Document the migration path for consumers.

### Recovering from a bad deployment

If a deployment ships with incorrect `code` values or malformed `type` URIs:

1. The contract drift tests in CI will fail immediately on the next run.
2. Revert the offending commit: `git revert <sha>`.
3. Run `npm run verify:contract` locally to confirm the revert restores the
   locked shape.
4. Re-deploy the reverted build.

No data is mutated by the problem-details module (it is read-only) so there
is no database or cache to repair.

### Unknown code at runtime

If a caller receives a `code` it does not recognise (e.g., after a partial
upgrade), it should:

1. Treat the response as a non-retryable error.
2. Display the `detail` and `hint` fields verbatim to the user.
3. Log the unknown `code` and `correlationId` for investigation.

New codes are always additive (never replace old ones), so an unrecognised code
means the consumer is running an older version.

## Drift prevention

`npm run verify:contract` runs all tests under `core/contract/`. The
problem-details contract tests are in `core/errors/__tests__/` and are picked
up by the standard `npm test` run.

To run only the problem-details tests:

```bash
npm test -- core/errors
```

Checks enforced:

- Every required field is present and correctly typed.
- Every code in the exhaustive list exists in `PROBLEM_CODES`.
- The total count matches (catches silent additions and deletions).
- Every `type` URI starts with `https://utix.dev/problems/`.
- No raw Horizon/RPC error text appears in `detail` or `safeMessage`.
- The Horizon and RPC bridge adapters produce valid envelopes for all known codes.
