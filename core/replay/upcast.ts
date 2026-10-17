/**
 * Event schema upcasting. Old events are never rewritten in the log; they are
 * lifted one version at a time on read, so a projection only ever sees the
 * schema version it declares.
 */

import { err, ok, type Result } from "@/core/result/result";
import type { ReplayEvent, Upcaster } from "./types";

export type UpcastErrorCode = "unsupported_event_version" | "upcast_failed";

export interface UpcasterRegistry {
  /**
   * Lifts `event` to `targetVersion`. Fails when a step is missing, when the
   * event is newer than the target, or when an upcaster throws.
   */
  upcast(event: ReplayEvent, targetVersion: number): Result<ReplayEvent, UpcastErrorCode, string>;
}

export function createUpcasterRegistry(upcasters: readonly Upcaster[] = []): UpcasterRegistry {
  const steps = new Map<string, Upcaster>();
  for (const step of upcasters) {
    const key = `${step.type}@${step.fromVersion}`;
    if (steps.has(key)) throw new Error(`Duplicate upcaster for ${key}`);
    steps.set(key, step);
  }

  return {
    upcast(event, targetVersion) {
      if (event.version > targetVersion) {
        return err(
          "unsupported_event_version",
          `${event.type} v${event.version} is newer than the projection's v${targetVersion}`
        );
      }
      let payload = event.payload;
      for (let version = event.version; version < targetVersion; version += 1) {
        const step = steps.get(`${event.type}@${version}`);
        if (!step) {
          return err("unsupported_event_version", `no upcaster for ${event.type} v${version} -> v${version + 1}`);
        }
        try {
          payload = step.upcast(payload);
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause);
          return err("upcast_failed", `upcaster ${event.type} v${version} threw: ${message}`);
        }
      }
      return ok(event.version === targetVersion ? event : { ...event, version: targetVersion, payload });
    }
  };
}
