import { describe, expect, it } from "vitest";
import { checkSchemaEvolution, validateSchemaRecord, type SchemaDefinition } from "@/core/schema/guardrails";
const v1: SchemaDefinition = { name: "ticket", version: 1, required: ["id"], fields: { id: "string" } };
describe("schema guardrails", () => {
  it("rejects breaking changes without a version bump", () => {
    expect(checkSchemaEvolution(v1, { ...v1, required: ["owner"] }).compatible).toBe(false);
    expect(validateSchemaRecord(v1, { id: "1" })).toBe(true);
  });
});
