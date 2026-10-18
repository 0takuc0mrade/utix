# Operational integrity guardrails

Issues 202–205 add four small, dependency-free contracts used at operational boundaries:

- `createAuditEvidenceBundle` exports a redacted audit slice with a deterministic digest. `verifyAuditEvidenceBundle` must pass before an investigation bundle is trusted.
- `compareConfigurationContracts` checks that every environment contains the same production-critical configuration keys and reports the environment/key pair that is missing or unexpected.
- `createSideEffectDispatcher` persists idempotency keys, replays an existing job instead of enqueueing a duplicate, and moves failures to a dead-letter state after the bounded retry budget.
- `checkSchemaEvolution` rejects non-increasing versions and changes to required field types. `validateSchemaRecord` protects stored records and API responses at their boundary.

All four APIs accept injected storage or deterministic inputs, so contract tests can run without a network, secrets, or a production database.
