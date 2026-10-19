#!/usr/bin/env node

/**
 * Per-feature and route-level initial-load bundle size budget enforcement (#159)
 * 
 * Analyzes Next.js build output to compute:
 * 1. Per-feature-slice bundle sizes with documented exception path for SDK-heavy tools.
 * 2. Route-level initial-load costs capturing shared chunk regression and pre-flight overhead.
 * 
 * Prevents stealth dependency bloat while providing an objective review path for SDK-heavy tools.
 */

import { readFileSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..');

export const BASELINE_PATH = join(ROOT, 'bundle-baseline.json');
export const BUILD_MANIFEST_PATH = join(ROOT, '.next/build-manifest.json');
export const EXCEPTIONS_PATH = join(ROOT, 'scripts/bundle-budget-exceptions.json');

export const DEFAULT_BUDGET_KB = 150;
export const ROUTE_INITIAL_LOAD_BUDGET_KB = 220;
export const STABLE_TOLERANCE_PERCENT = 5;

export const FEATURE_BUDGETS = {
  'address-validator': 120,
  'balance-viewer': 150,
  'trustline-checker': 100,
  'payment-qr': 180,
  'transaction-lookup': 140,
  'freighter-connect': 80,
  'testnet-faucet': 90,
};

export function loadBaseline(baselinePath = BASELINE_PATH) {
  if (!existsSync(baselinePath)) {
    return {};
  }
  
  try {
    return JSON.parse(readFileSync(baselinePath, 'utf-8'));
  } catch (error) {
    console.warn(`Warning: Could not load baseline from ${baselinePath}`);
    return {};
  }
}

export function loadExceptions(exceptionsPath = EXCEPTIONS_PATH) {
  if (!existsSync(exceptionsPath)) {
    return {};
  }
  
  try {
    const data = JSON.parse(readFileSync(exceptionsPath, 'utf-8'));
    return data.exceptions || {};
  } catch (error) {
    console.warn(`Warning: Could not load exceptions from ${exceptionsPath}`);
    return {};
  }
}

export function loadBuildManifest(manifestPath = BUILD_MANIFEST_PATH) {
  if (!existsSync(manifestPath)) {
    throw new Error(`Build manifest not found at ${manifestPath}. Run 'npm run build' first.`);
  }
  
  return JSON.parse(readFileSync(manifestPath, 'utf-8'));
}

export function computeChunkSize(chunkPath, rootDir = ROOT) {
  const fullPath = join(rootDir, '.next', chunkPath);
  
  if (!existsSync(fullPath)) {
    return 0;
  }
  
  const stats = readFileSync(fullPath);
  return stats.length;
}

export function analyzeRouteInitialLoad(manifest, rootDir = ROOT) {
  const sharedChunkSet = new Set();
  const chunkDetails = [];

  // 1. Shared app entrypoint chunks
  const appChunks = manifest.pages?.['/_app'] || [];
  for (const chunk of appChunks) {
    sharedChunkSet.add(chunk);
  }

  // 2. Root main files if exposed by Next.js manifest
  const rootFiles = manifest.rootMainFiles || [];
  for (const chunk of rootFiles) {
    sharedChunkSet.add(chunk);
  }

  // 3. Common dynamic route host shell
  const toolRouteChunks = manifest.pages?.['/tools/[slug]'] || [];
  for (const chunk of toolRouteChunks) {
    sharedChunkSet.add(chunk);
  }

  let totalSize = 0;
  for (const chunk of sharedChunkSet) {
    const size = computeChunkSize(chunk, rootDir);
    if (size > 0) {
      totalSize += size;
      chunkDetails.push({ path: chunk, size });
    }
  }

  return {
    totalSize,
    sizeKB: Math.round(totalSize / 1024),
    chunks: chunkDetails,
  };
}

export function analyzeFeatureSlices(manifest, rootDir = ROOT) {
  const featureSizes = {};
  
  for (const [route, chunks] of Object.entries(manifest.pages || {})) {
    const match = route.match(/^\/tools\/\[slug\]$/);
    if (!match) continue;
    
    let totalSize = 0;
    const chunkDetails = [];
    
    for (const chunk of chunks) {
      if (chunk.includes('/_app') || chunk.includes('/_error')) {
        continue;
      }
      
      if (chunk.includes('/webpack') || chunk.includes('/node_modules/')) {
        continue;
      }
      
      const size = computeChunkSize(chunk, rootDir);
      if (size > 0) {
        totalSize += size;
        chunkDetails.push({ path: chunk, size });
      }
    }
    
    featureSizes[route] = {
      totalSize,
      chunks: chunkDetails,
    };
  }
  
  const dynamicChunks = manifest.sortedPages?.filter(page => 
    page.startsWith('dynamic/') && page.includes('features/')
  ) || [];
  
  for (const chunk of dynamicChunks) {
    const match = chunk.match(/features\/([^\/]+)/);
    if (!match) continue;
    
    const featureName = match[1];
    const size = computeChunkSize(`static/chunks/${chunk}.js`, rootDir);
    
    if (size > 0) {
      if (!featureSizes[featureName]) {
        featureSizes[featureName] = {
          totalSize: 0,
          chunks: [],
        };
      }
      
      featureSizes[featureName].totalSize += size;
      featureSizes[featureName].chunks.push({
        path: `static/chunks/${chunk}.js`,
        size,
      });
    }
  }
  
  return featureSizes;
}

export function checkBudgets(featureSizes, routeInitialLoad = { totalSize: 0, sizeKB: 0, chunks: [] }, baseline = {}, exceptions = {}) {
  const results = [];
  let hasViolations = false;
  
  for (const [feature, data] of Object.entries(featureSizes)) {
    if (feature.startsWith('_')) continue;

    const sizeKB = Math.round(data.totalSize / 1024);
    const standardBudgetKB = FEATURE_BUDGETS[feature] || DEFAULT_BUDGET_KB;
    const baselineSizeKB = baseline[feature] ? Math.round(baseline[feature].totalSize / 1024) : 0;
    const delta = sizeKB - baselineSizeKB;
    
    const exception = exceptions[feature];
    const isApprovedException = Boolean(exception?.approved);
    const exceptionCeilingKB = exception?.budgetKB || standardBudgetKB;

    let status = 'OK';
    let withinBudget = true;
    let justification = null;

    if (sizeKB <= standardBudgetKB) {
      status = 'OK';
      withinBudget = true;
    } else if (isApprovedException && sizeKB <= exceptionCeilingKB) {
      status = 'EXCEPTION_APPROVED';
      withinBudget = true;
      justification = exception.justification;
    } else if (isApprovedException && sizeKB > exceptionCeilingKB) {
      status = 'EXCEEDED (over exception ceiling)';
      withinBudget = false;
      hasViolations = true;
      justification = exception.justification;
    } else {
      status = 'EXCEEDED';
      withinBudget = false;
      hasViolations = true;
    }
    
    results.push({
      feature,
      sizeKB,
      budgetKB: isApprovedException ? exceptionCeilingKB : standardBudgetKB,
      standardBudgetKB,
      isException: isApprovedException,
      justification,
      baselineSizeKB,
      delta,
      status,
      withinBudget,
      chunks: data.chunks,
    });
  }

  // Check Route-level Initial-Load budget (#159)
  const routeBaselineKB = baseline._route_initial_load?.sizeKB || 0;
  const routeDelta = routeInitialLoad.sizeKB - routeBaselineKB;
  const routeWithinBudget = routeInitialLoad.sizeKB <= ROUTE_INITIAL_LOAD_BUDGET_KB;
  const routeStatus = routeWithinBudget ? 'OK' : 'EXCEEDED';

  if (!routeWithinBudget) {
    hasViolations = true;
  }

  const routeResult = {
    name: 'Route Initial-Load (/tools/[slug])',
    sizeKB: routeInitialLoad.sizeKB,
    budgetKB: ROUTE_INITIAL_LOAD_BUDGET_KB,
    baselineSizeKB: routeBaselineKB,
    delta: routeDelta,
    status: routeStatus,
    withinBudget: routeWithinBudget,
    chunks: routeInitialLoad.chunks,
  };
  
  return { results, routeResult, hasViolations };
}

export function formatReport(results, routeResult, hasViolations) {
  const lines = [];
  
  lines.push('='.repeat(80));
  lines.push('UTIX INITIAL-LOAD & FEATURE BUNDLE BUDGET REPORT (#159)');
  lines.push('='.repeat(80));
  lines.push('');
  
  // 1. Route-Level Initial-Load Section
  lines.push('ROUTE INITIAL-LOAD COSTS');
  lines.push('-'.repeat(80));
  if (routeResult) {
    const routeName = routeResult.name.padEnd(35);
    const size = `${routeResult.sizeKB} KB`.padEnd(15);
    const budget = `${routeResult.budgetKB} KB`.padEnd(15);
    lines.push(`${routeName}${size}${budget}${routeResult.status}`);
    if (routeResult.delta !== 0 && routeResult.baselineSizeKB > 0) {
      const deltaStr = routeResult.delta > 0 ? `+${routeResult.delta}` : `${routeResult.delta}`;
      lines.push(`  (${deltaStr} KB from baseline: ${routeResult.baselineSizeKB} KB)`);
    }
  }
  lines.push('');

  // 2. Per-Feature Slices Section
  lines.push('FEATURE SLICE BUDGETS');
  lines.push('-'.repeat(80));
  if (results.length === 0) {
    lines.push('No feature slices detected in build output.');
    lines.push('This is normal for a fresh build without features.');
  } else {
    lines.push('Feature'.padEnd(30) + 'Size'.padEnd(15) + 'Budget'.padEnd(15) + 'Status');
    lines.push('-'.repeat(80));
    
    for (const result of results) {
      const featureName = result.feature.padEnd(30);
      const size = `${result.sizeKB} KB`.padEnd(15);
      const budget = `${result.budgetKB} KB`.padEnd(15);
      const status = result.status;
      
      lines.push(`${featureName}${size}${budget}${status}`);
      
      if (result.isException && result.justification) {
        lines.push(`  [Exception Approved: ${result.justification}]`);
      }

      if (result.delta !== 0 && result.baselineSizeKB > 0) {
        const deltaStr = result.delta > 0 ? `+${result.delta}` : `${result.delta}`;
        lines.push(`  (${deltaStr} KB from baseline)`);
      }
    }
  }
  
  lines.push('');
  lines.push('='.repeat(80));
  
  if (hasViolations) {
    lines.push('');
    lines.push('BUDGET VIOLATIONS DETECTED');
    lines.push('');
    lines.push('To resolve:');
    lines.push('  1. Review dependencies added to the feature or shared route layout');
    lines.push('  2. Ensure SDK imports are isolated to lazy-loaded panel chunks');
    lines.push('  3. If feature is SDK-heavy (e.g. XDR/Soroban), submit an exception in bundle-budget-exceptions.json');
    lines.push('');
  }
  
  return lines.join('\n');
}

export function saveBaseline(featureSizes, routeInitialLoad = { totalSize: 0, sizeKB: 0 }) {
  const baseline = {};
  
  for (const [feature, data] of Object.entries(featureSizes)) {
    baseline[feature] = {
      totalSize: data.totalSize,
      sizeKB: Math.round(data.totalSize / 1024),
      timestamp: new Date().toISOString(),
    };
  }

  if (routeInitialLoad && routeInitialLoad.totalSize > 0) {
    baseline._route_initial_load = {
      totalSize: routeInitialLoad.totalSize,
      sizeKB: routeInitialLoad.sizeKB,
      timestamp: new Date().toISOString(),
    };
  }
  
  writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2));
  console.log(`\nBaseline saved to ${BASELINE_PATH}`);
}

async function main() {
  const args = process.argv.slice(2);
  const updateBaseline = args.includes('--update-baseline');
  const jsonOutput = args.includes('--json');
  
  try {
    const baseline = loadBaseline();
    const exceptions = loadExceptions();
    const manifest = loadBuildManifest();
    const featureSizes = analyzeFeatureSlices(manifest);
    const routeInitialLoad = analyzeRouteInitialLoad(manifest);
    const { results, routeResult, hasViolations } = checkBudgets(featureSizes, routeInitialLoad, baseline, exceptions);
    
    if (jsonOutput) {
      console.log(JSON.stringify({ results, routeResult, hasViolations }, null, 2));
    } else {
      console.log(formatReport(results, routeResult, hasViolations));
    }
    
    if (updateBaseline) {
      saveBaseline(featureSizes, routeInitialLoad);
    }
    
    if (hasViolations && !updateBaseline) {
      process.exit(1);
    }
  } catch (error) {
    console.error('Bundle budget check failed:');
    console.error(error.message);
    process.exit(2);
  }
}

// Only invoke CLI runner if executed directly
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
