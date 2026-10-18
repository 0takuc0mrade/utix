export interface DecodedCursor {
  key: string;
  offset: number;
}

export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

interface CursorOptions<T> {
  pageSize: number;
  getKey: (item: T) => string;
  cursor?: string;
  startIndex?: number;
  /**
   * Orders two keys the way `items` are ordered. When set, a cursor whose
   * anchor row was deleted (or became invisible) resumes at the first row
   * ordered after the anchor instead of trusting a stale offset, so no row is
   * skipped or repeated. `items` must be sorted ascending by this order.
   */
  compareKeys?: (a: string, b: string) => number;
  /**
   * Re-checked on every request, before anchoring and slicing. A row the caller
   * can no longer see is never returned and never counted, so a permission
   * change between pages cannot leak it through a cursor.
   */
  isVisible?: (item: T) => boolean;
}

export function encodeCursor(key: string, offset = 0): string {
  return `utix1:${Math.max(0, Math.floor(offset))}:${encodeURIComponent(key)}`;
}

export function decodeCursor(cursor: string | undefined): DecodedCursor | null {
  if (!cursor) return null;
  const match = /^utix1:(\d+):(.+)$/.exec(cursor);
  if (!match) return null;
  try {
    const key = decodeURIComponent(match[2]);
    if (!key) return null;
    return { key, offset: Number(match[1]) };
  } catch {
    return null;
  }
}

function boundedStart(items: unknown[], start: number): number {
  if (!Number.isFinite(start)) return 0;
  return Math.min(items.length, Math.max(0, Math.floor(start)));
}

export function paginateByCursor<T>(allItems: T[], options: CursorOptions<T>): CursorPage<T> {
  const items = options.isVisible ? allItems.filter(options.isVisible) : allItems;
  const pageSize = Math.max(1, Math.floor(options.pageSize));
  const decoded = decodeCursor(options.cursor);
  const { compareKeys } = options;
  const start = decoded
    ? (() => {
        const anchor = items.findIndex((item) => options.getKey(item) === decoded.key);
        if (anchor >= 0) return anchor + 1;
        if (compareKeys) {
          const resume = items.findIndex((item) => compareKeys(options.getKey(item), decoded.key) > 0);
          return resume >= 0 ? resume : items.length;
        }
        return boundedStart(items, decoded.offset);
      })()
    : boundedStart(items, options.startIndex ?? 0);
  const visible = items.slice(start, start + pageSize);
  const hasMore = start + visible.length < items.length;
  const last = visible.at(-1);

  return {
    items: visible,
    nextCursor: hasMore && last ? encodeCursor(options.getKey(last), start + visible.length - 1) : null,
    hasMore
  };
}
