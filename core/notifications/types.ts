export const NOTIFICATION_EVENTS = [
  "failure",
  "approval_required",
  "completed",
  "recovery",
  "retry"
] as const;

export type NotificationEventType = (typeof NOTIFICATION_EVENTS)[number];
export type NotificationEvent = NotificationEventType;
export type NotificationRecipient = `account:${string}` | "workspace";
export type NotificationTone = "error" | "warning" | "success" | "info";

export type NotificationUrgency = "standard" | "mandatory";
export type NotificationCategory =
  | "operational"
  | "lifecycle"
  | "security"
  | "compliance";

export interface NotificationInput {
  recipient: NotificationRecipient;
  event: NotificationEventType;
  tone: NotificationTone;
  title: string;
  message: string;
  href: string;
  dedupeKey: string;
  occurredAt?: number;
  urgency?: NotificationUrgency;
  category?: NotificationCategory;
}

/**
 * A notification's lifecycle state, declared in `core/lifecycle/records.ts`.
 * `read` below is derived from it, so no two consumers can disagree about it.
 */
export type NotificationState = "unread" | "read" | "archived" | "purged";

export interface Notification extends NotificationInput {
  id: string;
  createdAt: string;
  /** Derived from `state`; kept so existing consumers keep compiling. */
  read: boolean;
  state: NotificationState;
  urgency: NotificationUrgency;
  category: NotificationCategory;
  routedAs?: "preference_delivered" | "mandatory_override";
}

export interface NotificationPreferences {
  readonly recipient: NotificationRecipient;
  readonly muted: boolean;
  readonly enabledEvents: Record<NotificationEventType, boolean>;
  readonly enabledTones: Record<NotificationTone, boolean>;
  readonly enabledCategories: Record<NotificationCategory, boolean>;
  /** Mandatory lifecycle and security alerts bypass preferences and are always delivered */
  readonly mandatoryAlertsAlwaysDeliver: true;
  readonly updatedAt: string;
  readonly version: number;
}

export interface NotificationStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function createDefaultPreferences(
  recipient: NotificationRecipient
): NotificationPreferences {
  return {
    recipient,
    muted: false,
    enabledEvents: {
      failure: true,
      approval_required: true,
      completed: true,
      recovery: true,
      retry: true
    },
    enabledTones: {
      error: true,
      warning: true,
      success: true,
      info: true
    },
    enabledCategories: {
      operational: true,
      lifecycle: true,
      security: true,
      compliance: true
    },
    mandatoryAlertsAlwaysDeliver: true,
    updatedAt: new Date(0).toISOString(),
    version: 1
  };
}
