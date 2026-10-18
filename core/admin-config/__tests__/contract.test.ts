import { describe, expect, it } from "vitest";
import { compareConfigurationContracts } from "@/core/admin-config/contract";

describe("configuration contracts", () => {
  it("requires the same critical keys in every environment", () => {
    const result = compareConfigurationContracts([{ environment: "test", values: {} }, { environment: "prod", values: {} }]);
    expect(result.valid).toBe(false);
    expect(result.missing).toContain("prod:network.endpoint");
  });
});
