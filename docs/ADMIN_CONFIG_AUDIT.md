# Administrative configuration audit evidence

## What this covers

Some actions in Utix are administrative configuration changes: an operator
updates a network endpoint, the default role, a passphrase, or a health-check
interval. These are sensitive because they alter how the application behaves for
everyone, and a reviewer will want to know **who changed what, when, and with
what authorization**.

`core/admin-config/` is the store that records those changes. It follows the
same rules as the rest of the audit trail (see [AUDIT.md](./AUDIT.md)):

- **One structured event per change**, written at the domain boundary — the
  store, not the UI.
- **Attribution is always present**: `action`, `actor` (kind and id), `scope`,
  `target`, `reason`, `at`, `correlationId` and an `outcome` of `allowed` or
  `denied`.
- **Before/after are small and scalar.** Config values must be primitives; a
  nested value is dropped and a sensitive key is redacted on the way in.
- **Refusals are recorded too.** An unauthorized, unknown-key, or invalid-value
  change produces a `denied` audit event with the refusal code.
- **Audit-first.** The change is applied only after the audit event is on the
  trail. If the trail rejects the event, the change is not applied — so there is
  never a configuration change without audit evidence.

## Sensitive action

| Action             | Emitted by                              |
| ------------------ | --------------------------------------- |
| `admin.config_changed` | `core/admin-config/store.ts` (`setConfig`) |

It is declared in `SENSITIVE_ACTIONS` and is covered by `npm run verify:audit`
(which requires an emitter at a domain boundary that imports `@/core/audit`).

## Authorization model

Configuration changes are gated by the `admin:config` permission, held by the
`maintainer` role only. A server action or route handler must authorize before
calling the store:

```ts
import { getAuthContext, requirePermission } from "@/core/auth/middleware";
import { createAdminConfigStore } from "@/core/admin-config/store";

const store = createAdminConfigStore();

export async function updateConfig(key, value) {
  const context = getAuthContext();
  requirePermission(context, "admin:config"); // throws UnauthorizedError otherwise

  return store.setConfig({
    actor: { kind: "maintainer", id: context.userId ?? context.role },
    key,
    value,
    authorized: true
  });
}
```

- `maintainer` with `admin:config` → change may proceed.
- `viewer` → `admin_config_not_allowed`, recorded as `denied`.
- `service` → does not hold `admin:config` → `admin_config_not_allowed`, recorded as `denied`.

`authorized` is pre-computed by the caller (`requirePermission`). The store records
the decision; it does not re-derive authorization, so the authorization boundary
stays a single, testable point.

## Config keys

| Key                 | Value type     | Validation rule                                            |
| ------------------- | -------------- |----------------------------------------------------------- |
| `network.endpoint`  | string         | http(s) URL, no embedded credentials                       |
| `network.passphrase`| string         | non-empty, at most 200 characters                          |
| `role.default`      | string         | one of `viewer`, `maintainer`, `service`                   |
| `health.checkInterval` | number      | finite, greater than 0, less than 24 hours (ms)            |

## Behavior by path

| Path                  | Result                                                                    |
| --------------------- |---------------------------------------------------------------------------|
| **Normal**            | Authorized, valid value → `ok`, config updated, `allowed` event recorded. |
| **Failure — unauthorized** | `err("admin_config_not_allowed")`, config unchanged, `denied` event. |
| **Failure — unknown key** | `err("admin_config_unknown_key")`, config unchanged, `denied` event. |
| **Failure — invalid value** | `err("admin_config_invalid_value")`, config unchanged, `denied` event. |
| **Failure — audit rejected** | `err("admin_config_audit_rejected")`, config **not applied**.      |
| **Retry**             | Re-applying after a failure with a valid value succeeds.                  |
| **Idempotent retry**  | Re-applying the current value is a no-op `ok` and is not re-audited.      |

## Operational edge cases and recovery / rollback

- **Rollback.** The audit trail records `before` and `after` for every change.
  To roll back, read the previous event for the target key and re-apply its
  `before` value as a new authorized change (which itself is audited). There is
  no "undo" mutation of the trail — the trail is append-only.
- **Audit trail full.** The trail retains `AUDIT_DEFAULT_LIMIT` (500) events and
  prunes the oldest. When a change's audit event cannot be recorded, the change
  is rejected with `admin_config_audit_rejected`. Operators should export the
  trail (`trail.export`) before pruning removes evidence they need.
- **Non-scalar values.** Config values must be scalar primitives. An object is
  dropped from `before`/`after` rather than stored, so a complex value audits as
  absent. Keep config values scalar.
- **Client-side storage.** The default trail is backed by `localStorage` when
  available, otherwise in-memory. It is a review aid, not a server of record; a
  real deployment should export the trail server-side rather than trust the
  browser copy.
- **No secret leakage.** Endpoint credentials (`user:pass@`) are rejected at
  validation, and embedded Stellar secrets / bearer tokens are scrubbed before
  persistence.

## Verification

- Unit tests: `core/admin-config/__tests__/store.test.ts` and
  `core/admin-config/__tests__/audit.test.ts` cover normal, failure, retry,
  authorization, and audit-evidence paths.
- `npm run verify:audit` asserts `admin.config_changed` is declared and emitted
  at the domain boundary.
- `npm run verify:features` and `npm run verify:boundaries` are unaffected
  (this is core infra, not a feature slice).

## Migration plan

This is an additive change:

- `admin:config` is added to the `Permission` type and to the `maintainer` role
  in `core/auth/types.ts`. Existing roles and permissions are unchanged, so no
  existing authorization call needs editing.
- `admin.config_changed` is appended to `SENSITIVE_ACTIONS`; no existing action
  is removed or renamed.
- `scripts/verify-audit.mjs` gains one boundary entry.

No data migration is required: the store starts from defaults and the audit
trail begins empty.
