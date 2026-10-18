# Fuzz Coverage for Malformed Payloads and Boundary Values (#268)

`core/__tests__/fuzz.test.ts` drives core boundaries with generated input. A
seeded PRNG (mulberry32) generates the input, so every failure reproduces exactly:

```bash
npm test -- core/__tests__/fuzz                      # default seed
FUZZ_SEED=12345 npm test -- core/__tests__/fuzz      # explore another seed
```

Each property states what must hold for every input. A failing assertion
names the seed and the input.

| Target | Property |
| :--- | :--- |
| `parseAmount` / `amountToStroops` / `stroopsToAmount` | Every int64 stroop value round-trips exactly. Amounts are signed int64 scaled by 10⁷, so the bounds are `922337203685.4775807` and `-922337203685.4775808`; one stroop past either is `out_of_range`, and an eighth decimal is `too_many_decimals`. Arbitrary input returns a declared `AmountParseError` and never throws. |
| `parseJsonRpcResponse` | Any value, including cycles, BigInt, symbols and prototype keys, yields a JSON-RPC 2.0 envelope with exactly one of `result`/`error`. `error.code` is always an integer (§5.1), and a success always carries the expected id. |
| `requestDigest` / `canonicalize` / `IdempotencyStore.begin` | Any payload digests deterministically. A key is either claimed or rejected with a declared code, and an immediate duplicate is `idempotency_in_flight`. |
| `hasPermission` / `hasAnyPermission` / `hasAllPermissions` | An unknown role, including `toString` and `__proto__`, is denied and never throws. Known roles keep their exact grants. |

## Defects found and fixed

| Defect | Impact | Fix |
| :--- | :--- | :--- |
| `hasPermission` threw `TypeError` for any role outside the table | A mistyped `UTIX_USER_ROLE` crashed every permission check, and prototype keys resolved to functions | `Object.hasOwn` guard: unknown roles are denied |
| `canonicalize` threw on `BigInt` and overflowed the stack on cycles | `IdempotencyStore.begin` threw instead of returning a `Result` | BigInt → `10n`; a back-reference → `#cycle` |
| `parseJsonRpcResponse` accepted `NaN` or fractional error codes | A malformed error envelope passed as valid | Error code must satisfy `Number.isInteger` |

## Compatibility

All three fixes only change inputs that used to throw or that the spec forbids:

- Every input `JSON.stringify` accepted keeps its exact canonical form, so
  persisted idempotency digests stay valid. `#cycle` and the `n` suffix are not
  valid JSON, so they cannot collide with an existing digest.
- Every role in `ROLE_PERMISSIONS` keeps its exact grants.
- A valid JSON-RPC error has an integer code, so no valid envelope changes.

No migration is needed. To roll back, revert the three one-function changes.
The fuzz suite then fails, which shows exactly which guard was removed.
