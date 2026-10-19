import { describe, expect, it } from "vitest";
import { enforceFreeze, validateFreezeWindow, type FreezeWindow } from "../freeze-window";

const START = Date.parse("2026-10-20T00:00:00.000Z");
const END = Date.parse("2026-10-21T00:00:00.000Z");

const settlement: FreezeWindow = {
  id: "settlement-week",
  actions: ["transfer", "redemption"],
  startsAt: START,
  endsAt: END,
  reason: "Settlement window"
};

const during = START + 60_000;

describe("validateFreezeWindow", () => {
  it("accepts a window with known actions and an increasing schedule", () => {
    expect(validateFreezeWindow(settlement).ok).toBe(true);
  });

  it("rejects an unknown action scope", () => {
    const result = validateFreezeWindow({ ...settlement, actions: ["teleport" as never] });

    expect(result).toEqual({ ok: false, code: "invalid_freeze_window" });
  });

  it("rejects a window that ends before it starts", () => {
    const result = validateFreezeWindow({ ...settlement, startsAt: END, endsAt: START });

    expect(result).toEqual({ ok: false, code: "invalid_freeze_window" });
  });
});

describe("enforceFreeze", () => {
  it("rejects a frozen action during an active window and names the window", () => {
    const result = enforceFreeze({ windows: [settlement], action: "transfer", now: during });

    expect(result).toEqual({
      ok: false,
      code: "action_frozen",
      detail: { windowId: "settlement-week", endsAt: END }
    });
  });

  it("lets unrelated actions continue during an active window", () => {
    const result = enforceFreeze({ windows: [settlement], action: "issuance", now: during });

    expect(result).toEqual({ ok: true, value: true });
  });

  it("allows a frozen action once the window has expired", () => {
    const result = enforceFreeze({ windows: [settlement], action: "transfer", now: END + 1 });

    expect(result.ok).toBe(true);
  });

  it("allows a frozen action before a future window starts", () => {
    const result = enforceFreeze({ windows: [settlement], action: "transfer", now: START - 1 });

    expect(result.ok).toBe(true);
  });

  it("treats the end instant as outside the window", () => {
    const result = enforceFreeze({ windows: [settlement], action: "transfer", now: END });

    expect(result.ok).toBe(true);
  });

  it("lets a maintainer bypass an active window for an emergency", () => {
    const result = enforceFreeze({
      windows: [settlement],
      action: "transfer",
      now: during,
      bypass: { windowId: "settlement-week", approvedBy: "maintainer-1", justification: "Incident 42" }
    });

    expect(result).toEqual({ ok: true, value: true });
  });

  it("refuses a bypass that names a different window", () => {
    const result = enforceFreeze({
      windows: [settlement],
      action: "transfer",
      now: during,
      bypass: { windowId: "other-window", approvedBy: "maintainer-1", justification: "Incident 42" }
    });

    expect(result).toEqual({ ok: false, code: "invalid_bypass" });
  });

  it("refuses a bypass without a named approver", () => {
    const result = enforceFreeze({
      windows: [settlement],
      action: "transfer",
      now: during,
      bypass: { windowId: "settlement-week", approvedBy: " ", justification: "Incident 42" }
    });

    expect(result).toEqual({ ok: false, code: "invalid_bypass" });
  });
});
