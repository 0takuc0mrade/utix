import { describe, expect, it } from "vitest";
import { protectTelemetry } from "@/core/telemetry/protection";
describe("telemetry protection", () => { it("redacts sensitive fields and samples", () => { expect(protectTelemetry({ user: "u", token: "secret" }, { random: () => 0, sampleRate: 1 }).event?.token).toBe("[REDACTED]"); expect(protectTelemetry({ x: 1 }, { random: () => 1, sampleRate: .5 }).event).toBeNull(); }); });
