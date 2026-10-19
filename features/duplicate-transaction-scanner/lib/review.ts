/**
 * Merge review workflow for candidate duplicate groups.
 *
 * State machine
 * -------------
 * pending  → confirm  → confirmed  (terminal, no further review)
 * pending  → dismiss  → dismissed  (terminal)
 * pending  → defer    → deferred   (reversible)
 * deferred → confirm  → confirmed
 * deferred → dismiss  → dismissed
 * deferred → defer    → deferred   (idempotent)
 * confirmed/dismissed → any        → error "invalid_transition"
 *
 * Audit trail
 * -----------
 * Every successful transition emits a `record.state_changed` audit event via
 * the core/audit module. Every refused transition emits `record.transition_denied`.
 * These use the existing SENSITIVE_ACTIONS — no new core module changes needed.
 *
 * Persistence
 * -----------
 * Groups are persisted to localStorage under `GROUPS_STORAGE_KEY` so that
 * review decisions survive page reloads. The store merges incoming scan results
 * with existing decisions: a group already confirmed or dismissed is never
 * overwritten by a fresh pending group from a new scan.
 */

import { recordAudit } from "@/core/audit";
import { err, ok, type Result } from "@/core/result/result";
import { measure } from "@/core/telemetry/telemetry";
import type {
  CandidateGroup,
  CandidateGroupState,
  DuplicateScanErrorCode,
  ReviewAction,
  ReviewInput,
} from "@/features/duplicate-transaction-scanner/types";

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

/** Legal (from, action) → to transitions. */
const VALID_TRANSITIONS: Record<
  CandidateGroupState,
  Partial<Record<ReviewAction, CandidateGroupState>>
> = {
  pending: {
    confirm: "confirmed",
    dismiss: "dismissed",
    defer: "deferred",
  },
  deferred: {
    confirm: "confirmed",
    dismiss: "dismissed",
    defer: "deferred",
  },
  // Terminal states: no transitions allowed.
  confirmed: {},
  dismissed: {},
};

/** True iff no further review is possible from this state. */
export function isTerminalState(state: CandidateGroupState): boolean {
  return state === "confirmed" || state === "dismissed";
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export const GROUPS_STORAGE_KEY = "utix:dup-scan:v1:groups";

function safeStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    window.localStorage.setItem("__test__", "1");
    window.localStorage.removeItem("__test__");
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Load all persisted groups from localStorage, or an empty list on error. */
export function loadGroups(): CandidateGroup[] {
  const storage = safeStorage();
  if (!storage) return [];
  try {
    const raw = storage.getItem(GROUPS_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as CandidateGroup[];
  } catch {
    return [];
  }
}

/** Persist the full group list to localStorage. Silent on error. */
export function saveGroups(groups: CandidateGroup[]): void {
  const storage = safeStorage();
  if (!storage) return;
  try {
    storage.setItem(GROUPS_STORAGE_KEY, JSON.stringify(groups));
  } catch {
    // Quota exceeded or private mode — gracefully degrade.
  }
}

/**
 * Merge fresh scan results (all pending) with the persisted store.
 *
 * Rules:
 * - If a group id from the incoming scan already exists in the store with a
 *   terminal state (confirmed | dismissed), keep the stored version unchanged.
 * - If a group id exists with a deferred state, keep the stored version
 *   (preserve the defer decision).
 * - Otherwise (new pending group, or group re-appears after storage flush),
 *   take the incoming group.
 * - Groups in the store that are NOT in the incoming scan are retained with
 *   their current state so historical decisions are not lost.
 */
export function mergeIntoStore(
  incoming: CandidateGroup[],
  stored: CandidateGroup[],
): CandidateGroup[] {
  const storedById = new Map<string, CandidateGroup>(stored.map((g) => [g.id, g]));
  const seen = new Set<string>();

  const result: CandidateGroup[] = incoming.map((incoming) => {
    seen.add(incoming.id);
    const existing = storedById.get(incoming.id);
    // Preserve any existing review decision.
    if (existing) return existing;
    return incoming;
  });

  // Retain historical groups not present in this scan.
  for (const [id, group] of storedById) {
    if (!seen.has(id)) result.push(group);
  }

  // Sort: pending first, deferred, then resolved.
  const ORDER: Record<CandidateGroupState, number> = {
    pending: 0,
    deferred: 1,
    confirmed: 2,
    dismissed: 3,
  };
  result.sort((a, b) => ORDER[a.state] - ORDER[b.state]);
  return result;
}

// ---------------------------------------------------------------------------
// Review action
// ---------------------------------------------------------------------------

/**
 * Apply a review action to one candidate group.
 *
 * Emits an audit event (`record.state_changed` or `record.transition_denied`)
 * and wraps the whole operation in telemetry (`duplicate_scanner.review`).
 */
export function applyReview(
  group: CandidateGroup,
  input: ReviewInput,
): Result<CandidateGroup, DuplicateScanErrorCode> {
  return measure(
    "duplicate_scanner.review",
    { actorType: "user", correlationId: crypto.randomUUID() },
    () => {
      const nextState = VALID_TRANSITIONS[group.state]?.[input.action];

      if (!nextState) {
        // Refused transition — audit it and return an error.
        recordAudit({
          action: "record.transition_denied",
          actor: { kind: "user", id: input.actorId },
          scope: "own",
          target: { kind: "duplicate_candidate_group", id: group.id },
          reason: "invalid_transition",
          outcome: "denied",
          errorCode: "invalid_transition",
          before: { state: group.state },
          after: { requestedAction: input.action },
        });
        return err("invalid_transition" as DuplicateScanErrorCode);
      }

      const updatedGroup: CandidateGroup = {
        ...group,
        state: nextState,
        reviewedAt: new Date().toISOString(),
        reviewedBy: input.actorId,
        reviewReason: input.reason,
      };

      // Audit the successful transition.
      recordAudit({
        action: "record.state_changed",
        actor: { kind: "user", id: input.actorId },
        scope: "own",
        target: { kind: "duplicate_candidate_group", id: group.id },
        reason: input.reason ?? `review.${input.action}`,
        outcome: "allowed",
        before: { state: group.state },
        after: { state: nextState },
      });

      return ok(updatedGroup);
    },
  );
}
