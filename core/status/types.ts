/**
 * Types for the schema-backed public status feed (#184).
 *
 * Two shapes live here on purpose. The `Trusted*` types are internal state and
 * may carry diagnostics. The `Public*` types are the published schema; the feed
 * builder copies only their fields, so internal data cannot reach the feed.
 */

export const PUBLIC_STATUS_SCHEMA_VERSION = "1.0.0";

export const COMPONENT_STATUSES = [
  "operational",
  "degraded",
  "partial_outage",
  "major_outage",
  "under_maintenance"
] as const;
export const OVERALL_STATUSES = ["operational", "degraded", "maintenance", "partial_outage", "major_outage"] as const;
export const INCIDENT_STATUSES = ["investigating", "identified", "monitoring", "resolved"] as const;
export const INCIDENT_IMPACTS = ["minor", "major", "critical"] as const;
export const MAINTENANCE_STATES = ["scheduled", "in_progress", "completed"] as const;

export type ComponentStatus = (typeof COMPONENT_STATUSES)[number];
/** Ordered from best to worst, so a higher index outranks a lower one. */
export type OverallStatus = (typeof OVERALL_STATUSES)[number];
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];
export type IncidentImpact = (typeof INCIDENT_IMPACTS)[number];
export type MaintenanceState = (typeof MAINTENANCE_STATES)[number];

export type StatusVisibility = "public" | "internal";

export interface TrustedComponent {
  readonly id: string;
  readonly name: string;
  readonly status: ComponentStatus;
  readonly visibility: StatusVisibility;
  /** Internal-only: raw health details, endpoints, error text. Never published. */
  readonly diagnostics?: Readonly<Record<string, unknown>>;
}

export interface TrustedIncident {
  readonly id: string;
  /** Written for the public. */
  readonly title: string;
  readonly summary: string;
  readonly status: IncidentStatus;
  readonly impact: IncidentImpact;
  /** ISO-8601 instants. */
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly resolvedAt?: string;
  readonly componentIds: readonly string[];
  readonly visibility: StatusVisibility;
  /** Internal-only: timeline, root cause, mitigation. Never published. */
  readonly internalNotes?: string;
}

export interface TrustedMaintenance {
  readonly id: string;
  readonly title: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly componentIds: readonly string[];
  readonly visibility: StatusVisibility;
  /** A cancelled window is never published. */
  readonly cancelled?: boolean;
  /** Internal-only. Never published. */
  readonly internalNotes?: string;
}

export interface TrustedStatusState {
  readonly components: readonly TrustedComponent[];
  readonly incidents: readonly TrustedIncident[];
  readonly maintenance: readonly TrustedMaintenance[];
}

export interface PublicComponent {
  readonly id: string;
  readonly name: string;
  readonly status: ComponentStatus;
}

export interface PublicIncident {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly status: IncidentStatus;
  readonly impact: IncidentImpact;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly resolvedAt: string | null;
  readonly componentIds: readonly string[];
}

export interface PublicMaintenance {
  readonly id: string;
  readonly title: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly state: MaintenanceState;
  readonly componentIds: readonly string[];
}

export interface PublicStatusFeed {
  readonly schemaVersion: typeof PUBLIC_STATUS_SCHEMA_VERSION;
  /** The instant the feed describes. */
  readonly generatedAt: string;
  readonly status: OverallStatus;
  readonly components: readonly PublicComponent[];
  readonly incidents: readonly PublicIncident[];
  readonly maintenance: readonly PublicMaintenance[];
}

export type StatusFeedErrorCode = "invalid_status_feed";
