import axe, { type AxeResults, type RunOptions } from "axe-core";
import { expect } from "vitest";

const DEFAULT_OPTIONS: RunOptions = {
  runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] }
};

export async function analyze(container: Element, options: RunOptions = DEFAULT_OPTIONS) {
  return (await axe.run(container, options)) as AxeResults;
}

/**
 * Fails the test with a readable report when the rendered markup has any
 * WCAG A/AA violation. Every feature slice ships an `a11.test.tsx` using this.
 */
export async function expectNoAxeViolations(
  container: Element,
  options: RunOptions = DEFAULT_OPTIONS
): Promise<void> {
  const results = await analyze(container, options);

  const report = results.violations
    .map((violation) => {
      const nodes = violation.nodes.map((node) => `      ${node.html}`).join("\n");
      return `  [${violation.impact ?? "unknown"}] ${violation.id}: ${violation.help}\n${nodes}`;
    })
    .join("\n");

  expect(
    results.violations.length,
    results.violations.length ? `Accessibility violations found:\n${report}` : ""
  ).toBe(0);
}

/**
 * Runs axe and returns a structured report instead of throwing. Useful for tests
 * that need to assert on specific rules (e.g. error announcement regions) or for
 * collecting diagnostics across multiple rendered states in one test.
 */
export interface AccessibilityReport {
  violations: AxeResults["violations"];
  incomplete: AxeResults["incomplete"];
  passes: AxeResults["passes"];
  inapplicable: AxeResults["inapplicable"];
}

export async function collectAccessibilityReport(
  container: Element,
  options: RunOptions = DEFAULT_OPTIONS
): Promise<AccessibilityReport> {
  const results = await analyze(container, options);
  return {
    violations: results.violations,
    incomplete: results.incomplete,
    passes: results.passes,
    inapplicable: results.inapplicable
  };
}

/**
 * Asserts that a specific axe rule is not violated. Used by targeted regression
 * coverage for dense forms, tables, and error recovery flows where a full scan is
 * too noisy or where a specific rule is the regression guard.
 */
export async function expectRulePasses(
  container: Element,
  ruleId: string,
  options: RunOptions = DEFAULT_OPTIONS
 ): Promise<void> {
  const results = await analyze(container, options);
  const violation = results.violations.find((v) => v.id === ruleId);
  const nodes = violation?.nodes.map((node) => `      ${node.html}`).join("\n") ?? "";
  expect(
    violation,
    violation ? `Axe rule "${ruleId}" violated:\n${nodes}` : ""
  ).toBeUndefined();
}
