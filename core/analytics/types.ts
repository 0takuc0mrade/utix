export type EventCategory = 'feature_usage' | 'error' | 'performance' | 'user_action';
export type AggregationLevel = 'minute' | 'hour' | 'day' | 'week';

export interface PrivacyPreservingEvent {
  id: string;
  timestamp: Date;
  category: EventCategory;
  eventType: string;
  userId: string; // Hashed identifier
  sessionId: string; // Hashed identifier
  anonymousId: string; // Random identifier
  metadata: Record<string, unknown>;
  tags: string[];
}

export interface AggregatedMetric {
  id: string;
  timestamp: Date;
  aggregationLevel: AggregationLevel;
  eventType: string;
  category: EventCategory;
  count: number;
  metadata: Record<string, number | string>;
}

export interface AnalyticsSummary {
  timestamp: Date;
  period: AggregationLevel;
  totalEvents: number;
  eventsByType: Record<string, number>;
  eventsByCategory: Record<EventCategory, number>;
  topFeatures: Array<{ name: string; count: number }>;
  errorRate: number;
  performanceMetrics: PerformanceMetrics;
}

export interface PerformanceMetrics {
  averageResponseTime: number;
  p95ResponseTime: number;
  p99ResponseTime: number;
  errorCount: number;
}

export interface AnalyticsConfig {
  enablePII: boolean;
  hashingAlgorithm: 'sha256' | 'sha512';
  retentionDays: number;
  aggregationIntervals: AggregationLevel[];
  samplingRate: number;
  redactedFields: string[];
}

export interface MaintainerInsight {
  id: string;
  timestamp: Date;
  type: 'usage_trend' | 'error_spike' | 'performance_degradation' | 'feature_adoption';
  title: string;
  description: string;
  severity: 'info' | 'warning' | 'critical';
  data: Record<string, unknown>;
  actionItems: string[];
}

/**
 * Anomaly detection reporting for ticketing and event access operations.
 * These types are purely descriptive and read-only: they describe what the detector
 * found and how maintainers should triage it. They do not mutate any system state.
 */

export type AnomalySignalKind = 'volume' | 'timing' | 'actor_repetition' | 'failed_operations';

export type AnomalySeverity = 'info' | 'warning' | 'critical';

/**
 * Resources that an anomaly can be attributed to. These map to Utix domain objects
 * (events, tickets, organizers, actors) so maintainers can jump straight to the
 * affected entity.
 */
export type AnomalyResourceType =
  | 'event'
  | 'ticket'
  | 'organizer'
  | 'actor'
  | 'redemption_point'
  | 'transfer_channel';

export interface AnomalyResource {
  type: AnomalyResourceType;
  // Stable identifier of the affected resource (e.g. event id, ticket id, hashed actor id).
  id: string;
  // Human-readable label for report display.
  label?: string;
}

/**
 * Evidence behind a single finding. Keep this numeric and reference-oriented so the
 * report remains auditable and free of raw PII.
 */
export interface AnomalyEvidence {
  // Metric that triggered the finding (e.g. 'tickets_issued').
  metric: string;
  // Observed value during the window.
  observed: number;
  // Baseline expected value for the same window/scope.
  expected: number;
  // Ratio of observed to expected (1.0 = on baseline).
  ratio: number;
  // Score in [0, 1] expressing how confident the detector is.
  confidence: number;
  // Optional sample of reference ids (event/ticket/actor ids) for drill-down.
  sampleIds?: string[];
  // Free-form details such as the detection window or threshold used.
  details?: Record<string, number | string>;
}

export interface AnomalyFinding {
  id: string;
  // When the anomaly was observed.
  timestamp: Date;
  kind: AnomalySignalKind;
  severity: AnomalySeverity;
  // Short stable code for filtering/deduplication (e.g. 'volume_issue_spike').
  code: string;
  title: string;
  description: string;
  // The primary resource affected by this finding.
  resource: AnomalyResource;
  // Additional resources correlated with the finding (e.g. actor + event).
  relatedResources: AnomalyResource[];
  evidence: AnomalyEvidence;
  // Ordered triage steps for maintainers.
  triageSteps: string[];
  // Explanation of why this may be a false positive and how to confirm.
  falsePositiveNotes?: string[];
  // Tags for grouping (e.g. 'spike', 'repeated_failure', 'single_actor').
  tags: string[];
  // Whether this finding was suppressed by false-positive mitigation rules.
  suppressedByMitigation?: boolean;
}

export interface AnomalyReportSummary {
  totalFindings: number;
  bySeverity: Record<AnomalySeverity, number>;
  byKind: Record<AnomalySignalKind, number>;
  byResourceType: Record<AnomalyResourceType, number>;
}

/**
 * Read-only anomaly report. Grouped by severity and affected resource so it can be
 * rendered directly on organizer dashboards and in maintainer tooling.
 */
export interface AnomalyReport {
  // Window covered by the report.
  generatedAt: Date;
  windowStart: Date;
  windowEnd: Date;
  summary: AnomalyReportSummary;
  // Findings grouped by severity, each group sorted by confidence descending.
  bySeverity: Record<AnomalySeverity, AnomalyFinding[]>;
  // Findings grouped by affected resource type.
  byResourceType: Record<AnomalyResourceType, AnomalyFinding[]>;
  // Flat list of all findings for programmatic consumers.
  findings: AnomalyFinding[];
}


// ---------------------------------------------------------------------------------
// Detection configuration
// ---------------------------------------------------------------------------------

/**
 * Per-signal thresholds. Defaults are defined in the detector and are intentionally
 * conservative to reduce false positives. Overrides are merged on top of defaults.
 */
export interface AnomalyThresholds {
  // Multiple of baseline volume that triggers a volume finding.
  volumeMultiple: number;
  // Minimum absolute count before volume findings are considered (avoids noise on low traffic).
  volumeMinimumCount: number;
  // Multiple of baseline failure rate that triggers a failed-operations finding.
  failureRateMultiple: number;
  // Minimum number of failures in the window before a finding is raised.
  failureMinimumCount: number;
  // Number of repeated actions by a single actor that is considered suspicious.
  actorRepetitionThreshold: number;
  // Minimum number of distinct actors for a timing cluster to be meaningful.
  timingClusterMinimumActors: number;
  // Maximum number of events in a single minute that is considered normal for timing.
  timingBurstThreshold: number;
  // Minimum confidence [0, 1] for a finding to be included in the report.
  minimumConfidence: number;
}

export interface AnomalyDetectionConfig {
  // Window used to compute baselines and detect anomalies.
  windowMs: number;
  // How far back to look for baseline data.
  baselineWindowMs: number;
  // Minimum number of events required before a baseline is trusted.
  minBaselineEvents: number;
  thresholds: Partial<AnomalyThresholds>;
  // Event types to ignore entirely (e.g. known background jobs).
  ignoredEventTypes?: string[];
  // Actor ids to ignore (e.g. internal automation accounts).
  ignoredActorIds?: string[];
}
