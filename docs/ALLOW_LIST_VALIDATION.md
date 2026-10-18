# Strict allow-list validation

## What this covers

`core/allow-list/` validates three things an operator or a tool may submit:

1. **URLs** — scheme, host, credentials and port.
2. **File types** — extension, MIME type and size.
3. **Destinations** — recipient addresses, including Stellar public keys and
   secret seeds.

It is a focused vertical slice: three pure validators, each returning a
`Result<T, Code>` (see `core/result/result`). Validators never throw for
expected failures, they carry no caller identity, and they apply the same strict
decision to every input — so there is no authorization bypass through the
validation layer.

## Default policies

### URLs

| Rule              | Default                                                                   |
| ----------------- |---------------------------------------------------------------------------|
| Allowed schemes   | `https:` only                                                             |
| Allowed hosts     | `horizon-testnet.stellar.org`, `horizon.stellar.org`,<br>`soroban-testnet.stellar.org`, `mainnet.sorobanrpc.com`, `friendbot.stellar.org` |
| Allowed ports     | none (only the scheme default: 443 for https)                            |
| Credentials       | rejected (`user:pass@`)                                                   |

### File types

| Rule           | Default                                                                             |
| -------------- |-------------------------------------------------------------------------------------|
| Extensions     | `.json`, `.csv`, `.png`, `.jpg`, `.jpeg`, `.svg`, `.txt`                            |
| MIME types     | `application/json`, `text/csv`, `image/png`, `image/jpeg`, `image/svg+xml`, `text/plain` |
| Max size       | 10 MiB                                                                              |

### Destinations

| Rule                    | Default                                    |
| ----------------------- |--------------------------------------------|
| Stellar public keys     | accepted (format `G` + 55 base-32 chars)   |
| Pre-approved list       | none                                       |
| Secret seeds (`S…`)     | rejected on the prefix alone               |

## API

```ts
import {
  validateUrl,
  validateFileType,
  validateDestination,
  type AllowListErrorCode
} from "@/core/allow-list/validator";

validateUrl("https://evil.example")
// → { ok: false, code: "url_not_allowed" }

validateUrl("https://horizon-testnet.stellar.org")
// → { ok: true, value: { url, scheme: "https:", host, port: null, pathname: "/" } }

validateFileType("report.json", "application/json", 100)
// → { ok: true, value: { fileName, extension: ".json", mime: "application/json", size: 100 } }

validateFileType("script.exe", null, 100)
// → { ok: false, code: "file_type_not_allowed" }

validateDestination("S" + "A".repeat(55))
// → { ok: false, code: "destination_is_secret" }

validateDestination("G" + "A".repeat(55))
// → { ok: true, value: { destination, kind: "stellar_public_key" } }
```

For tighter requirements, use the factories `createUrlValidator`,
`createFileTypeValidator`, `createDestinationValidator` with an injected
policy.

## Error codes

| Code                 | Means                                                            |
| -------------------- |----------------------------------------------------------------- |
| `url_invalid`        | unparseable or empty                                             |
| `url_not_allowed`    | scheme or host not on the allow-list                             |
| `url_has_credentials`| URL embeds `user:pass@`                                          |
| `url_disallowed_port`| explicit port that is not the scheme default or on the list      |
| `file_type_not_allowed`| extension or MIME type not on the allow-list                   |
| `file_too_large`     | size exceeds `maxSize`                                           |
| `destination_invalid`| empty destination                                                |
| `destination_not_allowed`| not a Stellar public key and not on the allowed list          |
| `destination_is_secret`| starts with `S` — a secret seed, rejected before any check     |

## Behavior by path

| Path                  | Result                                                                 |
| --------------------- |----------------------------------------------------------------------- |
| **Normal**            | Value on the allow-list → `ok`, with the normalized value.             |
| **Failure**           | Off-list or malformed → `err` with a specific code, never a throw.     |
| **Retry**             | A rejected input is never retried silently; a corrected input is       |
|                       | re-validated and accepted when it satisfies the policy.                |
| **Authorization**     | Validation is stateless and identity-agnostic. It is applied uniformly, |
|                       | so the caller's role cannot influence whether an input is allowed.     |
|                       | Authorization (who may *submit* a URL/file/destination) is a separate   |
|                       | concern, enforced by `requirePermission` at the boundary (e.g.          |
|                       | `admin:config` for administrative configuration changes).              |

## Operational edge cases and recovery / rollback

- **Tightening a list.** Remove a host, extension, MIME type, or destination
  from the policy and redeploy. Previously accepted values are rejected from
  the next validation onward; there is no state to roll back because the
  validators are pure.
- **Loosening a list.** Add an entry to the policy. This is the only
  "rollback" direction and should be treated as a policy change: review the
  entry, deploy, and confirm the previously blocked input now passes.
- **Explicit default ports.** `:443` on https is tolerated; any other explicit
  port is rejected unless added to `allowedPorts`.
- **Secret seeds.** Anything starting with `S` is rejected immediately, before
  format or allow-list checks, so a secret key can never be validated as a
  destination.
- **Nested/missing values.** `before`/`after` style context is not produced by
  these validators; the caller records the offending value (or a redacted
  reference to it) in the audit trail when an administrative change is rejected
  (see [ADMIN_CONFIG_AUDIT.md](./ADMIN_CONFIG_AUDIT.md)).
- **No dependency on `@stellar/stellar-sdk`.** Stellar public-key shape is
  checked with a strict regex so the module stays dependency-light and easy to
  test in isolation.

## Verification

- Unit tests: `core/allow-list/__tests__/validator.test.ts` covers normal,
  failure, retry, custom policies, and identity-agnostic behavior.
- Because the validators are pure functions with injected policies, they can be
  executed manually in any Node environment without the app, a network, or the
  Stellar SDK.

## Migration plan

This is an additive change: a new module in `core/allow-list/`. No existing
module is modified, no existing error code or contract is changed, and no data
migration is required. Callers opt in by importing the validators; nothing in
the current request flow begins using them automatically.
