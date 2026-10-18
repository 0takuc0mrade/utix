import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebhookVerifier } from '../verification';

/**
 * Golden corpus of malformed and adversarial webhook payloads. Each file under
 * `fixtures/corpus` is one scenario: the deliveries to replay in order, the
 * pinned clock they are verified at, and the exact verdict expected for each.
 * Large values are written as `{ "$repeat": { "value", "count" } }` so the
 * checked-in files stay small.
 */
const CORPUS_DIR = path.resolve(process.cwd(), 'core/webhooks/__tests__/fixtures/corpus');

interface Scenario {
  name: string;
  description: string;
  secret: string;
  now: number;
  deliveries: unknown[];
  expect: { valid: boolean; error?: string }[];
}

function expandRepeats(_key: string, value: unknown): unknown {
  if (value && typeof value === 'object' && '$repeat' in value) {
    const { value: unit, count } = (value as { $repeat: { value: string; count: number } }).$repeat;
    return unit.repeat(count);
  }
  return value;
}

function loadCorpus(): Scenario[] {
  return readdirSync(CORPUS_DIR)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => JSON.parse(readFileSync(path.join(CORPUS_DIR, file), 'utf8'), expandRepeats) as Scenario);
}

function run(scenario: Scenario) {
  const verifier = new WebhookVerifier();
  return scenario.deliveries.map((delivery) =>
    verifier.verifySignature(delivery as Parameters<WebhookVerifier['verifySignature']>[0], scenario.secret),
  );
}

describe('webhook golden fixture corpus', () => {
  const corpus = loadCorpus();

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('covers every class of malformed external payload', () => {
    const names = corpus.map((scenario) => scenario.name);
    for (const prefix of ['valid', 'invalid-signature', 'missing', 'oversized', 'replay', 'schema-drift']) {
      expect(names.some((name) => name.startsWith(prefix)), `no fixture for ${prefix}`).toBe(true);
    }
  });

  it('keeps one expected verdict per delivery and a unique name per fixture', () => {
    expect(new Set(corpus.map((scenario) => scenario.name)).size).toBe(corpus.length);
    for (const scenario of corpus) {
      expect(scenario.expect, scenario.name).toHaveLength(scenario.deliveries.length);
    }
  });

  for (const scenario of corpus) {
    it(`${scenario.name}: ${scenario.description}`, () => {
      vi.setSystemTime(scenario.now * 1000);
      expect(run(scenario)).toEqual(scenario.expect);
    });
  }

  it('returns the same verdicts when the corpus is replayed', () => {
    for (const scenario of corpus) {
      vi.setSystemTime(scenario.now * 1000);
      const first = run(scenario);
      expect(run(scenario), scenario.name).toEqual(first);
    }
  });
});
