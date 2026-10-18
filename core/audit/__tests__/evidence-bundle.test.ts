import { describe, expect, it } from "vitest";
import { createAuditEvidenceBundle, verifyAuditEvidenceBundle } from "@/core/audit/evidence-bundle";

describe("audit evidence bundles", () => {
  it("detects changes after export", () => {
    const bundle = createAuditEvidenceBundle({ scope: "maintainer", events: [] });
    expect(verifyAuditEvidenceBundle(bundle)).toBe(true);
    const changed = { ...bundle, eventCount: 1 };
    expect(verifyAuditEvidenceBundle(changed)).toBe(false);
  });
});
