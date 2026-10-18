import crypto from 'crypto';
import {
  WebhookSignature,
  WebhookMessage,
  WebhookVerificationConfig,
  ReplayProtectionRecord,
  WebhookSubscriber,
  WebhookDeliveryAttempt,
} from './types';

/** Upper bound on a message's serialized `data`, before any hashing happens. */
export const MAX_WEBHOOK_DATA_LENGTH = 256 * 1024;
/** Upper bound on a nonce; replay records are keyed by it. */
export const MAX_WEBHOOK_NONCE_LENGTH = 128;

const SUPPORTED_ALGORITHMS = ['sha256', 'sha512'];

/**
 * Structural check for an untrusted message. Returns the reason it is
 * malformed, or null. Runs before the clock, replay and HMAC checks so a bad
 * payload is rejected deterministically instead of throwing or being hashed.
 */
function malformedReason(message: unknown): string | null {
  if (typeof message !== 'object' || message === null) return 'message must be an object';
  const { signature, data } = message as { signature?: unknown; data?: unknown };
  if (typeof signature !== 'object' || signature === null) return 'missing signature';
  const { algorithm, timestamp, nonce, signature: digest } = signature as Record<string, unknown>;
  if (typeof algorithm !== 'string' || !SUPPORTED_ALGORITHMS.includes(algorithm)) {
    return 'unsupported algorithm';
  }
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return 'invalid timestamp';
  if (typeof nonce !== 'string' || nonce.length === 0) return 'missing nonce';
  if (nonce.length > MAX_WEBHOOK_NONCE_LENGTH) return 'nonce too long';
  if (typeof digest !== 'string' || digest.length === 0) return 'missing signature digest';
  if (data === undefined) return 'missing data';
  try {
    const serialized = JSON.stringify(data);
    if (serialized !== undefined && serialized.length > MAX_WEBHOOK_DATA_LENGTH) return 'data too large';
  } catch {
    return 'data is not serializable';
  }
  return null;
}

export class WebhookVerifier {
  private defaultConfig: WebhookVerificationConfig = {
    replayWindowSeconds: 300,
    algorithmPreference: 'sha256',
    nonceDeduplication: true,
    maxClockSkew: 60,
  };

  private replayRecords: Map<string, ReplayProtectionRecord> = new Map();
  private subscribers: Map<string, WebhookSubscriber> = new Map();
  private deliveryAttempts: DeliveryAttempt[] = [];

  constructor(private config: Partial<WebhookVerificationConfig> = {}) {
    this.config = { ...this.defaultConfig, ...config };
  }

  generateSignature(payload: string, secret: string, algorithm: 'sha256' | 'sha512' = 'sha256'): string {
    return crypto
      .createHmac(algorithm, secret)
      .update(payload)
      .digest('hex');
  }

  createSignedMessage(payload: unknown, secret: string): WebhookMessage {
    const timestamp = Math.floor(Date.now() / 1000);
    const nonce = crypto.randomBytes(16).toString('hex');
    const algorithm = this.config.algorithmPreference || 'sha256';

    const payloadString = JSON.stringify(payload);
    const signingString = `${timestamp}.${nonce}.${payloadString}`;
    const signature = this.generateSignature(signingString, secret, algorithm);

    return {
      id: `webhook-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      timestamp,
      event: 'generic',
      data: payload,
      signature: {
        algorithm,
        secret: '', // Never include secret in message
        timestamp,
        nonce,
        signature,
      },
    };
  }

  verifySignature(
    message: WebhookMessage,
    secret: string,
  ): { valid: boolean; error?: string } {
    const malformed = malformedReason(message);
    if (malformed) {
      return { valid: false, error: `Malformed webhook message: ${malformed}` };
    }

    const { signature } = message;

    // Verify timestamp is within replay window
    const now = Math.floor(Date.now() / 1000);
    const timeDiff = Math.abs(now - signature.timestamp);

    if (timeDiff > (this.config.maxClockSkew || 60)) {
      return { valid: false, error: 'Timestamp outside acceptable skew window' };
    }

    if (timeDiff > (this.config.replayWindowSeconds || 300)) {
      return { valid: false, error: 'Message timestamp outside replay window' };
    }

    // Verify nonce is unique
    if (this.config.nonceDeduplication && this.hasNonceBeenUsed(signature.nonce)) {
      return { valid: false, error: 'Replay attack detected: nonce already used' };
    }

    // Verify cryptographic signature
    const payloadString = JSON.stringify(message.data);
    const signingString = `${signature.timestamp}.${signature.nonce}.${payloadString}`;
    const expectedSignature = this.generateSignature(signingString, secret, signature.algorithm);

    if (signature.signature !== expectedSignature) {
      return { valid: false, error: 'Signature verification failed' };
    }

    // Record this nonce as used
    if (this.config.nonceDeduplication) {
      this.recordNonce(signature.nonce, message.timestamp, message.id);
    }

    return { valid: true };
  }

  private hasNonceBeenUsed(nonce: string): boolean {
    return this.replayRecords.has(nonce);
  }

  private recordNonce(nonce: string, timestamp: number, eventId: string): void {
    this.replayRecords.set(nonce, {
      nonce,
      timestamp,
      eventId,
      verified: true,
    });

    // Cleanup old records outside replay window
    const cutoff = Math.floor(Date.now() / 1000) - (this.config.replayWindowSeconds || 300);
    for (const [key, record] of this.replayRecords) {
      if (record.timestamp < cutoff) {
        this.replayRecords.delete(key);
      }
    }
  }

  registerSubscriber(subscriber: WebhookSubscriber): void {
    this.subscribers.set(subscriber.id, subscriber);
  }

  getSubscriber(id: string): WebhookSubscriber | undefined {
    return this.subscribers.get(id);
  }

  getActiveSubscribers(event: string): WebhookSubscriber[] {
    return Array.from(this.subscribers.values()).filter(
      s => s.active && s.events.includes(event),
    );
  }

  recordDeliveryAttempt(attempt: WebhookDeliveryAttempt): void {
    this.deliveryAttempts.push(attempt as DeliveryAttempt);

    // Update subscriber statistics
    const subscriber = this.subscribers.get(attempt.subscriberId);
    if (subscriber) {
      if (attempt.success) {
        subscriber.successCount++;
        subscriber.lastDelivery = attempt.timestamp;
      } else {
        subscriber.failureCount++;
      }
    }

    // Disable subscriber after too many failures
    if (subscriber && subscriber.failureCount > 10 && subscriber.successCount === 0) {
      subscriber.active = false;
    }
  }

  getDeliveryAttempts(subscriberId: string, limit: number = 100): WebhookDeliveryAttempt[] {
    return this.deliveryAttempts
      .filter(a => a.subscriberId === subscriberId)
      .slice(-limit);
  }

  cleanupOldRecords(olderThanSeconds: number): number {
    const cutoff = Math.floor(Date.now() / 1000) - olderThanSeconds;
    let removed = 0;

    for (const [key, record] of this.replayRecords) {
      if (record.timestamp < cutoff) {
        this.replayRecords.delete(key);
        removed++;
      }
    }

    this.deliveryAttempts = this.deliveryAttempts.filter(a => {
      return a.timestamp.getTime() / 1000 > cutoff;
    });

    return removed;
  }

  getReplayProtectionStats(): {
    totalNonces: number;
    totalDeliveryAttempts: number;
    totalSubscribers: number;
    activeSubscribers: number;
  } {
    return {
      totalNonces: this.replayRecords.size,
      totalDeliveryAttempts: this.deliveryAttempts.length,
      totalSubscribers: this.subscribers.size,
      activeSubscribers: Array.from(this.subscribers.values()).filter(s => s.active).length,
    };
  }
}

interface DeliveryAttempt extends WebhookDeliveryAttempt {}

interface WebhookRequest {
  body: {
    signature?: string;
    [key: string]: unknown;
  } | null;
}

export const webhookVerifier = new WebhookVerifier();

export function createWebhookMiddleware(verifier: WebhookVerifier) {
  return (req: WebhookRequest, secret: string) => {
    const payload = req.body;

    if (!payload || !payload.signature) {
      return { valid: false, error: 'Missing signature in payload' };
    }

    return verifier.verifySignature(payload, secret);
  };
}
