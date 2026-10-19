/**
 * Immutable compliance snapshots for critical lifecycle events.
 *
 * A snapshot freezes the rules and data that were active when a critical event
 * happened. The payload is canonical JSON (sorted keys) and carries a SHA-256
 * integrity hash, so a later audit can prove the record was not altered.
 */
import { err, ok, type Result } from "@/core/result/result";
import { sha256Hex } from "@/core/ledger/sha256";
import type { AuditAction } from "./audit";

export const COMPLIANCE_SNAPSHOT_SCHEMA_VERSION = 1;

/** Lifecycle events that must be captured. Each one is also a sensitive audit action. */
export const CRITICAL_SNAPSHOT_EVENTS: readonly AuditAction[] = [
  "admin.config_changed",
  "authorization.granted",
  "authorization.revoked",
  "projection.activated",
  "reconciliation.repaired",
  "quota.override_granted",
  "freeze.bypassed"
];

export type CriticalSnapshotEvent = AuditAction;

export type ComplianceSnapshotErrorCode =
  | "invalid_snapshot_input"
  | "snapshot_not_found"
  | "snapshot_tampered"
  | "unsupported_schema_version"
  | "audit_denied";

export interface ComplianceSnapshotInput {
  readonly eventId: string;
  readonly event: CriticalSnapshotEvent;
  readonly capturedAt: string;
  readonly activeRules: Record<string, unknown>;
  readonly state: Record<string, unknown>;
}

export interface ComplianceSnapshot {
  readonly eventId: string;
  readonly schemaVersion: number;
  readonly event: CriticalSnapshotEvent;
  readonly capturedAt: string;
  /** Canonical JSON of the full payload. This is the exact text that was hashed. */
  readonly payload: string;
  readonly integrityHash: string;
}

export interface SnapshotStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const COMPLIANCE_SNAPSHOT_PREFIX = "utix:compliance-snapshot:v1:";

/** Stable JSON: object keys sorted at every depth so equal data always hashes equally. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const members = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${members.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function isNonEmpty(value: string): boolean {
  return value.trim().length > 0 && value.length <= 128;
}

export function createComplianceSnapshot(
  input: ComplianceSnapshotInput
): Result<ComplianceSnapshot, ComplianceSnapshotErrorCode> {
  if (!isNonEmpty(input.eventId) || !isNonEmpty(input.capturedAt)) {
    return err("invalid_snapshot_input");
  }

  const payload = canonicalJson({
    schemaVersion: COMPLIANCE_SNAPSHOT_SCHEMA_VERSION,
    eventId: input.eventId,
    event: input.event,
    capturedAt: input.capturedAt,
    activeRules: input.activeRules,
    state: input.state
  });

  return ok({
    eventId: input.eventId,
    schemaVersion: COMPLIANCE_SNAPSHOT_SCHEMA_VERSION,
    event: input.event,
    capturedAt: input.capturedAt,
    payload,
    integrityHash: sha256Hex(payload)
  });
}

/** Recomputes the hash and checks the payload matches the stored envelope. */
export function verifyComplianceSnapshot(
  snapshot: ComplianceSnapshot
): Result<true, ComplianceSnapshotErrorCode> {
  if (snapshot.schemaVersion !== COMPLIANCE_SNAPSHOT_SCHEMA_VERSION) {
    return err("unsupported_schema_version");
  }
  if (typeof snapshot.payload !== "string" || sha256Hex(snapshot.payload) !== snapshot.integrityHash) {
    return err("snapshot_tampered");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(snapshot.payload);
  } catch {
    return err("snapshot_tampered");
  }
  const envelope = parsed as Partial<ComplianceSnapshotInput & { schemaVersion: number }>;
  const matches =
    envelope.eventId === snapshot.eventId &&
    envelope.event === snapshot.event &&
    envelope.capturedAt === snapshot.capturedAt &&
    envelope.schemaVersion === snapshot.schemaVersion;

  return matches ? ok(true) : err("snapshot_tampered");
}

/**
 * Keeps one snapshot per event id. Capturing the same event again returns the
 * original, so a retried emitter cannot overwrite the record.
 */
export class ComplianceSnapshotStore {
  private readonly storage: SnapshotStorage;

  constructor(storage: SnapshotStorage) {
    this.storage = storage;
  }

  private key(eventId: string): string {
    return `${COMPLIANCE_SNAPSHOT_PREFIX}${eventId}`;
  }

  capture(input: ComplianceSnapshotInput): Result<ComplianceSnapshot, ComplianceSnapshotErrorCode> {
    const existing = this.storage.getItem(this.key(input.eventId));
    if (existing) {
      return this.parse(existing);
    }

    const created = createComplianceSnapshot(input);
    if (created.ok) {
      this.storage.setItem(this.key(input.eventId), JSON.stringify(created.value));
    }
    return created;
  }

  /**
   * Reads a snapshot for audit review. Only the maintainer scope may read them, and
   * the integrity hash is verified before the snapshot is returned.
   */
  read(
    eventId: string,
    scope: "own" | "maintainer"
  ): Result<ComplianceSnapshot, ComplianceSnapshotErrorCode> {
    if (scope !== "maintainer") return err("audit_denied");
    if (!isNonEmpty(eventId)) return err("invalid_snapshot_input");

    const raw = this.storage.getItem(this.key(eventId));
    if (!raw) return err("snapshot_not_found");

    return this.parse(raw);
  }

  private parse(raw: string): Result<ComplianceSnapshot, ComplianceSnapshotErrorCode> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return err("snapshot_tampered");
    }
    if (typeof parsed !== "object" || parsed === null) {
      return err("snapshot_tampered");
    }
    const snapshot = parsed as ComplianceSnapshot;
    const verified = verifyComplianceSnapshot(snapshot);
    return verified.ok ? ok(snapshot) : err(verified.code);
  }
}
