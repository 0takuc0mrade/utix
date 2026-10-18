export type ArchiveState = "active" | "archived" | "restored";
export interface ArchiveRecord<T> { readonly id: string; readonly schemaVersion: number; readonly state: ArchiveState; readonly value: T; readonly archivedAt?: string; readonly restoredAt?: string; }
export interface ArchiveStore<T> { read(id: string): ArchiveRecord<T> | undefined; write(record: ArchiveRecord<T>): void; }

export function archiveRecord<T>(store: ArchiveStore<T>, id: string, now = new Date().toISOString()): ArchiveRecord<T> | undefined {
  const current = store.read(id); if (!current || current.state === "archived") return current;
  const archived = { ...current, state: "archived" as const, archivedAt: now }; store.write(archived); return archived;
}
export function restoreRecord<T>(store: ArchiveStore<T>, id: string, now = new Date().toISOString()): ArchiveRecord<T> | undefined {
  const current = store.read(id); if (!current || current.state !== "archived") return current;
  const restored = { ...current, state: "restored" as const, restoredAt: now }; store.write(restored); return restored;
}
export function isArchived<T>(record: ArchiveRecord<T> | undefined): boolean { return record?.state === "archived"; }
