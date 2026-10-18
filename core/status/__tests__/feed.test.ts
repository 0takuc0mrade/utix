import { describe, expect, it } from "vitest";
import {
  buildPublicStatusFeed,
  componentFromHealthIndicator,
  maintenanceStateAt,
  publishPublicStatusFeed,
  STATUS_HISTORY_MS,
  validatePublicStatusFeed
} from "../feed";
import {
  PUBLIC_STATUS_SCHEMA_VERSION,
  type TrustedComponent,
  type TrustedIncident,
  type TrustedMaintenance,
  type TrustedStatusState
} from "../types";

type FeedJson = Record<string, unknown> & {
  components: Array<Record<string, unknown>>;
  incidents: Array<Record<string, unknown>>;
  maintenance: Array<Record<string, unknown>> | unknown;
};

const NOW = Date.parse("2026-03-10T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const iso = (ms: number): string => new Date(ms).toISOString();

const api: TrustedComponent = { id: "api", name: "Ticket API", status: "operational", visibility: "public" };
const redemption: TrustedComponent = {
  id: "redemption",
  name: "Redemption",
  status: "operational",
  visibility: "public"
};
const queue: TrustedComponent = {
  id: "worker-queue",
  name: "Internal worker queue",
  status: "major_outage",
  visibility: "internal",
  diagnostics: { host: "10.0.0.5", stack: "Error: ECONNRESET at worker.ts:42" }
};

function incident(overrides: Partial<TrustedIncident> = {}): TrustedIncident {
  return {
    id: "inc-1",
    title: "Redemption delays",
    summary: "Some redemptions are slow.",
    status: "investigating",
    impact: "major",
    startedAt: iso(NOW - 2 * HOUR),
    updatedAt: iso(NOW - HOUR),
    componentIds: ["redemption"],
    visibility: "public",
    ...overrides
  };
}

function window(overrides: Partial<TrustedMaintenance> = {}): TrustedMaintenance {
  return {
    id: "mnt-1",
    title: "Database upgrade",
    startsAt: iso(NOW - HOUR),
    endsAt: iso(NOW + HOUR),
    componentIds: ["api"],
    visibility: "public",
    ...overrides
  };
}

function state(partial: Partial<TrustedStatusState> = {}): TrustedStatusState {
  return { components: [api, redemption, queue], incidents: [], maintenance: [], ...partial };
}

describe("public status feed (#184)", () => {
  it("reports a healthy system as operational and ignores internal components", () => {
    const feed = buildPublicStatusFeed(state(), NOW);
    expect(feed).toEqual({
      schemaVersion: PUBLIC_STATUS_SCHEMA_VERSION,
      generatedAt: "2026-03-10T12:00:00.000Z",
      status: "operational",
      components: [
        { id: "api", name: "Ticket API", status: "operational" },
        { id: "redemption", name: "Redemption", status: "operational" }
      ],
      incidents: [],
      maintenance: []
    });
  });

  it("reports a degraded component as degraded", () => {
    const feed = buildPublicStatusFeed(
      state({ components: [{ ...api, status: "degraded" }, redemption, queue] }),
      NOW
    );
    expect(feed.status).toBe("degraded");
    expect(feed.components[0]).toEqual({ id: "api", name: "Ticket API", status: "degraded" });
  });

  it("derives the overall status from unresolved incident impact", () => {
    const at = (impact: "minor" | "major" | "critical") =>
      buildPublicStatusFeed(state({ incidents: [incident({ impact })] }), NOW).status;
    expect(at("minor")).toBe("degraded");
    expect(at("major")).toBe("partial_outage");
    expect(at("critical")).toBe("major_outage");
  });

  it("lists a resolved incident for a week without letting it affect the status", () => {
    const resolved = incident({
      status: "resolved",
      impact: "critical",
      resolvedAt: iso(NOW - HOUR),
      updatedAt: iso(NOW - HOUR)
    });
    const recent = buildPublicStatusFeed(state({ incidents: [resolved] }), NOW);
    expect(recent.status).toBe("operational");
    expect(recent.incidents).toHaveLength(1);
    expect(recent.incidents[0]).toMatchObject({ id: "inc-1", status: "resolved", resolvedAt: iso(NOW - HOUR) });

    const old = buildPublicStatusFeed(state({ incidents: [resolved] }), NOW + STATUS_HISTORY_MS + 2 * HOUR);
    expect(old.incidents).toEqual([]);
  });

  it("orders incidents newest first and ties by id", () => {
    const feed = buildPublicStatusFeed(
      state({
        incidents: [
          incident({ id: "inc-b", startedAt: iso(NOW - 3 * HOUR) }),
          incident({ id: "inc-c", startedAt: iso(NOW - HOUR) }),
          incident({ id: "inc-a", startedAt: iso(NOW - 3 * HOUR) })
        ]
      }),
      NOW
    );
    expect(feed.incidents.map((entry) => entry.id)).toEqual(["inc-c", "inc-a", "inc-b"]);
  });

  describe("maintenance windows", () => {
    it("moves from scheduled to in progress to completed with the clock alone", () => {
      const planned = window({ startsAt: iso(NOW + HOUR), endsAt: iso(NOW + 2 * HOUR) });
      expect(maintenanceStateAt(planned, NOW)).toBe("scheduled");
      expect(maintenanceStateAt(planned, NOW + HOUR)).toBe("in_progress");
      expect(maintenanceStateAt(planned, NOW + 2 * HOUR)).toBe("completed");

      const before = buildPublicStatusFeed(state({ maintenance: [planned] }), NOW);
      expect(before.status).toBe("operational");
      expect(before.maintenance[0]).toMatchObject({ state: "scheduled" });
      expect(before.components[0].status).toBe("operational");

      const during = buildPublicStatusFeed(state({ maintenance: [planned] }), NOW + HOUR + 1);
      expect(during.status).toBe("maintenance");
      expect(during.maintenance[0]).toMatchObject({ state: "in_progress" });
      expect(during.components.find((entry) => entry.id === "api")?.status).toBe("under_maintenance");
      expect(during.components.find((entry) => entry.id === "redemption")?.status).toBe("operational");

      const after = buildPublicStatusFeed(state({ maintenance: [planned] }), NOW + 3 * HOUR);
      expect(after.status).toBe("operational");
      expect(after.maintenance[0]).toMatchObject({ state: "completed" });
    });

    it("lets an outage outrank maintenance, and drops old or cancelled windows", () => {
      const outage = buildPublicStatusFeed(
        state({ maintenance: [window()], incidents: [incident({ impact: "critical" })] }),
        NOW
      );
      expect(outage.status).toBe("major_outage");

      const dropped = buildPublicStatusFeed(
        state({
          maintenance: [
            window({ id: "mnt-cancelled", cancelled: true }),
            window({ id: "mnt-old", startsAt: iso(NOW - 20 * 24 * HOUR), endsAt: iso(NOW - 19 * 24 * HOUR) })
          ]
        }),
        NOW
      );
      expect(dropped.maintenance).toEqual([]);
      expect(dropped.status).toBe("operational");
    });
  });

  describe("private data filtering", () => {
    it("never publishes internal items, diagnostics or internal notes", () => {
      const feed = buildPublicStatusFeed(
        state({
          incidents: [
            incident({ internalNotes: "root cause: leaked key in worker-queue" }),
            incident({ id: "inc-private", visibility: "internal", title: "Private incident" })
          ],
          maintenance: [
            window({ internalNotes: "rotate credentials on 10.0.0.5" }),
            window({ id: "mnt-private", visibility: "internal", title: "Private window" })
          ]
        }),
        NOW
      );
      const published = JSON.stringify(feed);
      for (const secret of [
        "10.0.0.5",
        "ECONNRESET",
        "worker-queue",
        "Internal worker queue",
        "leaked key",
        "rotate credentials",
        "inc-private",
        "Private incident",
        "mnt-private",
        "Private window",
        "diagnostics",
        "internalNotes"
      ]) {
        expect(published).not.toContain(secret);
      }
      expect(validatePublicStatusFeed(feed).ok).toBe(true);
    });

    it("does not reveal an internal component through an incident or window", () => {
      const feed = buildPublicStatusFeed(
        state({
          incidents: [incident({ componentIds: ["redemption", "worker-queue", "redemption"] })],
          maintenance: [window({ componentIds: ["worker-queue", "api"] })]
        }),
        NOW
      );
      expect(feed.incidents[0].componentIds).toEqual(["redemption"]);
      expect(feed.maintenance[0].componentIds).toEqual(["api"]);
    });

    it("does not let an internal component move the overall status", () => {
      expect(buildPublicStatusFeed(state({ components: [api, queue] }), NOW).status).toBe("operational");
    });

    it("keeps a health indicator internal unless a public id and name are given", () => {
      const indicator = {
        name: "Network: Horizon Testnet",
        status: "unhealthy" as const,
        message: "Invalid endpoint URL",
        details: { url: "https://user:pass@horizon.internal" },
        lastChecked: new Date(NOW)
      };
      const hidden = componentFromHealthIndicator(indicator);
      expect(hidden).toMatchObject({ visibility: "internal", status: "major_outage" });
      expect(buildPublicStatusFeed(state({ components: [hidden] }), NOW).components).toEqual([]);

      const shown = componentFromHealthIndicator(indicator, { id: "network", name: "Stellar network" });
      const feed = buildPublicStatusFeed(state({ components: [shown] }), NOW);
      expect(feed.components).toEqual([{ id: "network", name: "Stellar network", status: "major_outage" }]);
      expect(feed.status).toBe("major_outage");
      expect(JSON.stringify(feed)).not.toContain("horizon.internal");
      expect(JSON.stringify(feed)).not.toContain("Invalid endpoint URL");
    });
  });

  describe("determinism", () => {
    it("produces the same feed for the same state and instant, whatever the input order", () => {
      const incidents = [incident({ id: "inc-a" }), incident({ id: "inc-b", startedAt: iso(NOW - 5 * HOUR) })];
      const windows = [window({ id: "mnt-b" }), window({ id: "mnt-a" })];
      const forward = buildPublicStatusFeed(state({ incidents, maintenance: windows }), NOW);
      const reversed = buildPublicStatusFeed(
        state({
          components: [queue, redemption, api],
          incidents: [...incidents].reverse(),
          maintenance: [...windows].reverse()
        }),
        new Date(NOW)
      );
      expect(reversed).toEqual(forward);
    });
  });

  describe("schema validation", () => {
    const valid = () => buildPublicStatusFeed(state({ incidents: [incident()], maintenance: [window()] }), NOW);

    it("accepts what the builder produces and publishes it", () => {
      expect(validatePublicStatusFeed(valid())).toEqual({ ok: true, value: valid() });
      expect(publishPublicStatusFeed(state(), NOW).ok).toBe(true);
    });

    it("accepts a feed that went through JSON", () => {
      expect(validatePublicStatusFeed(JSON.parse(JSON.stringify(valid()))).ok).toBe(true);
    });

    it("rejects anything that is not exactly the published shape", () => {
      const feed = JSON.parse(JSON.stringify(valid())) as FeedJson;
      const cases: Array<[string, (copy: FeedJson) => void]> = [
        ["$", (copy) => void (copy.extra = true)],
        ["schemaVersion", (copy) => void (copy.schemaVersion = "0.9.0")],
        ["generatedAt", (copy) => void (copy.generatedAt = "yesterday")],
        ["status", (copy) => void (copy.status = "on_fire")],
        ["components[0]", (copy) => void (copy.components[0].diagnostics = { host: "10.0.0.5" })],
        ["components[1]", (copy) => void (copy.components[1].status = "unhealthy")],
        ["incidents[0]", (copy) => void (copy.incidents[0].internalNotes = "secret")],
        ["incidents[0]", (copy) => void (copy.incidents[0].startedAt = "2026-03-10")],
        ["incidents[0]", (copy) => void (copy.incidents[0].resolvedAt = undefined)],
        ["maintenance[0]", (copy) => void ((copy.maintenance as Array<Record<string, unknown>>)[0].state = "cancelled")],
        ["maintenance", (copy) => void (copy.maintenance = {})]
      ];
      for (const [path, mutate] of cases) {
        const copy = JSON.parse(JSON.stringify(feed)) as FeedJson;
        mutate(copy);
        expect(validatePublicStatusFeed(copy)).toEqual({ ok: false, code: "invalid_status_feed", detail: path });
      }
      for (const bad of [null, undefined, "feed", [], 7]) {
        expect(validatePublicStatusFeed(bad)).toEqual({ ok: false, code: "invalid_status_feed", detail: "$" });
      }
    });
  });
});
