import { describe, expect, it } from "vitest";
import { createIsolatedAuditTrail } from "@/core/audit/audit";
import { exportRecords, EXPORT_CURRENT_SCHEMA_VERSION, type ExportRecordSource } from "@/core/export/exporter";
import { classifyHorizonError } from "@/core/horizon/errors";

const SECRET = "SAKJFPVKPHAWLBQNFI3HK4DXMTPBSVJ6VNK4AXHYJNPEWTTZOFWLZWNW";

describe("redaction boundaries", () => {
  it("keeps sensitive audit log context out of persisted events", () => {
    const trail = createIsolatedAuditTrail();
    trail.record({
      action: "record.state_changed",
      actor: { kind: "maintainer", id: "maintainer-1" },
      target: { kind: "worker_job", id: "job-1" },
      before: { state: "queued", authorization: SECRET },
      after: { state: "retrying", details: "Bearer eyJhbGciOiJIUzI1NiJ9" },
      at: "2026-09-29T00:00:00.000Z"
    });

    const serialized = JSON.stringify(trail.all());
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(serialized).toContain("[REDACTED]");
  });

  it("redacts exported records while enforcing authorization", () => {
    const source: ExportRecordSource = {
      recordType: "operation_log",
      schemaVersion: EXPORT_CURRENT_SCHEMA_VERSION,
      scope: "own",
      collect: () => [{ operation: "wallet.export", secret: SECRET, result: "success" }]
    };

    const allowed = exportRecords(
      { schemaVersion: EXPORT_CURRENT_SCHEMA_VERSION, scope: "own", actor: { kind: "user" } },
      [source]
    );
    expect(allowed.ok).toBe(true);
    if (allowed.ok) {
      expect(allowed.value.records[0].secret).toBe("[REDACTED]");
      expect(JSON.stringify(allowed.value)).not.toContain(SECRET);
    }

    const denied = exportRecords(
      { schemaVersion: EXPORT_CURRENT_SCHEMA_VERSION, scope: "maintainer", actor: { kind: "user" } },
      [source]
    );
    expect(denied).toEqual({ ok: false, code: "export_denied" });
  });

  it("redacts Horizon error responses without losing retry guidance", () => {
    const classified = classifyHorizonError({
      response: {
        status: 503,
        data: {
          title: "upstream failure",
          detail: "upstream token: " + SECRET
        }
      }
    });

    expect(classified.code).toBe("server_error");
    expect(classified.retryable).toBe(true);
    expect(classified.detail.title).toBe("upstream failure");
    expect(classified.detail.detail).toBe("upstream token: [REDACTED]");
    expect(JSON.stringify(classified)).not.toContain(SECRET);
  });
});
