# Support access (maintainer impersonation)

## What this covers

`core/impersonation/` gives maintainers a **time-bounded, scoped, audited**
support session for debugging a user's issue. It builds on the session model
introduced for issue #80 and closes the operational gaps in issue #229: every
session event is now also written to the canonical, tamper-evident audit trail.

The default posture is **read-only**. A session can inspect tickets, transfer
history, events and diagnostics only when the corresponding scope was granted.
Dangerous mutations are unavailable unless the session explicitly allow-lists
them **and** the caller supplies an elevated confirmation token.

## Guarantees

| Property | Behaviour |
| --- | --- |
| Time bound | Default 15 minutes; minimum 1, maximum 60. Every action re-checks `expiresAt`. |
| Scoped | Scopes default to `read:tickets`, `inspect:events`, `support:diagnostics`. Actions not mapped to a granted scope are refused. |
| Read-only by default | `allowedMutations` is empty unless explicitly supplied. `ticket.transfer`, `ticket.redeem`, `ticket.burn`, `payout.withdraw`, `credential.rotate` and `event.cancel` are blocked. |
| Elevated confirmation | Allow-listed dangerous mutations still require a token of at least 8 characters when `elevatedConfirmationRequired` is true (the default). |
| User-safe notice | `getImpersonationBannerState()` returns the banner text, tone, remaining seconds, read-only flag and scopes. It never contains credentials. |
| No bypass | Every start, end, expiry, allowed action and blocked mutation is written to the local append-only trail **and** to `core/audit`. |

## Usage

```ts
import {
  canExecuteAction,
  createImpersonationSession,
  endImpersonationSession,
  getImpersonationBannerState
} from "@/core/impersonation";

const created = createImpersonationSession({
  maintainerId: "maintainer_alice",
  targetUserId: "user_bob",
  targetAddress: "GD5J...TEST",
  reason: "Customer reported a sync failure",
  durationMinutes: 20,
  scopes: ["read:tickets", "inspect:events"],
  clock: () => new Date()
});

if (!created.ok) throw new Error(created.code);

const check = canExecuteAction(created.value, "ticket.view");
if (!check.ok) return showSupportError(check.code);

const banner = getImpersonationBannerState(created.value);
// banner.statusText -> "Impersonating user_bob (Read-Only)"

const ended = endImpersonationSession(
  created.value,
  "Resolved the customer issue"
);
```

For a scoped action, pass the session's scopes when creating it, and pass an
elevated token only for an explicitly allow-listed mutation:

```ts
const elevated = canExecuteAction(session, "ticket.transfer", {
  elevatedConfirmationToken: process.env.SUPPORT_CONFIRMATION_TOKEN
});
```

## Audit trail

Every impersonation event is mirrored into `core/audit` with:

- **actor** `{ kind: "maintainer", id: maintainerId }`
- **scope** `maintainer`
- **target** `{ kind: "user", id: targetUserId }`
- **reason** `support_access`
- **correlationId** the impersonation session id
- **outcome** `allowed` or `denied`

| Local event | Canonical action |
| --- | --- |
| `session_started` | `impersonation.session_started` |
| `session_ended` | `impersonation.session_ended` |
| `session_expired` | `impersonation.session_expired` |
| `action_performed` | `impersonation.action` |
| `mutation_blocked` | `impersonation.mutation_blocked` |

Refused actions are still recorded, with `outcome: "denied"` and
`errorCode: "impersonation_denied"`. A maintainer can review a session:

```ts
import { getAuditTrail } from "@/core/audit";

const page = getAuditTrail().query(
  { kind: "maintainer", id: "auditor" },
  { action: "impersonation.mutation_blocked", limit: 50 }
);
```

The local trail remains available through `getImpersonationAuditTrail()`; the
canonical event is the durable, cross-session record. The local trail is
in-memory and per tab, so do not use it as the only evidence after a restart.

## Edge cases and failure modes

- **Clock skew** — expiry is compared against the injected clock. Hosts must
  keep NTP in sync; a large backwards jump keeps a session alive longer than
  intended. Pass a monotonic clock in long-lived jobs where possible.
- **Expiry during work** — `canExecuteAction` checks the deadline before every
  action. Do not start a long-running operation close to the deadline; the
  next action will be refused even if the first one succeeded.
- **Inactive or expired session** — returns `impersonation_session_inactive`
  or `impersonation_session_expired`; the refusal is audited.
- **Scope not granted** — returns `impersonation_scope_denied`; the refusal is
  audited.
- **Dangerous mutation** — returns `impersonation_mutation_blocked` unless the
  action is in `allowedMutations`; if allow-listed but the confirmation token
  is missing or shorter than 8 characters, returns
  `elevated_confirmation_required`. Neither path mutates user state.
- **Invalid request** — empty maintainer/target, a reason shorter than 5
  characters, or a duration outside 1–60 minutes returns the corresponding
  error before a session is created.
- **Audit availability** — `recordAudit` is deliberately non-throwing. The
  local trail is written first, so an action cannot silently bypass the local
  evidence. If the canonical event is missing when reviewing a session, treat
  that as an audit-pipeline incident and preserve the local trail while
  investigating; do not delete either trail.
- **Multiple tabs** — each tab has its own in-memory session and local trail.
  Persist only the session id in tab-scoped storage; never persist the elevated
  confirmation token. Use the canonical trail to reconcile activity across tabs.
- **Read access** — a non-maintainer cannot read maintainer-scope audit events;
  `getAuditTrail().query` returns `audit_denied`.

## Rollback and recovery

1. Call `endImpersonationSession()` for the affected session and discard the
   in-memory object. Ending is audited even when the session already expired.
2. Revoke the maintainer's account/role through the normal identity process;
   do not rely on session expiry for access removal.
3. Rotate the elevated confirmation token if one may have been exposed.
4. Review `impersonation.session_started`, `impersonation.action`,
   `impersonation.mutation_blocked`, `impersonation.session_expired` and
   `impersonation.session_ended` in `core/audit` for the session id.
5. If a dangerous mutation was allowed, verify the affected target through the
   normal ledger/audit tooling. Do not edit or delete audit events.
6. Clear any tab-scoped session id. `clearImpersonationAuditTrail()` is a test
   utility and must not be called from production code.

## Verification

```bash
npx vitest run core/impersonation
npx vitest run core/audit
```

The impersonation suite covers duration bounds, scope checks, dangerous
mutation blocking, elevated confirmation, expiry, banner state and the canonical
audit mapping.

See [Audit trail](./AUDIT.md) for the shared audit rules and export/read API.
