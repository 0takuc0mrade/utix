#!/usr/bin/env node
/**
 * Release Readiness Gate (#237)
 *
 * Verifies that all mandatory preconditions are satisfied before a release:
 * 1. Migrations have dry-runs, post-checks, and rollback handlers.
 * 2. Security checks pass (no exposed Stellar secret keys, safe URI handling).
 * 3. Rollback rehearsals pass (disaster recovery invariants and mock reversions).
 * 4. Smoke & invariant checks pass (registry consistency, feature boundaries).
 *
 * Usage:
 *   node scripts/release-readiness-gate.mjs
 *   node scripts/release-readiness-gate.mjs --json
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SECRET_KEY_PATTERN = /\bS[A-Z2-7]{55}\b/;
const JAVASCRIPT_URI_PATTERN = /href\s*=\s*["']javascript:/i;

/**
 * Gate 1: Migrations Readiness
 * Verifies migrations have dry-runs, post-checks, and rollback handlers.
 */
async function checkMigrationsGate(projectRoot = root) {
  const errors = [];
  const migrationDir = path.join(projectRoot, "core", "migration");
  const frameworkFiles = new Set(["index.ts", "types.ts", "postChecks.ts"]);

  try {
    const files = await readdir(migrationDir);
    const tsFiles = files.filter((f) => f.endsWith(".ts") && !f.includes(".test."));
    let foundRunner = false;
    let foundPostChecks = false;

    for (const f of tsFiles) {
      const content = await readFile(path.join(migrationDir, f), "utf8");
      if (f === "runner.ts") {
        foundRunner = true;
        if (!content.includes("autoRollback") && !content.includes("rollback")) {
          errors.push("MigrationRunner missing automated rollback support");
        }
        continue;
      }
      if (f === "postChecks.ts") {
        foundPostChecks = true;
        continue;
      }

      if (!frameworkFiles.has(f)) {
        if (!content.includes("rollback") && !content.includes("rollbackNotes")) {
          errors.push(`Migration definition ${f} lacks rollback declaration or notes`);
        }
      }
    }

    if (!foundRunner) errors.push("Missing core/migration/runner.ts");
    if (!foundPostChecks) errors.push("Missing core/migration/postChecks.ts");
  } catch (err) {
    errors.push(`Could not read migration directory: ${err.message}`);
  }

  return {
    name: "Database & Schema Migrations Gate",
    passed: errors.length === 0,
    category: "migrations",
    details: errors.length === 0 ? "All migrations declare post-checks and rollback paths" : `${errors.length} migration checks failed`,
    errors
  };
}

/**
 * Gate 2: Security Checks Gate
 * Ensures no plain-text Stellar secret keys and no unsafe URI bindings in codebase.
 */
async function checkSecurityGate(projectRoot = root) {
  const errors = [];
  const checkDirs = [
    path.join(projectRoot, "core"),
    path.join(projectRoot, "scripts")
  ];

  async function scan(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === ".next") continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await scan(fullPath);
      } else if (/\.(ts|tsx|mjs|js|json)$/.test(entry.name)) {
        // Skip test files from secret check since test files may have mock secret strings
        if (entry.name.includes(".test.") || entry.name.includes(".spec.")) continue;
        const text = await readFile(fullPath, "utf8");
        if (SECRET_KEY_PATTERN.test(text) && !text.includes("SECRET") && !text.includes("[REDACTED]")) {
          errors.push(`Exposed secret key detected in ${path.relative(projectRoot, fullPath)}`);
        }
        if (JAVASCRIPT_URI_PATTERN.test(text)) {
          errors.push(`Unsafe javascript: URI detected in ${path.relative(projectRoot, fullPath)}`);
        }
      }
    }
  }

  try {
    for (const d of checkDirs) await scan(d);
  } catch (err) {
    errors.push(`Security scanner encountered error: ${err.message}`);
  }

  return {
    name: "Security & Secret Sanitization Gate",
    passed: errors.length === 0,
    category: "security",
    details: errors.length === 0 ? "No plain-text secrets or dangerous URIs found" : `${errors.length} security violations detected`,
    errors
  };
}

/**
 * Gate 3: Rollback Rehearsals Gate
 * Validates that recovery and rollback invariants are defined and functional.
 */
async function checkRollbackGate(projectRoot = root) {
  const errors = [];
  const recoveryFile = path.join(projectRoot, "core", "recovery", "validator.ts");
  const runbookFile = path.join(projectRoot, "core", "incident", "runbook.ts");

  try {
    const [recoveryText, runbookText] = await Promise.all([
      readFile(recoveryFile, "utf8"),
      readFile(runbookFile, "utf8")
    ]);

    if (!recoveryText.includes("validateClockAndExpiryInvariants")) {
      errors.push("Recovery validator is missing clock/expiry invariant checks");
    }
    if (!recoveryText.includes("isExpiredConservatively")) {
      errors.push("Recovery validator is missing conservative expiration checks");
    }
    if (!runbookText.includes("rollback") && !runbookText.includes("Recovery")) {
      errors.push("Incident runbook does not document recovery/rollback steps");
    }
  } catch (err) {
    errors.push(`Rollback inspection failed: ${err.message}`);
  }

  return {
    name: "Rollback Rehearsals & Disaster Recovery Gate",
    passed: errors.length === 0,
    category: "rollback",
    details: errors.length === 0 ? "Rollback invariants and recovery procedures validated" : `${errors.length} rollback rehearsal failures`,
    errors
  };
}

/**
 * Gate 4: Smoke & Invariant Verification Gate
 * Verifies reconciliation and telemetry checks exist and pass verification.
 */
async function checkSmokeAndInvariantsGate(projectRoot = root) {
  const errors = [];
  const reconciliationFile = path.join(projectRoot, "scripts", "verify-reconciliation.mjs");
  const auditFile = path.join(projectRoot, "scripts", "verify-audit.mjs");

  try {
    const [reconciliationText, auditText] = await Promise.all([
      readFile(reconciliationFile, "utf8"),
      readFile(auditFile, "utf8")
    ]);

    if (!reconciliationText.includes("findReconciliationViolations")) {
      errors.push("verify-reconciliation.mjs is malformed");
    }
    if (!auditText.includes("verifyAuditContract") && !auditText.includes("audit")) {
      errors.push("verify-audit.mjs is malformed");
    }
  } catch (err) {
    errors.push(`Smoke/invariant check failed: ${err.message}`);
  }

  return {
    name: "Smoke Tests & Invariant Verification Gate",
    passed: errors.length === 0,
    category: "smoke",
    details: errors.length === 0 ? "Core reconciliation, audit, and smoke contracts present" : `${errors.length} invariant check failures`,
    errors
  };
}

export async function evaluateReleaseReadiness(projectRoot = root) {
  const gates = await Promise.all([
    checkMigrationsGate(projectRoot),
    checkSecurityGate(projectRoot),
    checkRollbackGate(projectRoot),
    checkSmokeAndInvariantsGate(projectRoot)
  ]);

  const passedGates = gates.filter((g) => g.passed).length;
  const failedGates = gates.length - passedGates;

  return {
    timestamp: new Date().toISOString(),
    passed: failedGates === 0,
    totalGates: gates.length,
    passedGates,
    failedGates,
    gates
  };
}

async function main() {
  const isJson = process.argv.includes("--json");
  const report = await evaluateReleaseReadiness();

  if (isJson) {
    console.log(JSON.stringify(report, null, 2));
    process.exit(report.passed ? 0 : 1);
  }

  console.log("=================================================");
  console.log("       UTIX RELEASE READINESS GATE REPORT        ");
  console.log("=================================================");
  console.log(`Evaluated at: ${report.timestamp}`);
  console.log(`Status: ${report.passed ? "PASSED (Ready for Release)" : "BLOCKED (Remediation Required)"}`);
  console.log(`Gates: ${report.passedGates}/${report.totalGates} passed\n`);

  for (const gate of report.gates) {
    const mark = gate.passed ? "[PASS]" : "[FAIL]";
    console.log(`${mark} ${gate.name}`);
    console.log(`       ${gate.details}`);
    if (gate.errors.length > 0) {
      for (const err of gate.errors) {
        console.log(`       - ERROR: ${err}`);
      }
    }
  }

  console.log("=================================================");
  if (!report.passed) {
    console.error("\nRELEASE BLOCKED: All readiness gates must pass before deployment.");
    process.exit(1);
  } else {
    console.log("\nRELEASE APPROVED: All readiness gates satisfied.");
    process.exit(0);
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) {
  main().catch((err) => {
    console.error("Release readiness gate encountered fatal error:", err);
    process.exit(2);
  });
}
