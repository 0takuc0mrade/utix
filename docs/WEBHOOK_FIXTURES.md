# Webhook golden fixture corpus

`core/webhooks/__tests__/fixtures/corpus/*.json` holds checked-in malformed and
adversarial webhook messages, each with the exact verdict
`WebhookVerifier.verifySignature` must return. It is exercised by
`core/webhooks/__tests__/goldenCorpus.test.ts`.

## Fixture format

```json
{
  "name": "replay-same-message",
  "description": "The identical message is delivered twice.",
  "secret": "golden-corpus-secret",
  "now": 1700000000,
  "deliveries": [ { "...": "message" }, { "...": "message" } ],
  "expect": [ { "valid": true }, { "valid": false, "error": "..." } ]
}
```

- `now` pins the clock (Unix seconds), so timestamps and signatures never age.
- `deliveries` are verified in order against one fresh verifier, so replay
  scenarios work. `expect` has one verdict per delivery.
- A value written as `{ "$repeat": { "value": "A", "count": 262145 } }` is
  expanded to that string on load, keeping oversized cases small on disk.
- The secret is a fixture-only constant; never put a real secret in a fixture.

## Coverage

| Prefix | Cases |
| --- | --- |
| `valid-` | baseline, sha512, unknown extra fields from a newer sender |
| `invalid-signature-` | tampered data, wrong secret, truncated, re-cased, algorithm mismatch |
| `missing-` | signature object, nonce, digest, timestamp, data; non-object payloads |
| `oversized-` | data over 256 KiB, nonce over 128 characters |
| `replay-` | same message twice, reused nonce with new data, stale and future timestamps |
| `schema-drift-` | string or null timestamp, numeric nonce, unsupported algorithm |

## Verification order

Structure and size first (`Malformed webhook message: <reason>`), then clock
skew, then nonce replay, then the HMAC. Malformed input is rejected before any
hashing, so an oversized or hostile payload costs nothing and never throws.

## Adding a case

Add a file with a unique name using one of the prefixes above and compute any
valid signature as `HMAC(secret, "<timestamp>.<nonce>.<JSON.stringify(data)>")`.
When the verifier's wording or limits change deliberately, update the matching
fixtures in the same change; a fixture failing unexpectedly means behavior
regressed.

## Failure modes and rollback

- Limits are `MAX_WEBHOOK_DATA_LENGTH` and `MAX_WEBHOOK_NONCE_LENGTH` in
  `core/webhooks/verification.ts`. A legitimate sender above them is rejected as
  malformed; raise the constant rather than skipping the check.
- Replay records live in memory per verifier; a restart forgets nonces, and the
  clock-skew window is the remaining protection.
- Rolling back means removing the `malformedReason` guard; valid messages are
  unaffected, malformed ones go back to throwing or failing the HMAC.

```bash
npm test -- core/webhooks
```
