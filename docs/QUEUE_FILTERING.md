# Maintainer queue filtering (#186)

`queryQueue(items, auth, query)` in `core/queue/filter.ts` narrows a maintainer queue and pages the result.

## Filters

| Field | Type | Matches |
| --- | --- | --- |
| `severity` | `low`, `medium`, `high`, `critical` list | item severity |
| `status` | string list | item status |
| `actor` | string list | who raised or last touched the item |
| `resource` | string list | the resource the item is about, e.g. `ticket:t-1` |
| `failureCategory` | string list | failure category |
| `minAgeMs` / `maxAgeMs` | non-negative number | age relative to `now` (defaults to the current time) |

Values inside one filter are OR-ed, different filters are AND-ed, and an omitted filter matches everything.

## Query string

`parseQueueQuery(new URLSearchParams(...))` accepts comma separated or repeated values:

```
?severity=high,critical&status=open&minAgeMs=3600000&pageSize=20&cursor=...
```

Invalid values (unknown severity, negative or inverted age bounds, `pageSize` outside 1-100) return `invalid_filter` with the reason in `detail`.

## Pagination

Results are sorted newest first with the item id as tie-breaker, independent of the filters, and paged with `paginateByCursor`. The cursor is anchored on an item id, so items queued or resolved between requests do not shift later pages. `totalMatched` counts every match across pages.

## Permissions

Reading a queue requires `admin:health` (`permission_denied` otherwise). Items flagged `restricted` are only returned to roles with `admin:config`; for others they are removed before filtering, so they never appear in `items` or `totalMatched`.
