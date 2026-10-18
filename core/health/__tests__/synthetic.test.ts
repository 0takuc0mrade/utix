import { afterEach, describe, expect, it } from "vitest";
import { NETWORK_PASSPHRASES } from "@/core/network/config";
import { createCaptureSink, resetTelemetrySink, setTelemetrySink } from "@/core/telemetry/telemetry";
import {
  parseRetryAfter,
  runSyntheticMonitor,
  SYNTHETIC_PAGE_SIZE,
  type SyntheticMonitorOptions
} from "../synthetic";

const HORIZON = "https://horizon.example";
const ACCOUNT = `G${"A".repeat(55)}`;
const SERVICE = { role: "service" } as const;

const root = (overrides: Record<string, unknown> = {}) => ({
  network_passphrase: NETWORK_PASSPHRASES.testnet,
  core_latest_ledger: 5_247_219,
  history_latest_ledger: 5_247_219,
  ...overrides
});

/** Paging tokens counting down from `from`, as Horizon returns them for `order=desc`. */
const page = (from: number, count: number) => ({
  _embedded: {
    records: Array.from({ length: count }, (_, index) => ({
      id: String(from - index),
      paging_token: String(from - index),
      source_account: ACCOUNT
    }))
  }
});

type Reply = { status?: number; body?: unknown; headers?: Record<string, string> } | "transport" | "hang";

/**
 * A scripted Horizon: each route answers from its queue (the last reply
 * repeats), and every requested URL is kept for assertions.
 */
function horizon(routes: Record<string, Reply[]>) {
  const requests: URL[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push(url);
    const route = url.pathname === "/" ? "root" : url.searchParams.has("cursor") ? "older" : url.pathname.slice(1);
    const queue = routes[route] ?? [{ status: 404, body: { status: 404 } }];
    const reply = queue.length > 1 ? queue.shift()! : queue[0];
    if (reply === "transport") throw new TypeError("fetch failed");
    if (reply === "hang") {
      return new Promise<Response>((_, reject) =>
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))
      );
    }
    const body = typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body ?? {});
    return new Response(body, { status: reply.status ?? 200, headers: reply.headers });
  }) as typeof fetch;
  return { fetchImpl, requests };
}

function healthyRoutes(firstPageSize = SYNTHETIC_PAGE_SIZE): Record<string, Reply[]> {
  return {
    root: [{ body: root() }],
    operations: [{ body: page(900, 1) }],
    [`accounts/${ACCOUNT}/operations`]: [{ body: page(800, firstPageSize) }],
    older: [{ body: page(800 - firstPageSize, 5) }]
  };
}

function options(fetchImpl: typeof fetch, overrides: Partial<SyntheticMonitorOptions> = {}) {
  const sleeps: number[] = [];
  let clock = 0;
  return {
    sleeps,
    options: {
      network: "testnet",
      horizonUrl: HORIZON,
      fetch: fetchImpl,
      sleep: async (ms: number) => void sleeps.push(ms),
      now: () => (clock += 1),
      ...overrides
    } satisfies SyntheticMonitorOptions
  };
}

afterEach(() => resetTelemetrySink());

describe("synthetic critical-journey monitor (#269)", () => {
  describe("normal path", () => {
    it("walks the journey to the older page and reports healthy", async () => {
      const { fetchImpl, requests } = horizon(healthyRoutes());
      const outcome = await runSyntheticMonitor(SERVICE, options(fetchImpl).options);

      expect(outcome.ok && outcome.value.status).toBe("healthy");
      expect(outcome.ok && outcome.value.steps.map((step) => [step.step, step.ok, step.attempts])).toEqual([
        ["horizon.root", true, 1],
        ["operations.discover", true, 1],
        ["account.operations", true, 1],
        ["account.operations.older", true, 1]
      ]);
      expect(requests.map((url) => `${url.pathname}${url.search}`)).toEqual([
        "/",
        "/operations?order=desc&limit=1",
        `/accounts/${ACCOUNT}/operations?order=desc&limit=20`,
        `/accounts/${ACCOUNT}/operations?order=desc&limit=20&cursor=781`
      ]);
    });

    it("skips the older page when the first page is not full, as the UI does", async () => {
      const { fetchImpl } = horizon(healthyRoutes(3));
      const outcome = await runSyntheticMonitor(SERVICE, options(fetchImpl).options);

      expect(outcome.ok && outcome.value.status).toBe("healthy");
      expect(outcome.ok && outcome.value.steps.map((step) => step.step)).not.toContain("account.operations.older");
    });

    it("keeps the defaults when an option is passed as undefined", async () => {
      const { fetchImpl } = horizon(healthyRoutes());
      const outcome = await runSyntheticMonitor(
        SERVICE,
        options(fetchImpl, { timeoutMs: undefined, maxAttempts: undefined }).options
      );

      expect(outcome.ok && outcome.value.status).toBe("healthy");
    });

    it("emits one structured telemetry event per run", async () => {
      const sink = createCaptureSink();
      setTelemetrySink(sink);
      const { fetchImpl } = horizon(healthyRoutes());
      await runSyntheticMonitor(SERVICE, options(fetchImpl).options);

      expect(sink.events.filter((event) => event.op === "synthetic.journey")).toHaveLength(1);
      expect(sink.events.at(-1)).toMatchObject({ actorType: "system", result: "success", payload: { status: "healthy" } });
    });
  });

  describe("retry path", () => {
    it("recovers from a transient 503 and reports degraded, not healthy", async () => {
      const routes = healthyRoutes();
      routes.root = [{ status: 503 }, { body: root() }];
      const { fetchImpl } = horizon(routes);
      const { options: run, sleeps } = options(fetchImpl);

      const outcome = await runSyntheticMonitor(SERVICE, run);
      expect(outcome.ok && outcome.value.status).toBe("degraded");
      expect(outcome.ok && outcome.value.steps[0]).toMatchObject({ ok: true, attempts: 2 });
      expect(sleeps).toEqual([500]);
    });

    it("backs off exponentially and honours Retry-After within the ceiling", async () => {
      const routes = healthyRoutes();
      routes.root = [
        { status: 429, headers: { "retry-after": "3" } },
        { status: 429, headers: { "retry-after": "120" } },
        { body: root() }
      ];
      const { fetchImpl } = horizon(routes);
      const { options: run, sleeps } = options(fetchImpl);

      await runSyntheticMonitor(SERVICE, run);
      expect(sleeps).toEqual([3_000, 10_000]);
    });

    it("retries transport errors and timeouts", async () => {
      const routes = healthyRoutes();
      routes.root = ["transport", "hang", { body: root() }];
      const { fetchImpl } = horizon(routes);

      const outcome = await runSyntheticMonitor(SERVICE, options(fetchImpl, { timeoutMs: 5 }).options);
      expect(outcome.ok && outcome.value.steps[0]).toMatchObject({ ok: true, attempts: 3 });
    });
  });

  describe("failure path", () => {
    it.each([
      ["rate_limited", [{ status: 429 }]],
      ["server_error", [{ status: 500 }]],
      ["transport", ["transport"]],
      ["timeout", ["hang"]]
    ] as const)("reports %s as unhealthy once retries are exhausted", async (code, replies) => {
      const routes = healthyRoutes();
      routes.root = [...replies] as Reply[];
      const { fetchImpl, requests } = horizon(routes);

      const outcome = await runSyntheticMonitor(SERVICE, options(fetchImpl, { timeoutMs: 5 }).options);
      expect(outcome.ok && outcome.value).toMatchObject({
        status: "unhealthy",
        steps: [{ step: "horizon.root", ok: false, attempts: 3, errorCode: code }]
      });
      expect(requests).toHaveLength(3);
    });

    it("does not retry a contract failure", async () => {
      const routes = healthyRoutes();
      routes.root = [{ body: root({ network_passphrase: NETWORK_PASSPHRASES.mainnet }) }];
      const { fetchImpl, requests } = horizon(routes);

      const outcome = await runSyntheticMonitor(SERVICE, options(fetchImpl).options);
      expect(outcome.ok && outcome.value.steps).toEqual([
        expect.objectContaining({ step: "horizon.root", attempts: 1, errorCode: "network_mismatch" })
      ]);
      expect(requests).toHaveLength(1);
    });

    it.each([
      ["a non-JSON root body", { root: [{ body: "<html>" }] }, "horizon.root", "malformed_payload"],
      ["a root without ledger numbers", { root: [{ body: { network_passphrase: NETWORK_PASSPHRASES.testnet } }] }, "horizon.root", "malformed_payload"],
      ["a 404", { operations: [{ status: 404 }] }, "operations.discover", "http_status"],
      ["an empty network", { operations: [{ body: page(1, 0) }] }, "operations.discover", "no_activity"],
      ["a muxed or invalid source", { operations: [{ body: { _embedded: { records: [{ source_account: "M123" }] } } }] }, "operations.discover", "malformed_payload"],
      ["an ascending first page", { [`accounts/${ACCOUNT}/operations`]: [{ body: { _embedded: { records: [{ paging_token: "1" }, { paging_token: "2" }] } } }] }, "account.operations", "pagination_broken"],
      ["an older page that repeats the cursor", { older: [{ body: page(781, 2) }] }, "account.operations.older", "pagination_broken"]
    ] as const)("flags %s", async (_, override, failedStep, code) => {
      const { fetchImpl } = horizon({ ...healthyRoutes(), ...override } as Record<string, Reply[]>);
      const outcome = await runSyntheticMonitor(SERVICE, options(fetchImpl).options);

      expect(outcome.ok && outcome.value.status).toBe("unhealthy");
      expect(outcome.ok && outcome.value.steps.at(-1)).toMatchObject({ step: failedStep, ok: false, errorCode: code });
    });

    it("reports degraded when ingestion lags or the run exceeds its latency budget", async () => {
      const lagging = healthyRoutes();
      lagging.root = [{ body: root({ history_latest_ledger: 5_247_200 }) }];
      const lag = await runSyntheticMonitor(SERVICE, options(horizon(lagging).fetchImpl).options);
      expect(lag.ok && lag.value).toMatchObject({ status: "degraded", ingestLagLedgers: 19 });

      const slow = await runSyntheticMonitor(
        SERVICE,
        options(horizon(healthyRoutes()).fetchImpl, { latencyBudgetMs: 1 }).options
      );
      expect(slow.ok && slow.value.status).toBe("degraded");
    });
  });

  describe("authorization path", () => {
    it("refuses a viewer or unknown role without making a request", async () => {
      const sink = createCaptureSink();
      setTelemetrySink(sink);
      const { fetchImpl, requests } = horizon(healthyRoutes());

      for (const role of ["viewer", "admin"] as const) {
        expect(await runSyntheticMonitor({ role: role as "viewer" }, options(fetchImpl).options)).toEqual({
          ok: false,
          code: "synthetic_unauthorized"
        });
      }
      expect(requests).toHaveLength(0);
      expect(sink.events.at(-1)).toMatchObject({ op: "synthetic.journey", errorCode: "synthetic_unauthorized" });
    });

    it("runs for the service and maintainer roles", async () => {
      for (const role of ["service", "maintainer"] as const) {
        const outcome = await runSyntheticMonitor({ role }, options(horizon(healthyRoutes()).fetchImpl).options);
        expect(outcome.ok).toBe(true);
      }
    });
  });

  describe("parseRetryAfter (RFC 9110 §10.2.3)", () => {
    it("reads delay-seconds and HTTP-dates, and ignores anything else", () => {
      const now = Date.parse("2026-10-17T00:00:00Z");
      expect(parseRetryAfter("7", now)).toBe(7_000);
      expect(parseRetryAfter("Sat, 17 Oct 2026 00:00:05 GMT", now)).toBe(5_000);
      expect(parseRetryAfter("Fri, 16 Oct 2026 00:00:00 GMT", now)).toBe(0);
      expect(parseRetryAfter("-1", now)).toBeUndefined();
      expect(parseRetryAfter("soon", now)).toBeUndefined();
      expect(parseRetryAfter(null, now)).toBeUndefined();
    });
  });
});
