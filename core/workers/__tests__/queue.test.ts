import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetHorizonClients, horizonServer } from "@/core/horizon/client";
import {
  createWorkerFramework,
  retryBackoff,
  type WorkerFramework
} from "@/core/workers/queue";
import {
  createMaintenanceFramework,
  PRUNE_HORIZON_CLIENTS_OP,
  PRUNE_HORIZON_CLIENTS_DELAY_MS
} from "@/core/workers/maintenance";

describe("worker framework", () => {
  let framework: WorkerFramework;

  beforeEach(() => {
    framework = createWorkerFramework();
  });

  it("enqueues jobs that can be inspected by status", () => {
    const job = framework.enqueue({ operation: "widget.process", params: { id: 1 } });

    expect(framework.inspect("queued").map((j) => j.id)).toEqual([job.id]);
    expect(framework.getById(job.id)?.operation).toBe("widget.process");
    expect(job.maxAttempts).toBe(3);
    expect(job.attempts).toBe(0);
    expect(job.status).toBe("queued");
  });

  it("runs a job through to success", () => {
    const handler = vi.fn();
    framework.register("widget.process", handler);

    const job = framework.enqueue({ operation: "widget.process" });
    const summary = framework.drainDueJobs();

    expect(summary.ran).toBe(1);
    expect(summary.succeeded).toBe(1);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(framework.getById(job.id)?.status).toBe("succeeded");
  });

  it("keeps failed jobs inspectable with context and dead-letters after retry exhaustion", () => {
    framework.register("flaky.process", () => {
      throw new Error("naive failure");
    });

    const job = framework.enqueue({ operation: "flaky.process", maxAttempts: 2 });
    expect(framework.drainDueJobs().retried).toBe(1);
    expect(job.status).toBe("retrying");
    expect(job.lastError?.code).toBe("Error");
    expect(job.lastError?.message).toBe("naive failure");
    expect(job.nextAttemptAt).toBeDefined();

    const later = Date.parse(job.nextAttemptAt!) + 10;
    const second = framework.drainDueJobs(later);
    expect(second.ran).toBe(1);
    expect(second.deadLettered).toBe(1);
    expect(job.status).toBe("dead_lettered");
  });

  it("preserves the job correlation id in worker context across retries", () => {
    const correlationIds: string[] = [];
    framework.register("correlated.process", (_params, context) => {
      correlationIds.push(context.correlationId);
      if (context.attempt === 1) throw new Error("retry this attempt");
    });

    const correlationId = "correlation-retry-123";
    const job = framework.enqueue({
      operation: "correlated.process",
      correlationId,
      maxAttempts: 2
    });

    framework.drainDueJobs();
    framework.drainDueJobs(Date.parse(job.nextAttemptAt!) + 1);

    expect(correlationIds).toEqual([correlationId, correlationId]);
    expect(job.status).toBe("succeeded");
  });

  it("retries do not run before their backoff time and do not exceed the budget", () => {
    framework.register("slow.process", () => {
      throw new Error("nope");
    });

    const job = framework.enqueue({ operation: "slow.process", maxAttempts: 4 });
    framework.drainDueJobs(); // attempt 1 -> retrying
    framework.drainDueJobs(Date.now() + 10); // not yet due -> nothing runs
    expect(job.attempts).toBe(1);

    const firstRetryAt = Date.parse(job.nextAttemptAt!);
    framework.drainDueJobs(firstRetryAt + 1); // attempt 2 -> retrying
    expect(framework.inspect("retrying")).toHaveLength(1);

    const secondRetryAt = Date.parse(job.nextAttemptAt!);
    framework.drainDueJobs(secondRetryAt + 1); // attempt 3 -> retrying
    const thirdRetryAt = Date.parse(job.nextAttemptAt!);
    framework.drainDueJobs(thirdRetryAt + 1); // attempt 4 -> exhausted
    expect(framework.inspect("dead_lettered")).toHaveLength(1);
  });

  it("retryJob re-queues a failed job and clears its error context", () => {
    framework.register("flaky.process", () => {
      throw new Error("boom");
    });

    const job = framework.enqueue({ operation: "flaky.process", maxAttempts: 3 });
    framework.drainDueJobs(); // attempt 1 of 3 -> retrying

    // `retry` is only legal from `retrying`, and the result carries the state.
    const reset = framework.retryJob(job.id);
    expect(reset.ok).toBe(true);
    if (!reset.ok) return;
    expect(reset.value.status).toBe("queued");
    expect(reset.value.attempts).toBe(0);
    expect(reset.value.nextAttemptAt).toBeUndefined();
    expect(framework.canTransition("queued", "retry")).toMatchObject({
      ok: false,
      code: "invalid_transition"
    });
  });

  it("dedupeKey makes re-enqueueing idempotent while a job is pending", () => {
    framework.register("drain.yesterday", () => undefined);
    const first = framework.enqueue({ operation: "drain.yesterday", dedupeKey: "daily" });
    const second = framework.enqueue({ operation: "drain.yesterday", dedupeKey: "daily" });

    expect(second.id).toBe(first.id);
    expect(framework.inspect()).toHaveLength(1);
  });

  it("processJob is idempotent: a succeeded job is a no-op", () => {
    const handler = vi.fn();
    framework.register("once.only", handler);
    const job = framework.enqueue({ operation: "once.only", maxAttempts: 3 });

    framework.drainDueJobs();
    expect(handler).toHaveBeenCalledTimes(1);

    const reprocess = framework.processJob(job.id);
    expect(reprocess.ran).toBe(0);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(job.status).toBe("succeeded");
  });
});

describe("retry backoff", () => {
  it("doubles per attempt", () => {
    expect(retryBackoff(200, 1)).toBe(200);
    expect(retryBackoff(200, 2)).toBe(400);
    expect(retryBackoff(200, 3)).toBe(800);
    expect(retryBackoff(200, 32)).toBeLessThan(Number.MAX_SAFE_INTEGER);
  });
});

describe("maintenance worker integration", () => {
  it("moves the Horizon cache prune into a delayed, drainable job", () => {
    const worker = createMaintenanceFramework();

    resetHorizonClients();
    horizonServer("testnet");

    const job = worker.enqueue({
      operation: PRUNE_HORIZON_CLIENTS_OP,
      delayMs: PRUNE_HORIZON_CLIENTS_DELAY_MS
    });
    expect(job.operation).toBe(PRUNE_HORIZON_CLIENTS_OP);

    // Before the delay elapses, the due drain runs nothing.
    worker.drainDueJobs();
    expect(job.status).toBe("queued");

    // After the delay, the prune runs and the job succeeds.
    worker.drainDueJobs(Date.now() + PRUNE_HORIZON_CLIENTS_DELAY_MS + 10);
    expect(job.status).toBe("succeeded");
  });
});