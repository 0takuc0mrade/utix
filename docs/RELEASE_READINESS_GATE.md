# Release Readiness Gate (#237)

## Overview
The **Release Readiness Gate** (`scripts/release-readiness-gate.mjs`) is an automated pre-deployment checklist and CI gate that validates that all database migrations, security controls, rollback rehearsals, and core domain invariants are fully verified before promoting a release to production.

Running the gate:
```bash
npm run verify:readiness
# or in JSON format for automated CI pipelines:
node scripts/release-readiness-gate.mjs --json
```

---

## The Four Mandatory Gates

1. **Database & Schema Migrations Gate**:
   - Inspects `core/migration/` components and schema migrations.
   - Verifies that every migration declares dry-run execution (`dryRun`), post-migration invariant checks (`postChecks`), and automated rollback procedures (`rollback` / `rollbackNotes`).
   - Verifies that `MigrationRunner` supports automated rollback on invariant failure (`autoRollbackOnFailure`).

2. **Security & Secret Sanitization Gate**:
   - Scans core code and scripts for unredacted Stellar secret keys (`S[A-Z2-7]{55}`).
   - Scans for dangerous open redirects and `javascript:` URIs in feature anchors.
   - Enforces secret scrubbing policies.

3. **Rollback Rehearsals & Disaster Recovery Gate**:
   - Validates disaster recovery verification logic (`core/recovery/validator.ts`).
   - Enforces conservative expiry (`isExpiredConservatively`) to prevent revival of expired records when client clocks drift backwards.
   - Rehearses clock skew tolerance windows (`validateClockAndExpiryInvariants`).
   - Verifies incident runbook documentation (`core/incident/runbook.ts`).

4. **Smoke Tests & Invariant Verification Gate**:
   - Validates dry-run reconciliation and dry-run-first repair contracts (`scripts/verify-reconciliation.mjs`).
   - Validates audit logging coverage (`scripts/verify-audit.mjs`).
   - Validates feature registry consistency.

---

## Operational Edge Cases

1. **Emergency Patch Releases**:
   - In incident hotfixes, maintainers must not bypass the security or rollback gates.
   - If a migration cannot be safely rolled back, it must be marked `riskLevel: 'critical'`, include explicit manual recovery runbooks, and take an automated pre-migration ledger snapshot.

2. **Mock Secret Keys in Documentation or Tests**:
   - Unit tests and documentation must use placeholder or redacted tokens (`[REDACTED]` or pattern variables) rather than valid base32 Stellar secret keys.

3. **Cross-Timezone Restore Operations**:
   - Rollback rehearsals verify UTC normalization so that timestamps across different timezones and leap-second events do not invalidate restore manifests.

---

## Failure Modes & Mitigations

| Failure Mode | Impact | Mitigation |
| :--- | :--- | :--- |
| **Missing Rollback Handler** | Migration fails in production with no clean reversion | Gate blocks release with exit code 1 until rollback handler and notes are provided |
| **Leaked Secret Key** | Compromise of master issuing or signer account | Security gate halts build and identifies offending file and line |
| **Clock Drift during Restore** | Disaster recovery manifests rejected due to timestamp drift | Configurable clock skew tolerance window (default 60,000ms) with monotonic watermark checks |

---

## Rollback & Recovery Steps

1. **If Release Gate Fails in CI**:
   - Inspect the printed failure list in the report.
   - Address the specific missing component (e.g., add missing rollback handler, redact test secret, or register invariant check).
   - Re-run `npm run verify:readiness` locally before re-pushing.

2. **If Production Rollback is Required Post-Release**:
   - Follow the disaster recovery runbook (`npm run recovery:validate`).
   - Apply reverse migration via `MigrationRunner.execute(migration, records, { autoRollbackOnFailure: true })`.
