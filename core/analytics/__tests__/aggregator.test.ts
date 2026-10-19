import { describe, it, expect, beforeEach } from 'vitest';
import { analyticsAggregator } from '../aggregator';

describe('AnalyticsAggregator', () => {
  beforeEach(() => {
    // Clear events before each test
    while (analyticsAggregator.getEventCount() > 0) {
      analyticsAggregator.cleanup(0);
    }
  });

  it('should record events', () => {
    const event = analyticsAggregator.recordEvent({
      category: 'feature_usage',
      eventType: 'address_validated',
      userId: 'user-123',
      sessionId: 'session-456',
    });

    expect(event).toBeDefined();
    expect(event?.category).toBe('feature_usage');
    expect(event?.eventType).toBe('address_validated');
  });

  it('should generate summary', async () => {
    analyticsAggregator.recordEvent({
      category: 'feature_usage',
      eventType: 'balance_checked',
      userId: 'user-1',
    });

    analyticsAggregator.recordEvent({
      category: 'feature_usage',
      eventType: 'trustline_verified',
      userId: 'user-2',
    });

    const summary = await analyticsAggregator.generateSummary('day');

    expect(summary.totalEvents).toBe(2);
    expect(summary.topFeatures.length).toBeGreaterThan(0);
  });

  it('should detect error spikes', async () => {
    for (let i = 0; i < 10; i++) {
      analyticsAggregator.recordEvent({
        category: 'error',
        eventType: 'validation_failed',
        userId: `user-${i}`,
      });
    }

    const insights = await analyticsAggregator.generateMaintainerInsights();

    const errorSpike = insights.find(i => i.type === 'error_spike');
    expect(errorSpike).toBeDefined();
  });

  it('should redact sensitive fields', () => {
    const event = analyticsAggregator.recordEvent({
      category: 'feature_usage',
      eventType: 'login',
      metadata: {
        username: 'john_doe',
        password: 'secret123',
        authToken: 'token-xyz',
      },
    });

    expect(event?.metadata.password).toBe('[REDACTED]');
    expect(event?.metadata.authToken).toBe('[REDACTED]');
  });

  it('should hash identifiers', () => {
    const event = analyticsAggregator.recordEvent({
      category: 'feature_usage',
      eventType: 'test',
      userId: 'user-123',
    });

    // Hashed identifiers should be hex strings (not the original value)
    expect(event?.userId).not.toBe('user-123');
    expect(event?.userId?.match(/^[a-f0-9]{64}$/)).toBeTruthy();
  });

  it('should cleanup old events', () => {
    analyticsAggregator.recordEvent({
      category: 'feature_usage',
      eventType: 'test1',
    });

    analyticsAggregator.recordEvent({
      category: 'feature_usage',
      eventType: 'test2',
    });

    const removed = analyticsAggregator.cleanup(0);

    expect(removed).toBe(2);
    expect(analyticsAggregator.getEventCount()).toBe(0);
  });

  it('should detect feature adoption trends', async () => {
    // Record events for today
    for (let i = 0; i < 20; i++) {
      analyticsAggregator.recordEvent({
        category: 'feature_usage',
        eventType: 'feature_used',
        userId: `user-${i}`,
      });
    }

    const insights = await analyticsAggregator.generateMaintainerInsights();

    const usageTrend = insights.find(i => i.type === 'usage_trend');
    expect(usageTrend).toBeDefined();
  });

  it('should track maintainer insights', async () => {
    analyticsAggregator.recordEvent({
      category: 'feature_usage',
      eventType: 'test_feature',
    });

    await analyticsAggregator.generateMaintainerInsights();

    const insights = analyticsAggregator.getInsights();
    expect(Array.isArray(insights)).toBe(true);
  });

  describe('anomaly detection', () => {
    it('reports normal baseline without anomalies', async () => {
      const now = Date.now();
      for (let i = 0; i < 5; i++) {
        analyticsAggregator.recordEvent({
          category: 'ticket_issuance',
          eventType: 'ticket_issued',
          userId: `user-${i}`,
          timestamp: now - i * 60_000,
        });
      }

      const report = await analyticsAggregator.generateAnomalyReport();
      expect(report.findings.length).toBe(0);
      expect(report.summary.totalFindings).toBe(0);
    });

    it('detects volume spikes against baseline', async () => {
      const now = Date.now();
      // Baseline: a few events per hour over several hours
      for (let h = 1; h <= 6; h++) {
        for (let i = 0; i < 2; i++) {
          analyticsAggregator.recordEvent({
            category: 'ticket_redemption',
            eventType: 'ticket_redeemed',
            userId: `baseline-user-${h}-${i}`,
            timestamp: now - h * 3_600_000,
          });
        }
      }
      // Spike: many events in the current hour
      for (let i = 0; i < 40; i++) {
        analyticsAggregator.recordEvent({
          category: 'ticket_redemption',
          eventType: 'ticket_redeemed',
          userId: `spike-user-${i}`,
          timestamp: now - (i % 60) * 1_000,
        });
      }

      const report = await analyticsAggregator.generateAnomalyReport();
      const volume = report.findings.find(f => f.signal === 'volume_spike');
      expect(volume).toBeDefined();
      expect(['medium', 'high', 'critical']).toContain(volume?.severity);
      expect(volume?.resource).toBe('ticket_redemption');
    });

    it('detects repeated failures from an actor', async () => {
      const now = Date.now();
      for (let i = 0; i < 12; i++) {
        analyticsAggregator.recordEvent({
          category: 'error',
          eventType: 'ticket_redemption_failed',
          userId: 'repeat-failure-actor',
          timestamp: now - i * 5_000,
        });
      }

      const report = await analyticsAggregator.generateAnomalyReport();
      const failure = report.findings.find(f => f.signal === 'repeated_failure');
      expect(failure).toBeDefined();
      expect(['medium', 'high', 'critical']).toContain(failure?.severity);
    });

    it('detects suspicious actor repetition', async () => {
      const now = Date.now();
      for (let i = 0; i < 30; i++) {
        analyticsAggregator.recordEvent({
          category: 'ticket_transfer',
          eventType: 'ticket_transferred',
          userId: 'suspicious-actor',
          timestamp: now - i * 2_000,
        });
      }

      const report = await analyticsAggregator.generateAnomalyReport();
      const actor = report.findings.find(f => f.signal === 'actor_repetition');
      expect(actor).toBeDefined();
      expect(['medium', 'high', 'critical']).toContain(actor?.severity);
    });

    it('detects unusual timing patterns', async () => {
      // Events clustered at an off-hours window (03:00 UTC)
      const base = new Date();
      base.setUTCHours(3, 0, 0, 0);
      const offHours = base.getTime();
      for (let i = 0; i < 25; i++) {
        analyticsAggregator.recordEvent({
          category: 'ticket_issuance',
          eventType: 'ticket_issued',
          userId: `off-hours-user-${i}`,
          timestamp: offHours + i * 1_000,
        });
      }

      const report = await analyticsAggregator.generateAnomalyReport();
      const timing = report.findings.find(f => f.signal === 'timing_anomaly');
      expect(timing).toBeDefined();
    });

    it('groups findings by severity and resource', async () => {
      const now = Date.now();
      for (let i = 0; i < 50; i++) {
        analyticsAggregator.recordEvent({
          category: 'ticket_redemption',
          eventType: 'ticket_redeemed',
          userId: `group-user-${i}`,
          timestamp: now - i * 500,
        });
      }

      const report = await analyticsAggregator.generateAnomalyReport();
      expect(report.bySeverity).toBeDefined();
      expect(report.byResource).toBeDefined();
      for (const finding of report.findings) {
        expect(report.bySeverity[finding.severity]).contains(finding);
        expect(report.byResource[finding.resource]).contains(finding);
      }
    });

    it('suppresses low-confidence noise from small samples', async () => {
      // Only two events -- below minimum sample threshold
      const now = Date.now();
      for (let i = 0; i < 2; i++) {
        analyticsAggregator.recordEvent({
          category: 'ticket_redemption',
          eventType: 'ticket_redeemed',
          userId: `noise-user-${i}`,
          timestamp: now - i * 1_000,
        });
      }

      const report = await analyticsAggregator.generateAnomalyReport();
      expect(report.findings.length).toBe(0);
    });
  });
});
