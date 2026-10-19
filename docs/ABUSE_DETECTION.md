# Risk-Scored Abuse Detection for Suspicious High-Impact Operations (#226)

## Overview

Utix is designed as a read-only toolkit, but users and developer workflows execute high-impact diagnostic analyses, testnet funding, account option previews, ownership transfers, and large-scale data exports.

The **Abuse Detection Engine** (`core/security/abuse-detection.ts`) computes transparent, explainable risk scores for potentially abusive or high-impact operations. Instead of indiscriminately blocking users, it implements a **progressive friction model** (Step-Up Challenge -> Maintainer Review -> Block).

---

## Decision Matrix & Risk Tiers

| Score Range | Action | Required Step-Up Friction | Intended Use Case |
|---|---|---|---|
| **0 – 39** | `allow` | None (`none`) | Routine read operations (address checks, balance queries, transaction inspection). Zero friction. |
| **40 – 69** | `step_up` | Confirmation Challenge (`confirm_dialog`) | High-impact user actions (account merge analysis, master key disabling, large exports). |
| **70 – 89** | `review` | Maintainer Approval (`maintainer_approval`) | Bulk exports of maintainer datasets, rapid burst testnet faucet usage. |
| **90 – 100** | `block` | Backoff / Rate Limit (`rate_limit_backoff`) | Extreme request velocity, massive XDR bombs, abusive repeated actions. |

---

## Explainable Risk Signals

Every evaluation produces explicit, human-readable risk signals:

```typescript
const assessment = evaluateAbuseRisk({
  operation: "account.set_options",
  actor: { kind: "user", id: "G..." },
  payload: { masterWeight: 0 }
});

// Returns:
// {
//   score: 45,
//   action: "step_up",
//   requiredStepUp: "confirm_dialog",
//   signals: [
//     {
//       id: "disabled_master_key",
//       name: "Master Key Weight Zeroed",
//       points: 45,
//       reason: "Zeroing master key permanently disables direct signing by account master key."
//     }
//   ]
// }
```

---

## Key Risk Signals

1. **`destructive_account_merge` (+45 pts)**:
   - Account merge permanently destroys the source account and reallocates all native reserves.
2. **`disabled_master_key` (+45 pts)**:
   - Setting `masterWeight = 0` locks the account out unless alternate signers are configured.
3. **`faucet_burst_drain` (+50 pts)**:
   - More than 5 Friendbot funding requests in a short time window.
4. **`sensitive_bulk_export` (+40 pts)**:
   - Exporting maintainer-scoped audit logs or telemetry records.
5. **`oversized_xdr_payload` (+45 pts)**:
   - XDR payload exceeds 256KB, risking client browser memory exhaustion.
6. **`excessive_burst_velocity` (+35 pts)**:
   - Over 20 operations within the observation window.

---

## Operational Edge Cases & Failure Modes

1. **Legitimate Power User High-Volume Export**:
   - *Risk*: A developer legitimately exporting historical testnet transactions triggers `step_up`.
   - *Behavior*: The user confirms the action via `confirm_dialog`. The operation is allowed and audited without blocking.
2. **False Positive Review Hold**:
   - *Recovery*: Maintainers review the assessment via `getAbuseAssessment(id)` and apply `overrideAbuseAssessment(id, "allow", actor, "Verified partner workflow")`.
3. **Network Partition During Friendbot Faucet**:
   - *Risk*: Retries look like rapid repeat requests.
   - *Behavior*: Idempotency keys prevent duplicate credit attempts and classify repeated submissions as safe replays.

---

## Rollback & Recovery Steps

1. **Maintainer Overrides**:
   Maintainers can clear or override any active abuse restriction:
   ```typescript
   overrideAbuseAssessment(evaluationId, "allow", maintainerActor, "Approved after identity verification");
   ```
2. **Audit Verification**:
   Inspect all abuse evaluations in the append-only audit trail:
   ```bash
   node scripts/verify-audit.mjs
   ```
