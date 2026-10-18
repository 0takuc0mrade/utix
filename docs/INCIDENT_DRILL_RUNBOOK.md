# Incident Drill Runbook & Executable Verification

## Overview

Incident drills in Utix are not static checklists: they are automated operational simulations backed by executable verification checks. Each drill exercises the entire incident lifecycle:
1. **Simulation & Detection**: Automated incident instantiation, severity triage, and system impact tagging.
2. **Mitigation Execution**: Step-by-step mitigation execution with automated criteria verification.
3. **Rollback & Recovery**: Execution of version rollback or failover plan and health check verification.
4. **Data Invariant Validation**: Execution of domain data consistency checks ensuring zero corruption post-recovery.
5. **User-Impact Reporting**: Calculation of downtime, affected users, and recovered operations, sealed with a cryptographic audit receipt.

## Drill Scenarios

| Drill ID | Title | Severity | Invariant / Target Checked |
| :--- | :--- | :--- | :--- |
| `drill-horizon-outage` | Primary Horizon RPC Outage and Failover | Critical | Backup RPC connectivity & balance query responsiveness |
| `drill-stale-ledger-drift` | Ledger Sequence Drift & Stale Node Recovery | High | Ledger sequence monotonicity & consensus freshness |
| `drill-data-corruption-recovery` | Data Corruption & Restore Invariants | Critical | Clock-skew, negative elapsed time, and manifest uniqueness |
| `drill-poisoned-webhook-flood` | Poisoned Webhook Signature Flood | High | Queue drain to quarantine & signature check success rate |

## Running an Incident Drill

Execute on-demand drill in human-readable mode:

```bash
node scripts/run-incident-drill.mjs --scenario drill-horizon-outage
```

Execute in machine-readable JSON mode for CI/CD or synthetic monitoring:

```bash
node scripts/run-incident-drill.mjs --scenario drill-data-corruption-recovery --json
```

Run via npm test suite:

```bash
npm test -- core/incident/__tests__/drill.test.ts
```

## Drill Lifecycle & Verification Phases

```
[ Phase 1: Detection & Triage ]
        │  • Incident record created in core/incident/runbook
        │  • Symptoms matched to registered procedures
        ▼
[ Phase 2: Mitigation Execution ]
        │  • Each mitigation step executed
        │  • Automated check() assertion validated
        ▼
[ Phase 3: Rollback & Recovery ]
        │  • Rollback plan activated to targetVersion
        │  • Failover / backup checks evaluated
        ▼
[ Phase 4: Data Validation ]
        │  • Read-only invariant checks run
        │  • Verifies 0 orphan records and 0 corruption
        ▼
[ Phase 5: User-Impact Report & Audit Receipt ]
           • Calculates downtimeSeconds, affectedUsersCount
           • Emits SHA-256 audit receipt
```

## Exit Codes and Automation Guardrails

- `0`: Drill passed all 5 phases with 100% check pass rate.
- `1`: Drill failed one or more phase verification checks or unknown scenario provided.

## Failure Modes & Escalation

If any verification step returns `false` during a live incident or drill:
1. The drill runner immediately halts progression to avoid compounding state inconsistencies.
2. The phase is marked `[FAIL]`, recording step order, target system, and error details.
3. On-call engineering is paged according to the escalation path in `core/incident/runbook.ts`.
4. Review the generated SHA-256 audit receipt in the drill report for post-mortem analysis.
