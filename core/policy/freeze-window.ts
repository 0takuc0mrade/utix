/**
 * Operational freeze windows for risky maintenance actions.
 *
 * A window blocks the listed action scopes between `startsAt` and `endsAt`
 * (epoch milliseconds, end exclusive). Actions outside the scope are unaffected.
 * An emergency bypass is allowed only for the window it names, and every bypass
 * or refused bypass is written to the audit trail.
 */
import { recordAudit } from "@/core/audit/audit";
import { err, ok, type Result } from "@/core/result/result";

export const FREEZE_ACTIONS = [
  "issuance",
  "transfer",
  "redemption",
  "bulk_operation",
  "maintenance"
] as const;

export type FreezeAction = (typeof FREEZE_ACTIONS)[number];

export interface FreezeWindow {
  readonly id: string;
  readonly actions: readonly FreezeAction[];
  readonly startsAt: number;
  readonly endsAt: number;
  readonly reason: string;
}

export interface EmergencyBypass {
  readonly windowId: string;
  readonly approvedBy: string;
  readonly justification: string;
}

export interface FrozenDetail {
  readonly windowId: string;
  readonly endsAt: number;
}

export type FreezeErrorCode = "action_frozen" | "invalid_freeze_window" | "invalid_bypass";

const MAX_TEXT_LENGTH = 256;

function isText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= MAX_TEXT_LENGTH;
}

export function validateFreezeWindow(window: FreezeWindow): Result<FreezeWindow, "invalid_freeze_window"> {
  const valid =
    isText(window.id) &&
    isText(window.reason) &&
    Number.isFinite(window.startsAt) &&
    Number.isFinite(window.endsAt) &&
    window.startsAt < window.endsAt &&
    window.actions.length > 0 &&
    window.actions.every((action) => (FREEZE_ACTIONS as readonly string[]).includes(action));

  return valid ? ok(window) : err("invalid_freeze_window");
}

export function isFreezeActive(window: FreezeWindow, now: number): boolean {
  return window.startsAt <= now && now < window.endsAt;
}

/**
 * Decides whether `action` may run at `now`. A frozen action is rejected with the
 * window that blocks it. A valid emergency bypass for that exact window lets it run.
 */
export function enforceFreeze(input: {
  readonly windows: readonly FreezeWindow[];
  readonly action: FreezeAction;
  readonly now: number;
  readonly bypass?: EmergencyBypass;
}): Result<true, FreezeErrorCode, FrozenDetail> {
  const blocking = input.windows.find(
    (window) => window.actions.includes(input.action) && isFreezeActive(window, input.now)
  );
  if (!blocking) return ok(true);

  if (!input.bypass) {
    return err("action_frozen", { windowId: blocking.id, endsAt: blocking.endsAt });
  }

  const { bypass } = input;
  const valid =
    bypass.windowId === blocking.id && isText(bypass.approvedBy) && isText(bypass.justification);

  if (!valid) {
    recordAudit({
      action: "freeze.bypass_denied",
      actor: { kind: "user", id: isText(bypass.approvedBy) ? bypass.approvedBy : "unknown" },
      target: { kind: "freeze_window", id: blocking.id },
      outcome: "denied",
      reason: "invalid_bypass",
      after: { action: input.action }
    });
    return err("invalid_bypass");
  }

  recordAudit({
    action: "freeze.bypassed",
    actor: { kind: "user", id: bypass.approvedBy },
    target: { kind: "freeze_window", id: blocking.id },
    outcome: "allowed",
    reason: "emergency_bypass",
    after: { action: input.action, justification: bypass.justification }
  });
  return ok(true);
}
