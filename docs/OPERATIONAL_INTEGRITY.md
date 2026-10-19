# Operational integrity guardrails

Issues 202–205 add four small, dependency-free contracts used at operational boundaries:

- `createAuditEvidenceBundle` exports a redacted audit slice with a deterministic digest. `verifyAuditEvidenceBundle` must pass before an investigation bundle is trusted.
- `compareConfigurationContracts` checks that every environment contains the same production-critical configuration keys and reports the environment/key pair that is missing or unexpected.
- `createSideEffectDispatcher` persists idempotency keys, replays an existing job instead of enqueuing a duplicate, and moves failures to a dead-letter state after the bounded retry budget.
- `checkSchemaEvolution` rejects non-increasing versions and changes to required field types. `validateSchemaRecord` protects stored records and API responses at their boundary.

All four APIs accept injected storage or deterministic inputs, so contract tests can run without a network, secrets, or a production database.

## Accessibility regression coverage

The accessibility suite guards the dense forms, tables, and error recovery flows used by the utility tools, transaction inspector, and Soroban diagnostics workflows. It runs with the existing test runner and does not change public APIs, schemas, or user-facing behavior.

### What is covered

- `**Keyboard navigation**: dense forms are traversed in document order with Tab/Shift+Tab, submit actions are reachable from the keyboard, and table rows expose their actions without a pointer.`
- `**Focus management**: focus moves to the first invalid field on validation failure, returns to the trigger on cancel, and is trapped in modal dialogs until dismissed.`
- `**Screen-reader announcements**: error summaries are exposed through `_role="alert"` and `_role="status"` live regions, table captions and headers are associated, and form controls retain accessible names.`
- `**Reduced motion**: with `prefers-reduced-motion: reduce` the flow remains usable and no animation-dependent state is lost.`
- **Error recovery**: transient failures surface a retry affordance, retry restores the previous inputs, and terminal failures announce a recovery path without losing focus context.

### How to run

The accessibility regression tests live alongside the existing contract tests and run with the repository test command:

```sh
npm test -- accessibility
```

The suite is deterministic: it uses injected dom fixtures and mocked media queries, so it needs no network, secrets, or production database.

## Operational edge cases

- Empty or single-row tables must still expose a caption and header relationships.
- Forms with conditionally hidden fields (for example, Soroban diagnostic options) must not leave focus on a hidden control.
- Error recovery must preserve user input across retry and must not duplicate announcements when the same error repeats.
- Reduced-motion preferences may change at runtime; the flow must respond without a reload.
- Table sorting and filtering must announce the new result count without stealing focus from the control that triggered it.

## Failure modes

- A regression in focus order or announcement content fails the suite before merge.
- Missing live regions or labels fail the screen-reader assertions.
- Animation-dependent state fails the reduced-motion assertions.
- Error recovery that loses input or focus context fails the recovery assertions.

## Rollback and recovery

If an accessibility regression is detected in production:

1. Revert the offending UI change to the last known-good revision; the suite is pure test coverage and requires no data migration.
2. Re-run `npm test -- accessibility` to confirm the baseline passes.
3. Reproduce the failure with the added case before reintroducing the change.
4. If the failure involves announcements or focus in a live workflow, disable the affected flow behind its existing feature flag until the fix ships.
5. Record the incident and the added regression case in the changelog so the coverage gap cannot silently return.
