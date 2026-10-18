# Cursor pagination

`core/pagination/cursor.ts` pages through a list that can change between
requests. A cursor is `utix1:<offset>:<key>`: the key of the last row served
plus the offset it had, as a hint.

## Resolving a cursor

1. Rows the caller cannot see are removed first (`isVisible`).
2. If the anchor key is still in the list, the page starts right after it.
   Rows inserted or deleted elsewhere do not shift the page.
3. If the anchor is gone (deleted, or no longer visible) and `compareKeys` is
   supplied, the page starts at the first row ordered after the anchor. No row
   is skipped or repeated, however many rows were removed before it.
4. If the anchor is gone and there is no `compareKeys`, the stored offset is
   used. This is best effort: deletions before the anchor can skip rows.

```ts
paginateByCursor(rows, {
  pageSize: 50,
  getKey: (row) => row.id,
  compareKeys: (a, b) => Number(a) - Number(b), // rows sorted ascending by id
  isVisible: (row) => canRead(caller, row),
  cursor
});
```

`items` must already be sorted by the order `compareKeys` describes. Keys must
be unique and totally ordered; a key that sorts differently from the list order
makes rule 3 resume at the wrong place.

## Permissions

`isVisible` runs on every request, not when the cursor is minted. A cursor
carries no authorization: revoking access between pages hides the row on the
next page, including when the revoked row was the anchor. A row that becomes
visible mid-walk appears only if it sorts after the cursor. `hasMore` and
`nextCursor` are computed over visible rows only, so the end of a page never
reveals that hidden rows exist.

## Edge cases and failure modes

- A malformed cursor decodes to `null` and the walk restarts from
  `startIndex` (default 0); it does not throw.
- A deleted last row yields an empty final page with `hasMore: false`.
- Rows inserted behind the cursor are not seen by the walk in progress; a new
  walk sees them.
- The exporter (`core/export/exporter.ts`) keys rows by content hash, which is
  not ordered, so it keeps the offset fallback and filters by scope before
  paging.

## Rollback

Both options are optional and absent by default, so existing callers behave as
before. To roll back a caller, remove `compareKeys` / `isVisible` from its
options; cursors already issued stay valid because the format is unchanged.

```bash
npm test -- core/pagination
```
