import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
// @ts-expect-error -- plain ESM script without type declarations
import { findReconciliationViolations } from "../../../scripts/verify-reconciliation.mjs";

/**
 * `scripts/verify-reconciliation.mjs` is the CI guard for the repair path. It
 * must pass on the real tree and trip when a dry-run-first guard is removed.
 */
const root = path.resolve(__dirname, "../../..");
const dir = mkdtempSync(path.join(tmpdir(), "utix-reconciliation-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function copyTree(name: string): string {
  const target = path.join(dir, name);
  cpSync(path.join(root, "core", "reconciliation"), path.join(target, "core", "reconciliation"), { recursive: true });
  return target;
}

function edit(tree: string, file: string, from: RegExp | string, to: string): void {
  const full = path.join(tree, file);
  const source = readFileSync(full, "utf8");
  const next = source.replace(from, to);
  if (next === source) throw new Error(`edit did not apply to ${file}`);
  writeFileSync(full, next);
}

describe("scripts/verify-reconciliation.mjs", () => {
  it("passes on the repository", async () => {
    expect(await findReconciliationViolations()).toEqual([]);
  });

  it("flags an invariant without a repair strategy", async () => {
    const tree = copyTree("no-strategy");
    edit(tree, "core/reconciliation/repair.ts", /\s*"operation\.settles": "manual"/, "");
    edit(tree, "core/reconciliation/repair.ts", /"notification\.identity_unique": "collapse_notification",/, '"notification.identity_unique": "collapse_notification"');
    expect(await findReconciliationViolations(tree)).toContain(
      'invariant operation.settles has no repair strategy (use "manual" if none is safe)'
    );
  });

  it("flags an apply that no longer re-checks the source", async () => {
    const tree = copyTree("no-stale-check");
    edit(tree, "core/reconciliation/repair.ts", /"plan_stale"/g, '"plan_outdated"');
    expect(await findReconciliationViolations(tree)).toContain(
      "core/reconciliation/repair.ts: apply no longer refuses a plan the source has moved past"
    );
  });

  it("flags an apply that no longer requires confirmation", async () => {
    const tree = copyTree("no-confirm");
    edit(tree, "core/reconciliation/repair.ts", "deps.confirm !== plan.planId", "false");
    expect(await findReconciliationViolations(tree)).toContain(
      "core/reconciliation/repair.ts: apply no longer requires the plan id as confirmation"
    );
  });
});
