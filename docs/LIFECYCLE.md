# Record lifecycles

Utix keeps a small number of **core records** — the things that outlive a single
render and that other code branches on: background jobs, notifications, export
envelopes and measured operations. Every one of them has an explicit lifecycle,
declared as a table, so nothing has to infer state from a boolean or a string.

`core/lifecycle/` is the only place a state or a legal move is defined.
`core/workers`, `core/notifications` and any future record type import their
machine from `core/lifecycle/records.ts`.

## Why

Before this, each consumer re-derived state on its own. A job carried a
`status` string that a caller could assign to directly; a notification carried
a `read` flag that the store wrote and the UI re-checked; an export envelope's
state was its `expiresAt` timestamp compared against the wall clock in two
places. The consequences were real: a settled job could be re-queued, a purged
notification could be marked read, and the UI badge could disagree with the
payload an API consumer received.

## The model

```ts
interface LifecycleDefinition {
  name: string;                 // record kind, e.g. "worker_job"
  initial: string;
  states: string[];
  terminal: string[];           // states from which nothing is legal
  transitions: { from: string; event: string; to: string }[];
}
```

`createLifecycle(definition)` returns an immutable machine. Everything else is
derived from it:

| Call | Use |
| --- | --- |
| `machine.initial()` | the state a new record starts in |
| `machine.parseState(value)` | validates an untrusted value (storage, query) |
| `machine.canTransition(state, event)` | `ok` only for a declared rule |
| `machine.allowedEvents(state)` | empty for a terminal state |
| `applyTransition(machine, record, event, context)` | the one mutating entry point |
| `stateView(kind, state)` | the label/tone/allowed-events triple for UI and API |

`applyTransition` validates the current state, looks up the rule, stamps the
transition and emits telemetry. It never mutates the record — the caller
assigns the returned `to` state — so a rejected move cannot leave a half-applied
change behind.

### Error codes

| Code | Meaning |
| --- | --- |
| `unknown_record_kind` | no machine is registered for that kind |
| `unknown_state` | the record's current state is not declared |
| `unknown_event` | the event was empty |
| `invalid_transition` | no rule for `(state, event)` |
| `terminal_state` | the record already settled |

`core/result` is used throughout: expected rejections are returned, never
thrown. A malformed *table* is a programming error and does throw at
`createLifecycle` time (duplicate rules, undeclared states, rules leaving a
terminal state).

## Record kinds

### `worker_job` — `core/workers/queue.ts`

```
queued ──start──▶ running ──succeed──▶ succeeded   (terminal)
  │                  │
  │                  ├──fail──▶ retrying ──start──▶ running
  │                  │              ├──fail──▶ retrying
  │                  │              ├──exhaust──▶ dead_lettered (terminal)
  │                  │              └──retry──▶ queued
  └──dead_letter────────────────────────────────▶ dead_lettered (terminal)
```

- `succeeded` and `dead_lettered` are terminal: `retryJob()` on either returns
  `terminal_state` instead of quietly running the handler again, and
  `processJob()` leaves the job untouched.
- `retryJob()` is only legal from `retrying`; on a `queued` job it returns
  `invalid_transition`.
- `JOB_STATUSES` is derived from the table, so the `JobStatus` type cannot
  drift from the machine.

### `notification` — `core/notifications/`

```
unread ──read──▶ read ──archive──▶ archived
  │                │                   │
  └──archive────────┴────purge──────────┴──▶ purged (terminal)
```

`read` on the `Notification` type is a **derived** field: the store writes
`state`, and the flag is computed from it. Entries written before `state`
existed are migrated from the old flag on read, so an existing browser profile
keeps working. A second `markRead` returns `null` instead of rewriting the
record.

### `export_envelope`

```
generated ──expire──▶ expired ──purge──▶ purged (terminal)
       └────────────────purge────────────────▶ purged (terminal)
```

### `operation`

```
started ──succeed──▶ succeeded (terminal)
       └──fail──────▶ failed    (terminal)
```

One record per attempt. A retry is a *new* operation record; a settled one is
never reopened.

## Determinism

Transitions take the clock, the actor and the reason from the caller
(`{ at, actor, reason, correlationId }`), so replaying the same calls with the
same arguments produces byte-identical `TransitionRecord`s. Nothing in
`core/lifecycle` calls `Date.now()` on its own.

## Telemetry

| `op` | When |
| --- | --- |
| `lifecycle.transition` | an accepted move, with `recordKind`, `recordId`, `from`, `to`, `event` |
| `lifecycle.transition_rejected` | a refused move, with the failure `errorCode` and the same context |

Both carry the transition's `correlationId`, so a lifecycle move can be joined
to the request or job that caused it in the telemetry sink.

## Contributor rules

- Never assign a record's state directly. Call `applyTransition` (or the
  wrapper `transitionRecord`) and use the returned state.
- Never map a state to a label, tone or affordance in a component. Call
  `stateView(kind, state)` — that is what keeps the UI and the API response on
  the same model.
- Add a rule to the table rather than branching on a status string. A branch is
  exactly the implicit-state check this module replaced.

## Transition matrix tests

`core/lifecycle/__tests__/stateMachineMatrix.test.ts` runs against every
machine in `RECORD_MACHINES`, so a new record kind is covered automatically:

- every `(state, event)` pair resolves to the declared target or to
  `invalid_transition` / `terminal_state`, never anything else;
- terminal states are exactly the states with no outgoing rule, and reject every
  event with `terminal_state`;
- every state is reachable from the initial state and can reach a terminal
  state, so a record cannot be stuck;
- recovery paths are walked end to end (`running -fail-> retrying -start->
  running -succeed-> succeeded`, `retrying -retry-> queued`, repeated `fail`
  until `exhaust`), and `succeeded`, `dead_lettered`, `purged` and the settled
  ownership states offer none;
- unknown or malformed states and events get `unknown_state` / `unknown_event`.

Failure mode: a table edit that adds a rule out of a terminal state throws in
`createLifecycle`; one that strands a state fails the reachability tests.
Rollback is reverting the table change; persisted records keep a state name, so
removing a state requires migrating those records first.

```bash
npm test -- core/lifecycle     # every allowed transition, and the rejected ones
npm test -- core/workers       # the framework refuses the moves the table omits
```
