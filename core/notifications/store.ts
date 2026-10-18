import { recordAudit } from "@/core/audit/audit.ts";
import { notificationMachine, transitionRecord } from "@/core/lifecycle/records.ts";
import {
  NOTIFICATION_EVENTS,
  createDefaultPreferences,
  type Notification,
  type NotificationCategory,
  type NotificationEventType,
  type NotificationInput,
  type NotificationPreferences,
  type NotificationRecipient,
  type NotificationState,
  type NotificationStorage,
  type NotificationTone,
  type NotificationUrgency
} from "./types.ts";

const STORAGE_PREFIX = "utix:notifications:v1:";
const PREFERENCES_PREFIX = "utix:notification-preferences:v1:";

/** The initial state, taken from the lifecycle table rather than repeated. */
const INITIAL_STATE = notificationMachine.initial() as NotificationState;
const READ_STATE: NotificationState = "read";

const PUBLIC_ACCOUNT = /^account:G[A-Z2-7]{55}$/;
const SECRET = /\bS[A-Z2-7]{55}\b/g;

class MemoryStorage implements NotificationStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

function browserStorage(): NotificationStorage {
  try {
    if (
      typeof window !== "undefined" &&
      window.localStorage &&
      typeof window.localStorage.getItem === "function"
    ) {
      return window.localStorage;
    }
  } catch {
    return new MemoryStorage();
  }
  return new MemoryStorage();
}

function isNotificationEvent(value: unknown): value is NotificationEventType {
  return typeof value === "string" && (NOTIFICATION_EVENTS as readonly string[]).includes(value);
}

function isNotificationTone(value: unknown): value is NotificationTone {
  return value === "error" || value === "warning" || value === "success" || value === "info";
}

function isNotificationRecipient(value: unknown): value is NotificationRecipient {
  return value === "workspace" || (typeof value === "string" && PUBLIC_ACCOUNT.test(value));
}

function isSafeHref(value: string): boolean {
  return /^\/(?!\/)\S*$/.test(value) && !value.toLowerCase().includes("javascript:");
}

function containsSecret(value: string): boolean {
  return value.replace(SECRET, "") !== value;
}

function scrub(value: string, maxLength: number): string {
  return value.replace(SECRET, "[REDACTED]").slice(0, maxLength);
}

function stableId(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  }
  return `notification-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function isNotificationState(value: unknown): value is NotificationState {
  return notificationMachine.isState(value) && value !== "purged";
}

/**
 * Accepts a stored entry and normalises it to the lifecycle model. Entries
 * written before the state field existed are migrated from their `read` flag,
 * so an existing browser profile keeps working.
 */
function parseNotification(value: unknown): Notification | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Partial<Notification>;
  if (
    typeof item.id !== "string" ||
    typeof item.recipient !== "string" ||
    !isNotificationRecipient(item.recipient) ||
    !isNotificationEvent(item.event) ||
    !isNotificationTone(item.tone) ||
    typeof item.title !== "string" ||
    typeof item.message !== "string" ||
    typeof item.href !== "string" ||
    containsSecret(item.title) ||
    containsSecret(item.message) ||
    containsSecret(item.href) ||
    !isSafeHref(item.href) ||
    typeof item.dedupeKey !== "string" ||
    typeof item.createdAt !== "string"
  ) {
    return null;
  }

  const state: NotificationState = isNotificationState(item.state)
    ? item.state
    : item.read === true
      ? READ_STATE
      : INITIAL_STATE;

  const urgency: NotificationUrgency =
    item.urgency === "mandatory" ? "mandatory" : "standard";

  const category: NotificationCategory =
    item.category === "security" ||
    item.category === "lifecycle" ||
    item.category === "compliance"
      ? item.category
      : "operational";

  return {
    id: item.id,
    recipient: item.recipient,
    event: item.event,
    tone: item.tone,
    title: item.title,
    message: item.message,
    href: item.href,
    dedupeKey: item.dedupeKey,
    createdAt: item.createdAt,
    state,
    urgency,
    category,
    routedAs: item.routedAs,
    // Derived once, from the single source of truth.
    read: state === READ_STATE || state === "archived"
  };
}

/**
 * Thrown when `updatePreferences` is given an `expectedVersion` that is no
 * longer the stored version: another tab or device wrote in between, so the
 * caller's patch was computed from stale preferences (#271).
 */
export class StalePreferencesVersionError extends Error {
  // Explicit fields, not parameter properties, so Node's type stripping can load this module.
  readonly recipient: NotificationRecipient;
  readonly expectedVersion: number;
  readonly actualVersion: number;

  constructor(recipient: NotificationRecipient, expectedVersion: number, actualVersion: number) {
    super(
      `Stale preferences for ${recipient}: expected version ${expectedVersion}, stored version is ${actualVersion}`
    );
    this.name = "StalePreferencesVersionError";
    this.recipient = recipient;
    this.expectedVersion = expectedVersion;
    this.actualVersion = actualVersion;
  }
}

export class NotificationStore {
  private readonly storage: NotificationStorage;
  private readonly maxEntries: number;

  constructor(storage: NotificationStorage = browserStorage(), maxEntries = 50) {
    this.storage = storage;
    this.maxEntries = Math.max(1, Math.floor(maxEntries));
  }

  private key(recipient: NotificationRecipient): string {
    return `${STORAGE_PREFIX}${recipient}`;
  }

  private prefKey(recipient: NotificationRecipient): string {
    return `${PREFERENCES_PREFIX}${recipient}`;
  }

  private read(recipient: NotificationRecipient): Notification[] {
    const raw = this.storage.getItem(this.key(recipient));
    if (!raw) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .map(parseNotification)
        .filter((item): item is Notification => item !== null)
        .filter((item) => item.recipient === recipient);
    } catch {
      return [];
    }
  }

  private write(recipient: NotificationRecipient, notifications: Notification[]): void {
    this.storage.setItem(this.key(recipient), JSON.stringify(notifications.slice(0, this.maxEntries)));
  }

  /**
   * Retrieves durable preferences for a recipient. Returns default preferences if none stored.
   */
  getPreferences(recipient: NotificationRecipient): NotificationPreferences {
    if (!isNotificationRecipient(recipient)) {
      return createDefaultPreferences("workspace");
    }
    const raw = this.storage.getItem(this.prefKey(recipient));
    if (!raw) {
      return createDefaultPreferences(recipient);
    }
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null) {
        return createDefaultPreferences(recipient);
      }
      const defaults = createDefaultPreferences(recipient);
      return {
        recipient,
        muted: typeof parsed.muted === "boolean" ? parsed.muted : defaults.muted,
        enabledEvents: {
          ...defaults.enabledEvents,
          ...(typeof parsed.enabledEvents === "object" && parsed.enabledEvents !== null
            ? parsed.enabledEvents
            : {})
        },
        enabledTones: {
          ...defaults.enabledTones,
          ...(typeof parsed.enabledTones === "object" && parsed.enabledTones !== null
            ? parsed.enabledTones
            : {})
        },
        enabledCategories: {
          ...defaults.enabledCategories,
          ...(typeof parsed.enabledCategories === "object" && parsed.enabledCategories !== null
            ? parsed.enabledCategories
            : {})
        },
        mandatoryAlertsAlwaysDeliver: true,
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : defaults.updatedAt,
        version: typeof parsed.version === "number" ? parsed.version : defaults.version
      };
    } catch {
      return createDefaultPreferences(recipient);
    }
  }

  /**
   * Updates durable preferences for a recipient and records an audit log.
   *
   * Pass `expectedVersion` (the `version` the patch was computed from) to make
   * the write a compare-and-set: a stale version throws
   * `StalePreferencesVersionError` instead of silently overwriting a newer write.
   */
  updatePreferences(
    recipient: NotificationRecipient,
    patch: Partial<Omit<NotificationPreferences, "recipient" | "mandatoryAlertsAlwaysDeliver">>,
    { expectedVersion }: { expectedVersion?: number } = {}
  ): NotificationPreferences {
    if (!isNotificationRecipient(recipient)) {
      throw new Error(`Invalid notification recipient: ${String(recipient)}`);
    }
    const current = this.getPreferences(recipient);
    if (expectedVersion !== undefined && expectedVersion !== current.version) {
      throw new StalePreferencesVersionError(recipient, expectedVersion, current.version);
    }
    const updated: NotificationPreferences = {
      recipient,
      muted: typeof patch.muted === "boolean" ? patch.muted : current.muted,
      enabledEvents: {
        ...current.enabledEvents,
        ...(patch.enabledEvents ?? {})
      },
      enabledTones: {
        ...current.enabledTones,
        ...(patch.enabledTones ?? {})
      },
      enabledCategories: {
        ...current.enabledCategories,
        ...(patch.enabledCategories ?? {})
      },
      mandatoryAlertsAlwaysDeliver: true,
      updatedAt: new Date().toISOString(),
      version: current.version + 1
    };

    this.storage.setItem(this.prefKey(recipient), JSON.stringify(updated));

    recordAudit({
      action: "notification_preferences.updated",
      actor: { kind: "user", id: recipient },
      target: { kind: "notification", id: recipient },
      before: { muted: current.muted, version: current.version },
      after: { muted: updated.muted, version: updated.version },
      at: updated.updatedAt,
      reason: "user_preference_update"
    });

    return updated;
  }

  /**
   * Resets preferences to factory defaults.
   */
  resetPreferences(recipient: NotificationRecipient): NotificationPreferences {
    if (!isNotificationRecipient(recipient)) {
      throw new Error(`Invalid notification recipient: ${String(recipient)}`);
    }
    const defaults = createDefaultPreferences(recipient);
    this.storage.removeItem(this.prefKey(recipient));

    recordAudit({
      action: "notification_preferences.reset",
      actor: { kind: "user", id: recipient },
      target: { kind: "notification", id: recipient },
      at: new Date().toISOString(),
      reason: "reset_to_default_preferences"
    });

    return defaults;
  }

  /**
   * Determines if a notification qualifies as a mandatory security or lifecycle alert.
   */
  isMandatoryAlert(input: NotificationInput): boolean {
    if (input.urgency === "mandatory") return true;
    if (input.category === "security") return true;
    if (input.category === "lifecycle" && (input.tone === "error" || input.tone === "warning")) {
      return true;
    }
    // High-impact system failures or recoveries are mandatory by default
    if (input.event === "failure" && input.tone === "error") return true;
    if (input.event === "recovery" && input.tone !== "info") return true;
    return false;
  }

  list(recipient: NotificationRecipient): Notification[] {
    if (!isNotificationRecipient(recipient)) return [];
    return this.read(recipient).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  unreadCount(recipient: NotificationRecipient): number {
    // Derived from the lifecycle state, not from a second boolean.
    return this.list(recipient).filter((notification) => notification.state === "unread").length;
  }

  publish(input: NotificationInput): Notification | null {
    if (
      !isNotificationRecipient(input.recipient) ||
      !isNotificationEvent(input.event) ||
      !isNotificationTone(input.tone) ||
      typeof input.title !== "string" ||
      typeof input.message !== "string" ||
      typeof input.href !== "string" ||
      typeof input.dedupeKey !== "string" ||
      !isSafeHref(input.href) ||
      !input.dedupeKey.trim()
    ) {
      return null;
    }

    const dedupeKey = scrub(input.dedupeKey, 160);
    const existing = this.read(input.recipient);
    const duplicate = existing.find(
      (notification) => notification.event === input.event && notification.dedupeKey === dedupeKey
    );
    if (duplicate) return duplicate;

    const isMandatory = this.isMandatoryAlert(input);
    const preferences = this.getPreferences(input.recipient);

    const category: NotificationCategory =
      input.category ??
      (input.event === "failure" || input.event === "recovery"
        ? "lifecycle"
        : "operational");

    const urgency: NotificationUrgency =
      input.urgency ?? (isMandatory ? "mandatory" : "standard");

    // Check optional notification preference suppression
    const eventAllowed = preferences.enabledEvents[input.event] ?? true;
    const toneAllowed = preferences.enabledTones[input.tone] ?? true;
    const categoryAllowed = preferences.enabledCategories[category] ?? true;
    const suppressedByPreference =
      preferences.muted || !eventAllowed || !toneAllowed || !categoryAllowed;

    let routedAs: "preference_delivered" | "mandatory_override" = "preference_delivered";

    if (suppressedByPreference) {
      if (!isMandatory) {
        // Optional notifications respect user preferences and are suppressed
        recordAudit({
          action: "notification.suppressed_by_preference",
          actor: { kind: "user", id: input.recipient },
          target: { kind: "notification", id: input.dedupeKey },
          before: { event: input.event, tone: input.tone, category },
          reason: preferences.muted ? "user_muted_all" : "user_filtered_event_or_tone"
        });
        return null;
      }
      // Mandatory security & lifecycle alerts OVERRIDE user suppression
      routedAs = "mandatory_override";
      recordAudit({
        action: "notification.mandatory_override",
        actor: { kind: "system", id: "mandatory_alert_router" },
        target: { kind: "notification", id: input.dedupeKey },
        after: { event: input.event, tone: input.tone, category, urgency: "mandatory" },
        reason: "mandatory_alert_bypassed_suppression"
      });
    }

    const timestamp = input.occurredAt ?? Date.now();
    const createdAt = new Date(Number.isFinite(timestamp) ? timestamp : Date.now()).toISOString();
    const href = scrub(input.href, 1000);
    const notification: Notification = {
      id: stableId(`${input.recipient}|${input.event}|${dedupeKey}`),
      recipient: input.recipient,
      event: input.event,
      tone: input.tone,
      title: scrub(input.title, 120),
      message: scrub(input.message, 500),
      href,
      dedupeKey,
      createdAt,
      state: INITIAL_STATE,
      read: false,
      urgency,
      category,
      routedAs
    };

    this.write(input.recipient, [notification, ...existing]);
    recordAudit({
      action: "notification.published",
      actor: { kind: "user", id: input.recipient },
      target: { kind: "notification", id: notification.id },
      after: { event: input.event, tone: input.tone, urgency, category, routedAs },
      at: createdAt,
      reason: notification.dedupeKey
    });
    return notification;
  }

  /**
   * Moves a notification to `read`. Returns `null` when the record is unknown
   * *or* when the lifecycle table refuses the move (an already-read or archived
   * notification), so a double click cannot re-fire the write.
   */
  markRead(recipient: NotificationRecipient, id: string): Notification | null {
    if (!isNotificationRecipient(recipient)) return null;
    const notifications = this.read(recipient);
    const index = notifications.findIndex((notification) => notification.id === id);
    if (index < 0) return null;
    const current = notifications[index];
    const moved = transitionRecord("notification", current.id, current.state, "read", {
      actor: `account:${recipient.startsWith("account:") ? recipient.slice(8) : "workspace"}`
    });
    if (!moved.ok) return null;
    const notification: Notification = { ...current, state: READ_STATE, read: true };
    notifications[index] = notification;
    this.write(recipient, notifications);
    return notification;
  }

  /** Applies `read` to every entry that still allows it; already-read stay put. */
  markAllRead(recipient: NotificationRecipient): Notification[] {
    if (!isNotificationRecipient(recipient)) return [];
    const notifications = this.read(recipient).map((notification) => {
      if (!notificationMachine.canTransition(notification.state, "read").ok) return notification;
      transitionRecord("notification", notification.id, notification.state, "read");
      return { ...notification, state: READ_STATE, read: true };
    });
    this.write(recipient, notifications);
    return notifications;
  }

  /** Removes every record for a recipient. Purging is terminal and one-way. */
  clear(recipient: NotificationRecipient): void {
    if (!isNotificationRecipient(recipient)) return;
    const existing = this.read(recipient);
    recordAudit({
      action: "notification.cleared",
      actor: { kind: "user", id: recipient },
      target: { kind: "notification", id: recipient },
      before: { count: existing.length },
      reason: "recipient_cleared"
    });
    for (const notification of existing) {
      transitionRecord("notification", notification.id, notification.state, "purge", {
        reason: "recipient_cleared"
      });
    }
    this.storage.removeItem(this.key(recipient));
  }
}
