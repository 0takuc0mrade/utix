#!/usr/bin/env node

/**
 * Incident Drill Runner CLI
 *
 * Runs scheduled or on-demand incident simulation drills backed by executable
 * verification checks proving detection, mitigation, rollback, and impact reporting.
 *
 * Usage:
 *   node scripts/run-incident-drill.mjs
 *   node scripts/run-incident-drill.mjs --scenario drill-horizon-outage
 *   node scripts/run-incident-drill.mjs --json
 */

import { executeIncidentDrill, formatDrillReport, PREDEFINED_DRILL_SCENARIOS } from "../core/incident/drill.ts";

const args = process.argv.slice(2);
const isJson = args.includes("--json");

function getArgValue(flag) {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

const scenarioArg = getArgValue("--scenario");
const targetScenarioId = scenarioArg || "drill-horizon-outage";
const scenario = PREDEFINED_DRILL_SCENARIOS[targetScenarioId];

if (!scenario) {
  console.error(`Unknown scenario: ${targetScenarioId}`);
  console.error(`Available scenarios: ${Object.keys(PREDEFINED_DRILL_SCENARIOS).join(", ")}`);
  process.exit(1);
}

const result = await executeIncidentDrill(scenario);

if (isJson) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(formatDrillReport(result));
}

process.exit(result.passed ? 0 : 1);
