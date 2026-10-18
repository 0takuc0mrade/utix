export type DispatchStatus = "queued" | "running" | "succeeded" | "dead_lettered";
export interface DispatchJob<T = unknown> { readonly id: string; readonly operation: string; readonly idempotencyKey: string; readonly payload: T; readonly attempts: number; readonly status: DispatchStatus; readonly lastError?: string; }
export interface DispatchStore<T = unknown> { read(id: string): DispatchJob<T> | undefined; write(job: DispatchJob<T>): void; list(): readonly DispatchJob<T>[]; }
export interface SideEffectDispatcherOptions<T> { readonly store: DispatchStore<T>; readonly maxAttempts?: number; readonly newId?: () => string; }

export function createSideEffectDispatcher<T>({ store, maxAttempts = 3, newId = () => crypto.randomUUID() }: SideEffectDispatcherOptions<T>) {
  const byKey = (key: string) => store.list().find((job) => job.idempotencyKey === key);
  const submit = (input: { operation: string; idempotencyKey: string; payload: T }) => {
    const existing = byKey(input.idempotencyKey);
    if (existing) return { job: existing, replayed: true };
    const job: DispatchJob<T> = { ...input, id: newId(), attempts: 0, status: "queued" };
    store.write(job); return { job, replayed: false };
  };
  const run = async (id: string, effect: (job: DispatchJob<T>) => Promise<void> | void) => {
    const current = store.read(id); if (!current || current.status === "succeeded" || current.status === "dead_lettered") return current;
    const running = { ...current, status: "running" as const, attempts: current.attempts + 1 }; store.write(running);
    try { await effect(running); const done = { ...running, status: "succeeded" as const }; store.write(done); return done; }
    catch (error) { const failed = { ...running, status: running.attempts >= maxAttempts ? "dead_lettered" as const : "queued" as const, lastError: error instanceof Error ? error.message : String(error) }; store.write(failed); return failed; }
  };
  const replay = () => store.list().filter((job) => job.status === "queued");
  return { submit, run, replay };
}
