# Authorization expiry, cleanup and renewal

A delegated permission must not live forever. `core/authorizations/` keeps
authorizations time-boxed and moves them through a small, audited lifecycle.
(Cross-device session revocation is separate; see `core/sessions/`.)

An authorization says: the **grantor** lets the **grantee** use a **scope**
(e.g. `tickets.redeem`), optionally limited to one **resource**, until
`expiresAt`.

## States

State is derived from the record and the clock, never from a flag a job must
remember to flip.

| State     | Meaning                                                               | Allows the action |
| --------- | --------------------------------------------------------------------- | ----------------- |
| `active`  | Before `expiresAt`, never renewed                                     | yes               |
| `renewed` | Before `expiresAt`, renewed at least once                             | yes               |
| `expired` | At or past `expiresAt`; still renewable during the grace period       | no                |
| `cleaned` | Removed by cleanup after the grace period; a new grant is required     | no                |
| `revoked` | Withdrawn by the grantor or a maintainer                              | no                |

`authorize({ grantee, scope, resourceId })` is the check a protected action
makes. An expired authorization is refused the instant it expires, whether or
not cleanup has run. The error says why: `authorization_expired`,
`authorization_revoked`, `authorization_cleaned` or `authorization_not_found`.

## Cleanup

- `report()` is read-only. It lists `expired` authorizations, the `cleanable`
  ones (expired longer than the grace period, default 7 days) and, with
  `expiringWithinMs`, those about to expire.
- `cleanup({ actor })` marks every cleanable authorization `cleaned`. Only a
  `maintainer` or `system` actor may run it (`cleanup_unauthorized` otherwise).
  It never touches revoked or still-usable authorizations.

## Renewal

`renew({ id, actor, confirmed: true, extendByMs })` requires:

- the **grantor** or a **maintainer** as the actor (`renewal_unauthorized`
  otherwise, so the grantee cannot extend its own permission);
- `confirmed: true` (`renewal_not_confirmed` otherwise);
- an authorization that is not revoked or cleaned, and, if expired, still
  inside the grace period (`renewal_window_closed` after it).

The new expiry is the later of now and the current expiry, plus `extendByMs`.
`extendByMs` and a grant's `ttlMs` are capped at 365 days.

## Audit

Every grant, renewal, revocation and cleanup is recorded in the audit trail
(see [AUDIT.md](./AUDIT.md)) as `authorization.granted`, `authorization.renewed`,
`authorization.revoked` and `authorization.cleaned_up`, with before and after
state. Refusals are recorded as `denied` events. As in the admin configuration
store, the change is applied only after its audit event is on the trail; if the
trail rejects the event the store returns `authorization_audit_failed` (cleanup
reports the authorization as `skipped`) and changes nothing.

## Grantor entitlement

The repository has no per-principal scope entitlement model (`core/auth` only
maps fixed roles to permissions), so the store does not decide what a grantor
may delegate. Pass the optional `canDelegate(grantor, scope, resourceId)` hook
to enforce it: a grant the grantor could not make is refused with
`grant_unauthorized`, a grant without a resource (every resource under the
scope) is reserved for maintainers, and `authorize` returns
`grantor_not_entitled` once the grantor no longer holds the entitlement. Without
the hook, the grantor's entitlement is the caller's responsibility.

## Scope of this module

The store is in-memory and takes its clock, id factory and audit recorder as
options. Wiring `authorize` into each protected action, and scheduling
`cleanup`, are done at the call sites and in the worker framework as those paths
land.
