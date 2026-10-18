# Public status feed

`core/status/` publishes a machine-readable view of protocol health, incidents
and maintenance windows for external users and maintainers, without exposing
internal diagnostics.

## Two shapes

- **Trusted state** (`TrustedStatusState`) is internal. Components may carry
  `diagnostics`, incidents and maintenance windows may carry `internalNotes`,
  and every item has a `visibility` of `public` or `internal`.
- **The public feed** (`PublicStatusFeed`) is the published schema. The builder
  copies only the schema's own fields, so nothing else can leak by accident.

## Schema (version `1.0.0`)

```jsonc
{
  "schemaVersion": "1.0.0",
  "generatedAt": "2026-03-10T12:00:00.000Z",
  "status": "operational | degraded | maintenance | partial_outage | major_outage",
  "components": [
    { "id": "api", "name": "Ticket API",
      "status": "operational | degraded | partial_outage | major_outage | under_maintenance" }
  ],
  "incidents": [
    { "id": "inc-1", "title": "...", "summary": "...",
      "status": "investigating | identified | monitoring | resolved",
      "impact": "minor | major | critical",
      "startedAt": "...", "updatedAt": "...", "resolvedAt": "... | null",
      "componentIds": ["api"] }
  ],
  "maintenance": [
    { "id": "mnt-1", "title": "...", "startsAt": "...", "endsAt": "...",
      "state": "scheduled | in_progress | completed", "componentIds": ["api"] }
  ]
}
```

`validatePublicStatusFeed(value)` is the schema: it accepts exactly this shape
(no missing and no extra fields, ISO-8601 instants, known enum values) and
returns `invalid_status_feed` with the path of the first invalid field.
`publishPublicStatusFeed(state, now)` builds the feed and runs it through that
validator, so a feed that does not validate is never published.

## Deterministic states

The feed is a pure function of the trusted state and the instant `now`:

- A maintenance window is `scheduled` before `startsAt`, `in_progress` until
  `endsAt`, and `completed` after. Its components show `under_maintenance`
  while it runs. Cancelled windows are never published.
- The overall `status` is the worst of the published components, unresolved
  incidents (`minor` is degraded, `major` partial outage, `critical` major
  outage) and running maintenance. An outage outranks maintenance.
- Resolved incidents and completed windows stay in the feed for 7 days.
- Lists are sorted (components by id, incidents newest first, windows by start),
  so identical input always produces an identical feed.

## What is filtered out

- Items with `visibility: "internal"`, and anything cancelled.
- `diagnostics` and `internalNotes`, always.
- Internal component ids: incident and window `componentIds` are limited to
  published components, so an internal component is not revealed by reference.
- Internal components never move the overall status.

`componentFromHealthIndicator(indicator, { id, name })` turns an entry of the
operational health summary (see [OPERATIONAL_HEALTH.md](./OPERATIONAL_HEALTH.md))
into a trusted component. Without a public `id` and `name` the component stays
internal; the indicator's message and details only ever land in `diagnostics`.

## Serving the feed

The module returns plain JSON-serializable data. Serving it over HTTP, and
loading incidents and maintenance windows from wherever maintainers record them,
are left to the route or job that calls `publishPublicStatusFeed`.
