import { describe, expect, it } from "vitest";
import { runChaosScenario } from "@/core/testing/chaos";
import { detectLostUpdate } from "@/core/testing/concurrency";
describe("deterministic workflow harnesses", () => { it("reproduces interruption from a seed", async () => { expect((await runChaosScenario([{ id: "a", run: () => undefined }, { id: "b", run: () => undefined }], 7, 1)).interruptedAt).toBe("b"); }); it("reports a lost update", () => { let value = 0; const report = detectLostUpdate({ id: "counter", read: () => value, write: (next) => { value = Number(next); }, mutate: (current) => Number(current) + 1 }); expect(report.lostUpdate).toBe(true); }); });
