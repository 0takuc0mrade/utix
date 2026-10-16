# Policy Simulation Preview Framework (#234)

## Overview
The **Policy Simulation Preview Framework** allows Utix maintainers to evaluate proposed high-impact or irreversible operational policy changes across Stellar accounts, transaction validation rules, Soroban smart contract verifications, and quota constraints **before** committing changes to production.

## Architecture
The simulation engine (`core/policy/simulation.ts`) operates as a **strictly read-only pure function**:
- Never mutates state or writes to storage during preview execution.
- Categorizes all side effects by severity (`low`, `medium`, `high`, `critical`) and impact type.
- Evaluates rollback viability and outputs explicit rollback constraints.
- Emits an execution plan (`proceed`, `proceed_with_caution`, or `block`).

---

## Operational Edge Cases

1. **Zero-Weight Master Keys**:
   - Accounts with master weight 0 are intentionally locked or multisig issuing accounts.
   - Policies introducing minimum master key weight constraints must flag these accounts with critical severity to avoid locking out existing multisig workflows.

2. **Transient Ledger Sequence Drift**:
   - Simulation evaluated against a stale account snapshot may misclassify fee bumps or sequence numbers.
   - Ensure the evaluation dataset includes recent ledger state checkpoints.

3. **High-Cardinality Entity Scans**:
   - For datasets with >10,000 entities, simulation enforces batched evaluation to preserve memory limits without CPU starvation.

---

## Failure Modes & Mitigations

| Failure Mode | Symptoms | Mitigation |
| :--- | :--- | :--- |
| **False-Positive Policy Rejection** | Legitimate transactions blocked by overly aggressive fee or op filters | Preview side-effects before deployment; start with warning-only mode |
| **Unbounded Simulation Memory** | Process OOM on massive historical datasets | Stream simulation targets using bounded memory iterators |
| **Incomplete Target Record Attributes** | Missing `subentryCount` or `operations` in input records | Simulator provides safe defaults (`0` or empty arrays) without throwing |

---

## Rollback & Recovery Steps

1. **Reversible Policies**:
   - If `rollbackConstraints.reversible === true`, revert the configuration definition to the prior version tag.
   - No data restoration is required.

2. **Irreversible Policies (e.g., Hard Purges or Terminal Drops)**:
   - If `rollbackConstraints.reversible === false`, an automated snapshot must have been taken prior to execution.
   - Run disaster recovery verification: `npm run recovery:validate`.
   - Restore database and ledger state from the pre-simulation checkpoint using the disaster recovery runbook (`core/recovery/`).
