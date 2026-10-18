import { describe, it, expect } from 'vitest';
import { TamperEvidentHistory } from '../core/audit/tamper-evident-history';
import { ERROR_CODES, getErrorDefinition, isRetryable } from '../core/errors/error-codes';
import { getStatusAnnouncement, getStatusAriaAttributes, getStatusLivePoliteness } from '../core/ui/accessibility';
import { assessRisk, RISK_SIGNALS } from '../core/policy/risk-scoring';

// ─── Tamper-evident change history (#76) ─────────────────────────────────────

describe('TamperEvidentHistory', () => {
  it('records mutations with chain hashes', () => {
    const history = new TamperEvidentHistory();
    const entry = history.record({
      recordType: 'ticket',
      recordId: 't-1',
      mutationType: 'create',
      actor: 'admin',
      reason: 'Initial creation',
      before: null,
      after: { owner: 'user-1' },
    });

    expect(entry.seq).toBe(1);
    expect(entry.hash).toHaveLength(64);
    expect(entry.prevHash).toBe('0'.repeat(64));
  });

  it('links entries in a hash chain', () => {
    const history = new TamperEvidentHistory();
    const e1 = history.record({
      recordType: 'ticket', recordId: 't-1', mutationType: 'create',
      actor: 'admin', reason: 'create', before: null, after: { owner: 'a' },
    });
    const e2 = history.record({
      recordType: 'ticket', recordId: 't-1', mutationType: 'transfer',
      actor: 'a', reason: 'transfer', before: { owner: 'a' }, after: { owner: 'b' },
    });

    expect(e2.prevHash).toBe(e1.hash);
  });

  it('verifies clean history', () => {
    const history = new TamperEvidentHistory();
    for (let i = 0; i < 5; i++) {
      history.record({
        recordType: 'ticket', recordId: 't-1', mutationType: 'update',
        actor: 'admin', reason: `update ${i}`, before: {}, after: {},
      });
    }
    const result = history.verify();
    expect(result.valid).toBe(true);
  });

  it('detects tampered entries', () => {
    const history = new TamperEvidentHistory();
    history.record({
      recordType: 'ticket', recordId: 't-1', mutationType: 'create',
      actor: 'admin', reason: 'create', before: null, after: { owner: 'a' },
    });
    // Tamper with the entry
    (history as any).entries[0].actor = 'attacker';
    const result = history.verify();
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('hash mismatch');
  });
});

// ─── Stable error codes (#267) ───────────────────────────────────────────────

describe('Error codes', () => {
  it('every code has a remediation hint', () => {
    for (const [name, def] of Object.entries(ERROR_CODES)) {
      expect(def.remediation).toBeTruthy();
      expect(def.message).toBeTruthy();
      expect(def.code).toBe(name);
    }
  });

  it('getErrorDefinition returns the correct definition', () => {
    const def = getErrorDefinition('RATE_LIMITED');
    expect(def.status).toBe(429);
    expect(def.retryable).toBe(true);
  });

  it('isRetryable correctly classifies errors', () => {
    expect(isRetryable('TIMEOUT')).toBe(true);
    expect(isRetryable('INVALID_INPUT')).toBe(false);
    expect(isRetryable('NETWORK_ERROR')).toBe(true);
    expect(isRetryable('NOT_FOUND')).toBe(false);
  });
});

// ─── Accessibility coverage (#274) ───────────────────────────────────────────

describe('Accessibility utilities', () => {
  it('getStatusAnnouncement returns appropriate messages', () => {
    expect(getStatusAnnouncement('loading')).toContain('Loading');
    expect(getStatusAnnouncement('success', 'Saved!', 'Error!')).toBe('Saved!');
    expect(getStatusAnnouncement('error', 'Saved!', 'Error!')).toBe('Error!');
    expect(getStatusAnnouncement('idle')).toBe('');
  });

  it('errors are assertive, others are polite', () => {
    expect(getStatusLivePoliteness('error')).toBe('assertive');
    expect(getStatusLivePoliteness('loading')).toBe('polite');
    expect(getStatusLivePoliteness('success')).toBe('polite');
  });

  it('getStatusAriaAttributes sets correct role and busy state', () => {
    const loading = getStatusAriaAttributes('loading');
    expect(loading['aria-busy']).toBe(true);
    expect(loading.role).toBe('status');

    const error = getStatusAriaAttributes('error');
    expect(error['aria-busy']).toBe(false);
    expect(error.role).toBe('alert');
    expect(error['aria-live']).toBe('assertive');
  });
});

// ─── Explainable risk scoring (#276) ─────────────────────────────────────────

describe('Risk scoring', () => {
  it('returns low risk when no signals fire', () => {
    const result = assessRisk([]);
    expect(result.score).toBe(0);
    expect(result.level).toBe('low');
    expect(result.explanation).toContain('no risk signals');
  });

  it('accumulates scores from fired signals', () => {
    const result = assessRisk([
      { ...RISK_SIGNALS.highValueTransfer(1000), fired: true },
      { ...RISK_SIGNALS.newAccount(3), fired: true },
      { ...RISK_SIGNALS.unusualLocation('US', 'UK'), fired: false },
    ]);

    expect(result.score).toBe(45); // 30 + 15
    expect(result.level).toBe('medium');
    expect(result.signals).toHaveLength(2);
    expect(result.explanation).toContain('High-value transfer');
    expect(result.explanation).toContain('New account');
    expect(result.explanation).not.toContain('Unusual location');
  });

  it('maps scores to risk levels', () => {
    const high = assessRisk([
      { ...RISK_SIGNALS.highValueTransfer(1000), fired: true },
      { ...RISK_SIGNALS.bulkOperation(50), fired: true },
    ]);
    expect(high.level).toBe('high');

    const critical = assessRisk([
      { ...RISK_SIGNALS.highValueTransfer(1000), fired: true },
      { ...RISK_SIGNALS.bulkOperation(50), fired: true },
      { ...RISK_SIGNALS.rapidSuccession(10, 5000), fired: true },
    ]);
    expect(critical.level).toBe('critical');
  });

  it('explains why each signal fired', () => {
    const result = assessRisk([
      { ...RISK_SIGNALS.highValueTransfer(5000), fired: true },
    ]);

    const signal = result.signals[0];
    expect(signal.explanation).toContain('5000'); // threshold substituted
  });
});
