import { describe, expect, it } from "vitest";
import {
  formatFee,
  formatGroupState,
  formatOpTypes,
  formatTimeBucket,
} from "@/features/duplicate-transaction-scanner/lib/format";

describe("formatFee", () => {
  it("renders a fee in stroops and XLM", () => {
    const result = formatFee("100");
    expect(result).toContain("100 stroops");
    expect(result).toContain("XLM");
  });

  it("handles 10,000,000 stroops as exactly 1 XLM", () => {
    const result = formatFee("10000000");
    expect(result).toContain("10000000 stroops");
    expect(result).toContain("1.0000000 XLM");
  });

  it("handles 0 fee gracefully", () => {
    expect(() => formatFee("0")).not.toThrow();
  });
});

describe("formatOpTypes", () => {
  it("joins multiple types with comma", () => {
    expect(formatOpTypes(["payment", "create_account"])).toBe("payment, create_account");
  });

  it("returns an em dash for an empty list", () => {
    expect(formatOpTypes([])).toBe("—");
  });

  it("returns a single type without punctuation", () => {
    expect(formatOpTypes(["payment"])).toBe("payment");
  });
});

describe("formatGroupState", () => {
  it("returns a human-readable label for every state", () => {
    const states = ["pending", "confirmed", "dismissed", "deferred"] as const;
    for (const state of states) {
      const label = formatGroupState(state);
      expect(typeof label).toBe("string");
      expect(label.length).toBeGreaterThan(0);
    }
  });
});

describe("formatTimeBucket", () => {
  it("returns a non-empty string", () => {
    const result = formatTimeBucket(5_869_717);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("includes the start time in ISO format", () => {
    const result = formatTimeBucket(0);
    expect(result).toContain("1970");
  });
});
