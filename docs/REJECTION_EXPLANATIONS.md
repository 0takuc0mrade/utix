# Rejection Explanations

`core/errors/explanations.ts` turns any rejected operation into one
user-safe `RejectionExplanation`, so every client shows the same reason, the
same wording and the same recovery steps.

```ts
import { explainRejection, renderRejection } from "@/core/errors/explanations";

const result = redeemTicket(state, params);
if (!result.ok) {
  const explanation = explainRejection(result, { correlationId });
  // { reasonCode: "outside_validity_window", category: "policy", title, message,
  //   recovery: [...], retryable: false, status: 409, reference }
  show(renderRejection(explanation));
}
```

`explainRejection` accepts a failed `Result`, a bare stable code, a domain
`InvariantViolation`, an `UnauthorizedError`, or any thrown value.

## Reason codes

Reason codes are stable. Clients switch on `reasonCode`; a code is never
renamed or removed, a new one is added instead. Each belongs to one category:

| Category | Meaning | Reason codes |
| --- | --- | --- |
| `validation` | The request itself is wrong | `invalid_input`, `invalid_address`, `invalid_amount`, `missing_field`, `unsupported_version`, `invalid_request_key`, `request_key_reused` |
| `policy` | A rule refuses a valid request | `capacity_reached`, `ticket_locked`, `account_restricted`, `outside_validity_window`, `event_cancelled`, `rate_limited` |
| `permission` | The caller may not do this | `unauthenticated`, `permission_denied`, `not_owner` |
| `stale_state` | The world moved since the caller looked | `not_found`, `already_redeemed`, `already_transferred`, `invalid_state_transition`, `duplicate_request`, `request_in_progress`, `request_expired` |
| `unexpected` | Not an expected rejection | `network_unavailable`, `timed_out`, `unexpected_failure` |

Every reason carries at least one ordered `recovery` step, a `retryable` flag
and the HTTP `status` an API response should use.

## Mapping

Low-level inputs map to reasons through two tables, exported so tests and
docs cannot drift from them:

- `REJECTION_SOURCE_CODES`: stable error codes (`core/errors/error-codes.ts`)
  and `Result` codes from idempotency, quota, export and replay.
- `REJECTION_INVARIANTS`: domain invariants `INV-01` to `INV-11`
  (`core/invariants`). `INV-02` covers both "not the owner" and "ticket not
  found", so its copy is deliberately neutral.

`unmappedErrorCodes()` lists any stable error code without a reason; the test
suite requires it to be empty, so adding an error code without mapping it
fails CI.

## Safety

- Only the fixed copy in `REJECTION_REASONS` is returned. A raw error
  message, entity id, limit or stack trace never appears in an explanation.
- Unrecognised input (unknown code, `null`, an `Error`) becomes
  `unexpected_failure`, so callers always receive an explanation.
- `reference` echoes the correlation id you pass in so support can find the
  server-side record; it is omitted when none is given.

## Adding a rejection

1. Add the reason to `REJECTION_REASONS` with a category, copy, at least one
   recovery step, `retryable` and `status`.
2. Map the low-level code or invariant in `REJECTION_SOURCE_CODES` or
   `REJECTION_INVARIANTS`.
3. Add a case to `core/errors/__tests__/explanations.test.ts`.

No migration is needed: the module is additive and does not change existing
error codes, `Result` shapes or API responses.
