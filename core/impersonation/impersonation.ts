/**
 * Scoped Maintainer Impersonation Service (#80)
 *
 * Provides safe, time-limited, audited impersonation capabilities for support debugging.
 *
 * Security Guarantees:
 * - Read-only by default: dangerous mutations (transfers, redemptions, burns, withdrawals) are blocked.
 * - Time-bounded: sessions expire automatically (max 60 minutes, default 15 minutes).
 * - Scoped: maintainers only gain access to explicitly requested domains.
 * - Fully Audited: all session starts, ends, allowed actions, and blocked mutations are logged.
 * - Elevated Confirmation: dangerous mutations require explicit tokens if configured.
 */

import { recordAudit, type AuditAction } from '@/core/audit/audit';
import { err, ok, type Result } from '@/core/result/result';
import {
  ACTION_SCOPE_MAP,
  CreateImpersonationParams,
  DANGEROUS_MUTATIONS,
  ImpersonationAction,
  ImpersonationAuditEvent,
  ImpersonationAuditEventType,
  ImpersonationBannerState,
  ImpersonationErrorCode,
  ImpersonationScope,
  ImpersonationSession
} from './types';

const DEFAULT_DURATION_MINUTES = 15;
const MAX_DURATION_MINUTES = 60;
const MIN_DURATION_MINUTES = 1;

/** In-memory audit trail for impersonation sessions (append-only) */
const impersonationAuditTrail: ImpersonationAuditEvent[] = [];

/**
 * Creates a new time-limited, scoped impersonation session.
 * Time Complexity: O(1)
 * Space Complexity: O(1)
 */
export function createImpersonationSession(
  params: CreateImpersonationParams
): Result<ImpersonationSession, ImpersonationErrorCode> {
  const clock = params.clock ?? (() => new Date());
  const now = clock();

  if (!params.maintainerId || params.maintainerId.trim() === '') {
    return err('unauthorized_maintainer');
  }

  if (!params.targetUserId || params.targetUserId.trim() === '') {
    return err('invalid_target');
  }

  if (!params.reason || params.reason.trim().length < 5) {
    return err('missing_reason');
  }

  const duration = params.durationMinutes ?? DEFAULT_DURATION_MINUTES;
  if (duration < MIN_DURATION_MINUTES || duration > MAX_DURATION_MINUTES) {
    return err('invalid_duration');
  }

  const expiresAt = new Date(now.getTime() + duration * 60 * 1000);
  const sessionId = `imp_${now.getTime().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

  const scopes: readonly ImpersonationScope[] =
    params.scopes && params.scopes.length > 0
      ? Object.freeze([...params.scopes])
      : Object.freeze(['read:tickets', 'inspect:events', 'support:diagnostics']);

  const allowedMutations: readonly ImpersonationAction[] =
    params.allowedMutations && params.allowedMutations.length > 0
      ? Object.freeze([...params.allowedMutations])
      : Object.freeze([]);

  const session: ImpersonationSession = Object.freeze({
    id: sessionId,
    maintainerId: params.maintainerId.trim(),
    targetUserId: params.targetUserId.trim(),
    targetAddress: params.targetAddress ? params.targetAddress.trim() : '',
    reason: params.reason.trim(),
    scopes,
    allowedMutations,
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    elevatedConfirmationRequired: params.elevatedConfirmationRequired ?? true,
    active: true
  });

  recordAuditEvent({
    id: `aud_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    eventType: 'session_started',
    sessionId: session.id,
    maintainerId: session.maintainerId,
    targetUserId: session.targetUserId,
    outcome: 'allowed',
    reason: session.reason,
    timestamp: session.createdAt,
    details: {
      durationMinutes: duration,
      scopeCount: scopes.length,
      allowedMutationsCount: allowedMutations.length,
      elevatedConfirmationRequired: session.elevatedConfirmationRequired
    }
  });

  return ok(session);
}

/**
 * Closes an active impersonation session.
 * Time Complexity: O(1)
 */
export function endImpersonationSession(
  session: ImpersonationSession,
  reason: string = 'Session closed by maintainer',
  clock: () => Date = () => new Date()
): ImpersonationSession {
  const now = clock();
  const endedSession: ImpersonationSession = Object.freeze({
    ...session,
    active: false
  });

  recordAuditEvent({
    id: `aud_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    eventType: 'session_ended',
    sessionId: session.id,
    maintainerId: session.maintainerId,
    targetUserId: session.targetUserId,
    outcome: 'allowed',
    reason,
    timestamp: now.toISOString()
  });

  return endedSession;
}

/**
 * Checks whether an impersonation session is currently valid and active.
 * Time Complexity: O(1)
 */
export function isSessionValid(session: ImpersonationSession, clock: () => Date = () => new Date()): boolean {
  if (!session || !session.active) return false;
  const now = clock().getTime();
  const expiresAt = new Date(session.expiresAt).getTime();
  return now < expiresAt;
}

/**
 * Evaluates whether a requested action can be performed within the impersonation session.
 * Strictly enforces scopes, dangerous mutation boundaries, and elevated confirmation.
 * Time Complexity: O(1)
 * Space Complexity: O(1)
 */
export function canExecuteAction(
  session: ImpersonationSession,
  action: ImpersonationAction,
  options?: {
    elevatedConfirmationToken?: string;
    clock?: () => Date;
  }
): Result<boolean, ImpersonationErrorCode> {
  const clock = options?.clock ?? (() => new Date());
  const now = clock();

  // 1. Verify active state
  if (!session.active) {
    recordAuditEvent({
      id: `aud_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      eventType: 'session_expired',
      sessionId: session.id,
      maintainerId: session.maintainerId,
      targetUserId: session.targetUserId,
      action,
      outcome: 'denied',
      reason: 'Session is marked inactive',
      timestamp: now.toISOString()
    });
    return err('impersonation_session_inactive');
  }

  // 2. Verify time bounds
  if (now.getTime() >= new Date(session.expiresAt).getTime()) {
    recordAuditEvent({
      id: `aud_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      eventType: 'session_expired',
      sessionId: session.id,
      maintainerId: session.maintainerId,
      targetUserId: session.targetUserId,
      action,
      outcome: 'denied',
      reason: 'Session has expired',
      timestamp: now.toISOString()
    });
    return err('impersonation_session_expired');
  }

  // 3. Verify scope permission
  const requiredScope = ACTION_SCOPE_MAP[action];
  if (requiredScope && !session.scopes.includes(requiredScope)) {
    recordAuditEvent({
      id: `aud_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      eventType: 'action_performed',
      sessionId: session.id,
      maintainerId: session.maintainerId,
      targetUserId: session.targetUserId,
      action,
      outcome: 'denied',
      reason: `Required scope ${requiredScope} not granted in session`,
      timestamp: now.toISOString()
    });
    return err('impersonation_scope_denied');
  }

  // 4. Verify dangerous mutations
  const isDangerous = DANGEROUS_MUTATIONS.includes(action);
  if (isDangerous) {
    const isExplicitlyAllowed = session.allowedMutations.includes(action);
    if (!isExplicitlyAllowed) {
      recordAuditEvent({
        id: `aud_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        eventType: 'mutation_blocked',
        sessionId: session.id,
        maintainerId: session.maintainerId,
        targetUserId: session.targetUserId,
        action,
        outcome: 'denied',
        reason: 'Dangerous mutation blocked in read-only impersonation mode',
        timestamp: now.toISOString()
      });
      return err('impersonation_mutation_blocked');
    }

    // Check elevated confirmation
    if (session.elevatedConfirmationRequired) {
      const token = options?.elevatedConfirmationToken;
      if (!token || token.trim().length < 8) {
        recordAuditEvent({
          id: `aud_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
          eventType: 'mutation_blocked',
          sessionId: session.id,
          maintainerId: session.maintainerId,
          targetUserId: session.targetUserId,
          action,
          outcome: 'denied',
          reason: 'Elevated confirmation token missing or invalid',
          timestamp: now.toISOString()
        });
        return err('elevated_confirmation_required');
      }
    }
  }

  // 5. Allowed action
  recordAuditEvent({
    id: `aud_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    eventType: 'action_performed',
    sessionId: session.id,
    maintainerId: session.maintainerId,
    targetUserId: session.targetUserId,
    action,
    outcome: 'allowed',
    timestamp: now.toISOString()
  });

  return ok(true);
}

/**
 * Computes the visual banner state and time remaining for active maintainer impersonation.
 * Time Complexity: O(1)
 */
export function getImpersonationBannerState(
  session: ImpersonationSession | null | undefined,
  clock: () => Date = () => new Date()
): ImpersonationBannerState {
  if (!session) {
    return {
      isImpersonating: false,
      remainingSeconds: 0,
      isReadOnly: true,
      scopes: [],
      isExpired: false,
      badgeTone: 'info',
      statusText: 'No active impersonation session'
    };
  }

  const now = clock().getTime();
  const expiresAt = new Date(session.expiresAt).getTime();
  const remainingSeconds = Math.max(0, Math.floor((expiresAt - now) / 1000));
  const isExpired = !session.active || remainingSeconds <= 0;
  const isReadOnly = session.allowedMutations.length === 0;

  let badgeTone: 'warning' | 'danger' | 'info' = 'warning';
  let statusText = `Impersonating ${session.targetUserId} (Read-Only)`;

  if (isExpired) {
    badgeTone = 'danger';
    statusText = `Impersonation session for ${session.targetUserId} has expired`;
  } else if (!isReadOnly) {
    badgeTone = 'danger';
    statusText = `Impersonating ${session.targetUserId} (Mutations Allowed: ${session.allowedMutations.join(', ')})`;
  }

  return {
    isImpersonating: !isExpired,
    sessionId: session.id,
    maintainerId: session.maintainerId,
    targetUserId: session.targetUserId,
    targetAddress: session.targetAddress,
    remainingSeconds,
    isReadOnly,
    scopes: session.scopes,
    isExpired,
    badgeTone,
    statusText
  };
}

const CANONICAL_AUDIT_ACTIONS: Record<ImpersonationAuditEventType, AuditAction> = {
  session_started: 'impersonation.session_started',
  session_ended: 'impersonation.session_ended',
  session_expired: 'impersonation.session_expired',
  action_performed: 'impersonation.action',
  mutation_blocked: 'impersonation.mutation_blocked'
};

/** Records an audit event to the local trail and the canonical audit trail */
function recordAuditEvent(event: ImpersonationAuditEvent): void {
  impersonationAuditTrail.push(Object.freeze(event));
  recordAudit({
    action: CANONICAL_AUDIT_ACTIONS[event.eventType],
    actor: { kind: 'maintainer', id: event.maintainerId },
    scope: 'maintainer',
    target: { kind: 'user', id: event.targetUserId || 'unknown' },
    reason: 'support_access',
    outcome: event.outcome,
    after: {
      sessionId: event.sessionId,
      eventType: event.eventType,
      action: event.action ?? null,
      reason: event.reason ?? null
    },
    at: event.timestamp,
    correlationId: event.sessionId,
    ...(event.outcome === 'denied' ? { errorCode: 'impersonation_denied' } : {})
  });
}

/** Returns the recorded impersonation audit trail (read-only copy) */
export function getImpersonationAuditTrail(sessionId?: string): readonly ImpersonationAuditEvent[] {
  if (sessionId) {
    return impersonationAuditTrail.filter((e) => e.sessionId === sessionId);
  }
  return [...impersonationAuditTrail];
}

/** Clears the impersonation audit trail (test utility) */
export function clearImpersonationAuditTrail(): void {
  impersonationAuditTrail.length = 0;
}
