import { describe, expect, it } from "vitest";
import {
  COMPLIANCE_SNAPSHOT_SCHEMA_VERSION,
  ComplianceSnapshotStore,
  canonicalJson,
  createComplianceSnapshot,
  verifyComplianceSnapshot,
  type ComplianceSnapshot,
  type ComplianceSnapshotInput,
  type SnapshotStorage
} from "../compliance-snapshot";

class MemoryStorage implements SnapshotStorage {
  readonly values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

const input: ComplianceSnapshotInput = {
  eventId: "evt-1",
  event: "authorization.revoked",
  capturedAt: "2026-10-18T10:00:00.000Z",
  activeRules: { maxFeeStroops: 500, requireSignature: true },
  state: { holders: 3 }
};

function created(): ComplianceSnapshot {
  const result = createComplianceSnapshot(input);
  if (!result.ok) throw new Error(`expected snapshot, got ${result.code}`);
  return result.value;
}

describe("canonicalJson", () => {
  it("sorts keys at every depth so equal data serialises identically", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });
});

describe("createComplianceSnapshot", () => {
  it("stores a canonical payload with schema version and integrity hash", () => {
    const snapshot = created();

    expect(snapshot.schemaVersion).toBe(COMPLIANCE_SNAPSHOT_SCHEMA_VERSION);
    expect(JSON.parse(snapshot.payload)).toMatchObject({ eventId: "evt-1", state: { holders: 3 } });
    expect(snapshot.integrityHash).toHaveLength(64);
  });

  it("produces the same hash for the same input", () => {
    expect(created().integrityHash).toBe(created().integrityHash);
  });

  it("rejects an empty event id", () => {
    const result = createComplianceSnapshot({ ...input, eventId: "  " });

    expect(result).toEqual({ ok: false, code: "invalid_snapshot_input" });
  });
});

describe("verifyComplianceSnapshot", () => {
  it("accepts an untouched snapshot", () => {
    expect(verifyComplianceSnapshot(created())).toEqual({ ok: true, value: true });
  });

  it("detects a payload that was altered after capture", () => {
    const snapshot = created();
    const tampered = { ...snapshot, payload: snapshot.payload.replace("\"holders\":3", "\"holders\":4") };

    expect(verifyComplianceSnapshot(tampered)).toEqual({ ok: false, code: "snapshot_tampered" });
  });

  it("refuses an unknown schema version", () => {
    const snapshot = { ...created(), schemaVersion: 99 };

    expect(verifyComplianceSnapshot(snapshot)).toEqual({ ok: false, code: "unsupported_schema_version" });
  });
});

describe("ComplianceSnapshotStore", () => {
  it("captures once per event and returns the original on repeat capture", () => {
    const storage = new MemoryStorage();
    const store = new ComplianceSnapshotStore(storage);

    const first = store.capture(input);
    const second = store.capture({ ...input, state: { holders: 99 } });

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value.payload).toBe(first.value.payload);
    expect(storage.values.size).toBe(1);
  });

  it("returns the stored snapshot to a maintainer after verifying it", () => {
    const store = new ComplianceSnapshotStore(new MemoryStorage());
    store.capture(input);

    const read = store.read("evt-1", "maintainer");

    expect(read.ok).toBe(true);
  });

  it("denies snapshot reads to the own scope", () => {
    const store = new ComplianceSnapshotStore(new MemoryStorage());
    store.capture(input);

    expect(store.read("evt-1", "own")).toEqual({ ok: false, code: "audit_denied" });
  });

  it("reports tampering when the stored envelope was modified", () => {
    const storage = new MemoryStorage();
    const store = new ComplianceSnapshotStore(storage);
    store.capture(input);
    const key = "utix:compliance-snapshot:v1:evt-1";
    const stored = JSON.parse(storage.getItem(key) ?? "{}") as ComplianceSnapshot;
    storage.setItem(key, JSON.stringify({ ...stored, payload: stored.payload.replace("true", "false") }));

    expect(store.read("evt-1", "maintainer")).toEqual({ ok: false, code: "snapshot_tampered" });
  });

  it("reports not found for an unknown event", () => {
    const store = new ComplianceSnapshotStore(new MemoryStorage());

    expect(store.read("missing", "maintainer")).toEqual({ ok: false, code: "snapshot_not_found" });
  });
});
