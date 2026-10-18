import type { AuditEvent } from "./audit";

export interface AuditEvidenceBundle {
  readonly schemaVersion: "1.0";
  readonly generatedAt: string;
  readonly scope: "own" | "maintainer";
  readonly eventCount: number;
  readonly events: readonly AuditEvent[];
  /** Digest of the canonical, redacted event payload. */
  readonly digest: string;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function digest(value: unknown): string {
  let hash = 2166136261;
  for (const character of canonical(value)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function createAuditEvidenceBundle(input: {
  events: readonly AuditEvent[];
  scope: "own" | "maintainer";
  generatedAt?: string;
}): AuditEvidenceBundle {
  const events = input.events.map((event) => ({ ...event, before: event.before && { ...event.before }, after: event.after && { ...event.after } }));
  return {
    schemaVersion: "1.0",
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    scope: input.scope,
    eventCount: events.length,
    events,
    digest: digest(events)
  };
}

export function verifyAuditEvidenceBundle(bundle: AuditEvidenceBundle): boolean {
  return bundle.schemaVersion === "1.0" && bundle.eventCount === bundle.events.length && bundle.digest === digest(bundle.events);
}
