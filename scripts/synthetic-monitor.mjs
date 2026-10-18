#!/usr/bin/env node

/**
 * Synthetic monitor for the critical journey (#269).
 *
 * Runs the live Horizon probe in core/health/synthetic.ts. It needs Node 24
 * (built-in TypeScript type stripping) and no installed dependencies.
 *
 * Usage:
 *   UTIX_USER_ROLE=service node scripts/synthetic-monitor.mjs [--network testnet|mainnet] [--json]
 *
 * Exit codes: 0 healthy or degraded, 1 unhealthy, 2 unauthorized or crashed.
 */

import { register } from "node:module";

register("./loader.mjs", import.meta.url);

const { runSyntheticMonitor } = await import("../core/health/synthetic.ts");
const { isStellarNetwork } = await import("../core/network/types.ts");

const args = process.argv.slice(2);
const networkFlag = args.indexOf("--network");
const network = networkFlag === -1 ? "testnet" : args[networkFlag + 1];

if (!isStellarNetwork(network)) {
  console.error(`Unknown network "${network}". Use testnet or mainnet.`);
  process.exit(2);
}

try {
  const outcome = await runSyntheticMonitor({ role: process.env.UTIX_USER_ROLE ?? "viewer" }, { network });
  if (!outcome.ok) {
    console.error("Synthetic monitor refused: the role needs admin:health (set UTIX_USER_ROLE=service).");
    process.exit(2);
  }

  const report = outcome.value;
  if (args.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`Critical journey on ${report.network}: ${report.status.toUpperCase()} in ${report.durationMs}ms`);
    for (const step of report.steps) {
      const mark = step.ok ? "✓" : "✗";
      const failure = step.errorCode ? ` — ${step.errorCode}` : "";
      console.log(`  ${mark} ${step.step} (${step.attempts} attempt(s), ${step.latencyMs}ms)${failure}`);
    }
    if (report.ingestLagLedgers !== undefined) console.log(`  ingestion lag: ${report.ingestLagLedgers} ledger(s)`);
    console.log(`  correlation id: ${report.correlationId}`);
  }
  process.exit(report.status === "unhealthy" ? 1 : 0);
} catch (error) {
  console.error("Synthetic monitor crashed:", error);
  process.exit(2);
}
