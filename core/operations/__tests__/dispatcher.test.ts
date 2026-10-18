import { describe, expect, it } from "vitest";
import { createSideEffectDispatcher, type DispatchJob, type DispatchStore } from "@/core/operations/dispatcher";

function store(): DispatchStore<string> { const values = new Map<string, DispatchJob<string>>(); return { read: (id) => values.get(id), list: () => [...values.values()], write: (job) => void values.set(job.id, job) }; }
describe("side-effect dispatcher", () => {
  it("deduplicates and dead-letters after the retry budget", async () => {
    const dispatcher = createSideEffectDispatcher({ store: store(), maxAttempts: 2, newId: () => "job-1" });
    const first = dispatcher.submit({ operation: "send", idempotencyKey: "key-1", payload: "x" });
    expect(dispatcher.submit({ operation: "send", idempotencyKey: "key-1", payload: "x" }).replayed).toBe(true);
    await dispatcher.run(first.job.id, () => { throw new Error("offline"); });
    await dispatcher.run(first.job.id, () => { throw new Error("offline"); });
    expect(dispatcher.replay()).toHaveLength(0);
  });
});
