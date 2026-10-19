import { describe, it, expect, beforeEach } from 'vitest';
import { webhookVerifier } from '../verification';
import type { WebhookMessage } from '../types';

describe('WebhookVerifier', () => {
  const testSecret = 'test-secret-key-12345';

  beforeEach(() => {
    // Clear replay records before each test
    webhookVerifier.cleanupOldRecords(0);
  });

  it('should generate valid signature', () => {
    const payload = { event: 'test', data: { id: 123 } };
    const signature = webhookVerifier.generateSignature(JSON.stringify(payload), testSecret);

    expect(signature).toBeDefined();
    expect(signature.length).toBe(64); // sha256 hex is 64 chars
  });

  it('should create signed message', () => {
    const payload = { test: 'data' };
    const message = webhookVerifier.createSignedMessage(payload, testSecret);

    expect(message.id).toBeDefined();
    expect(message.signature.nonce).toBeDefined();
    expect(message.signature.timestamp).toBeDefined();
    expect(message.signature.signature).toBeDefined();
  });

  it('should verify valid signature', () => {
    const payload = { test: 'data' };
    const message = webhookVerifier.createSignedMessage(payload, testSecret);

    const result = webhookVerifier.verifySignature(message, testSecret);

    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('should reject invalid signature', () => {
    const payload = { test: 'data' };
    const message = webhookVerifier.createSignedMessage(payload, testSecret);

    // Tamper with message
    message.data = { test: 'modified' };

    const result = webhookVerifier.verifySignature(message, testSecret);

    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('should reject replay attacks', () => {
    const payload = { test: 'data' };
    const message = webhookVerifier.createSignedMessage(payload, testSecret);

    // First verification should pass
    const result1 = webhookVerifier.verifySignature(message, testSecret);
    expect(result1.valid).toBe(true);

    // Same nonce again should be rejected
    const result2 = webhookVerifier.verifySignature(message, testSecret);
    expect(result2.valid).toBe(false);
    expect(result2.error).toContain('replay');
  });

  it('should reject expired timestamps', () => {
    const payload = { test: 'data' };
    const message = webhookVerifier.createSignedMessage(payload, testSecret);

    // Set timestamp to 10 minutes ago
    message.signature.timestamp = Math.floor(Date.now() / 1000) - 600;

    const result = webhookVerifier.verifySignature(message, testSecret);

    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('should track delivery attempts', () => {
    const subscriber = {
      id: 'sub-1',
      url: 'https://example.com/webhooks',
      secret: 'secret',
      events: ['test.event'],
      active: true,
      createdAt: new Date(),
      failureCount: 0,
      successCount: 0,
    };

    webhookVerifier.registerSubscriber(subscriber);

    webhookVerifier.recordDeliveryAttempt({
      id: 'attempt-1',
      subscriberId: 'sub-1',
      messageId: 'msg-1',
      timestamp: new Date(),
      statusCode: 200,
      retryCount: 0,
      success: true,
    });

    const attempts = webhookVerifier.getDeliveryAttempts('sub-1');
    expect(attempts.length).toBe(1);
    expect(attempts[0].success).toBe(true);
  });

  it('should get replay protection stats', () => {
    const payload = { test: 'data' };
    const message = webhookVerifier.createSignedMessage(payload, testSecret);

    webhookVerifier.verifySignature(message, testSecret);

    const stats = webhookVerifier.getReplayProtectionStats();
    expect(stats.totalNonces).toBe(1);
  });

  describe('sensitive-content boundaries', () => {
    it('should not execute script payloads during signing or verification', () => {
      const payload = {
        event: 'test',
        data: '<script>window.__puwn=1</script>',
      };

      const message = webhookVerifier.createSignedMessage(payload, testSecret);
      const result = webhookVerifier.verifySignature(message, testSecret);

      expect(result.valid).toBe(true);
      expect(message.data).toEqual(payload);
      expect((message as any).__executed).toBeUndefined();
      expect((globalThis as any).__puwn).toBeUndefined();
    });

    it('should not leak private signature fields into payload data', () => {
      const payload = {
        event: 'test',
        data: { id: 1 },
      };

      const message = webhookVerifier.createSignedMessage(payload, testSecret);

      expect(message.data).toEqual(payload);
      expect((message.data as any).signature).toBeUndefined();
      expect((message.data as any).nonce).toBeUndefined();
      expect((message.data as any).timestamp).toBeUndefined();
      expect((message.data as any).secret).toBeUndefined();
    });

    it('should not allow signature bypass via prototype pollution keys', () => {
      const payload = JSON.parse('{"__proto__":{"admin":true},"event":"test"}');
      const message = webhookVerifier.createSignedMessage(payload, testSecret);

      const result = webhookVerifier.verifySignature(message, testSecret);
      expect(result.valid).toBe(true);
      expect((Object.prototype as any).admin).toBeUndefined();
      expect(({} as any).admin).toBeUndefined();
    });

    it('should reject tampered payloads with extra injected fields', () => {
      const payload = { event: 'test', data: { id: 1 } };
      const message = webhookVerifier.createSignedMessage(payload, testSecret);

      (message.data as any).injected = '<img src=x onerror=alert(1)>';

      const result = webhookVerifier.verifySignature(message, testSecret);
      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should reject signatures produced with a wrong secret', () => {
      const payload = { event: 'test' };
      const message = webhookVerifier.createSignedMessage(payload, 'wrong-secret');

      const result = webhookVerifier.verifySignature(message, testSecret);
      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should not expose subscriber secrets in delivery attempts', () => {
      const subscriber = {
        id: 'sub-secret',
        url: 'https://example.com/webhooks',
        secret: 'super-private-secret',
        events: ['test.event'],
        active: true,
        createdAt: new Date(),
        failureCount: 0,
        successCount: 0,
      };
      webhookVerifier.registerSubscriber(subscriber);

      webhookVerifier.recordDeliveryAttempt({
        id: 'attempt-2',
        subscriberId: 'sub-secret',
        messageId: 'msg-2',
        timestamp: new Date(),
        statusCode: 500,
        retryCount: 1,
        success: false,
      });

      const attempts = webhookVerifier.getDeliveryAttempts('sub-secret');
      expect(attempts.length).toBe(1);
      expect((attempts[0] as any).secret).toBeUndefined();
      expect(JSON.stringify(attempts[0])).not.toContain('super-private-secret');
    });

    it('should not allow unknown subscribers to receive delivery records', () => {
      const attempts = webhookVerifier.getDeliveryAttempts('unknown-sub');
      expect(attempts).toEqual([]);
    });

    it('should not allow nonce reuse across different payloads', () => {
      const message1 = webhookVerifier.createSignedMessage({ event: 'a' }, testSecret);
      const result1 = webhookVerifier.verifySignature(message1, testSecret);
      expect(result1.valid).toBe(true);

      const message2: WebhookMessage = {
        ...message1,
        data: { event: 'b' },
      };

      const result2 = webhookVerifier.verifySignature(message2, testSecret);
      expect(result2.valid).toBe(false);
      expect(result2.error).toBeDefined();
    });

    it('should not allow malformed signature structures to pass verification', () => {
      const message = webhookVerifier.createSignedMessage({ event: 'test' }, testSecret);
      (message.signature as any).signature = '<script>alert(1)</script>';

      const result = webhookVerifier.verifySignature(message, testSecret);
      expect(result.valid).toBe(false);
    });
  });
});
