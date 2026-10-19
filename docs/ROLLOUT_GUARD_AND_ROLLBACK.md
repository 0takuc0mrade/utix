# Feature-Flag Rollout Guard with Automatic Rollback Verification (#223)

## Overview

Deploying experimental feature slices, Soroban RPC protocol updates, or high-risk changes into production requires continuous operational monitoring and fast, safe rollback mechanisms.

The **Feature-Flag Rollout Guard** (`core/feature-flags/rollout-guard.ts`) safeguards production by:
1. Scoping risky rollouts (canary percentage, network targeting, allowlists, risk tiers).
2. Continuously monitoring error rates and consecutive failure streaks.
3. Automatically tripping an emergency kill-switch when error thresholds are exceeded.
4. Immediately executing **automatic rollback verification** to ensure that partially processed records, orphaned background jobs, or inconsistent intermediate states are detected, cleaned up, and audited.

---

## Architecture & Rollout Workflow

```
┌────────────────────────────────────────────────────────┐
│             RolloutGuard Configuration                 │
│  - flag: "sorobanFeeEstimator"                         │
│  - riskTier: "critical" (max 3 consecutive failures)   │
│  - errorThresholdPercent: 20%                          │
│  - allowedNetworks: ["testnet"]                        │
└────────────────────────────────────────────────────────┘
                           │
                           ▼
                  [Active Operation Flow]
               ┌─────────────┴─────────────┐
               ▼                           ▼
          recordSuccess()             recordFailure()
               │                           │
               │               Threshold breached?
               │                           │
               │                   Yes ────┼────────────────┐
               │                           │                │
               │                           ▼                ▼
               │              [Trip Emergency Disable]  [Rollback Verification]
               │                           │                │
               │                           ▼                ▼
               │                Disable feature flag    Check state consistency
               │                                        Remediate orphaned records
               │                                        Emit Telemetry & Audit
               ▼                                            │
        Healthy Rollout ◄───────────────────────────────────┘
```

---

## State Consistency Verification & Remediation

When a rollback is triggered (either automatically via anomaly detection or manually by a maintainer), `RolloutGuard` executes registered `StateConsistencyCheck` rules against the system state:

```typescript
const guard = createRolloutGuard(
  {
    flag: "contractEventSubscription",
    riskTier: "high",
    percentage: 10,
    allowedNetworks: ["testnet"],
    errorThresholdPercent: 15,
    maxConsecutiveFailures: 3
  },
  {
    stateProvider: () => runtimeState,
    consistencyChecks: [
      {
        name: "no_stranded_jobs",
        description: "Verify no worker jobs remain in intermediate running state",
        check: (state) => ({
          valid: !state.workerJobs.some((j) => j.status === "running" && j.feature === "contractEventSubscription"),
          violation: "Found stranded running worker jobs"
        }),
        remediate: (state) => {
          state.workerJobs = state.workerJobs.filter((j) => j.feature !== "contractEventSubscription");
          return { remediated: true, details: "Cleaned up stranded worker jobs" };
        }
      }
    ]
  }
);
```

---

## Operational Edge Cases & Failure Modes

### 1. Cascade Failure During Partial Rollout
- **Scenario**: A 10% canary rollout encounters an unhandled RPC transport bug on mainnet.
- **Guardrail**: As soon as 3 consecutive failures occur, `recordFailure()` trips the guard, invokes `triggerEmergencyDisable(flag)`, and evaluates all consistency checks.
- **Outcome**: The feature is immediately disabled for 100% of users, protecting the remaining 90% from seeing the failure.

### 2. Orphaned State Left in Browser Storage
- **Scenario**: A feature flag enabled a new storage format. After rollback, the application must not crash reading newer schema records.
- **Guardrail**: The consistency check inspects stored keys, falls back to legacy storage keys, and logs an audit trail.

### 3. False Positive Trip on Network Spike
- **Scenario**: Transient network timeout trips the guard.
- **Recovery**: The guard records an audit entry with `triggerReason`. Maintainers verify network stability and reset the guard via `clearEmergencyDisable(flag)` after root-cause validation.

---

## Rollback & Recovery Steps

1. **Verify Guard Status**:
   Inspect whether a flag is emergency disabled or tripped:
   ```bash
   node --loader ./scripts/loader.mjs scripts/contributor-diagnostics.mjs
   ```

2. **Run Rollback Verification**:
   Execute the automated verification script:
   ```bash
   npm run verify:issues-219-240
   ```

3. **Inspect Audit Records**:
   Review details of the automated kill-switch event:
   ```bash
   node scripts/verify-audit.mjs
   ```
