# Bundle Size Budget Enforcement

Utix enforces per-feature-slice bundle size budgets to prevent any single tool from quietly pulling in heavy dependencies that degrade load performance.

## Why Per-Feature Budgets

With an architecture built around independent, lazy-loaded feature slices, a generic total bundle size budget does not work. Each tool loads only its own chunk, so we need per-slice budgets that:

1. Prevent one heavy tool from hiding behind another's budget
2. Correctly attribute shared/core code versus slice-specific code
3. Allow independent contributors to add features without global coordination
4. Catch dependency bloat at PR time, not after user complaints

## Default Budget

**150 KB per feature slice** (uncompressed JavaScript)

This covers typical tool implementations including form validation, API calls, formatting, and result display.

## Route-Level Initial-Load Budget (#159)

**220 KB for the shared route shell** (`/tools/[slug]`)

Per-feature slice budgets do not expose shared-chunk regression or the cost paid before a user reaches a tool. Utix measures route-level initial-load overhead from the build manifest:
- Shared entrypoint chunks (`/_app`, webpack, root layout files)
- Dynamic route container (`/tools/[slug]/page.tsx`)
- Baseline tracking with stable tolerance ($\pm 5\%$) to prevent false positives from build hashes.

## Documented Exception Path for SDK-Heavy Tools (#159)

Tools that perform deep cryptographic decoding or compile Soroban contract ASTs require heavier dependencies (such as `@stellar/stellar-sdk` and `@stellar/stellar-xdr`). These tools have an explicit, documented exception path governed by [`scripts/bundle-budget-exceptions.json`](../scripts/bundle-budget-exceptions.json):

| Feature | Exception Budget | Justification |
| :--- | :--- | :--- |
| `xdr-inspector` | 350 KB | Deep recursive XDR parser and Soroban contract type schemas |
| `soroban-decoder` | 300 KB | Full Soroban ScVal decoding and contract auth types |
| `transaction-decoder` | 250 KB | Transaction envelope and operation XDR schemas |
| `soroban-spec-viewer` | 280 KB | Contract function specifications and environment interface bindings |

### Requesting an Exception
1. Ensure the heavy dependency cannot be split or loaded on-demand.
2. Add an entry in `scripts/bundle-budget-exceptions.json` with `budgetKB`, `justification`, and `approved: true`.
3. If the tool stays within its exception ceiling, `scripts/bundle-budget.mjs` marks it as `EXCEPTION_APPROVED`. If it exceeds the ceiling, it fails with `EXCEEDED`.

## Feature-Specific Budgets

Some tools have adjusted budgets based on their requirements:

| Feature | Budget | Justification |
| --- | --- | --- |
| payment-qr | 180 KB | QR code generation library |
| address-validator | 120 KB | Pure validation logic, no heavy deps |
| balance-viewer | 150 KB | Default budget |
| trustline-checker | 100 KB | Simple lookup operation |
| transaction-lookup | 140 KB | Moderate API interaction |
| freighter-connect | 80 KB | Minimal wallet detection |
| testnet-faucet | 90 KB | Single API call |

## Running Budget Checks

### Local Check

```bash
npm run build
node scripts/bundle-budget.mjs
```

### In CI

The check runs automatically as part of the build process. Budget violations fail the CI pipeline.

### JSON Output

For integration with tooling:

```bash
node scripts/bundle-budget.mjs --json
```

## Understanding Results

Example output:

```
Feature                       Size           Budget         Status
--------------------------------------------------------------------------------
payment-qr                    165 KB         180 KB         OK
address-validator             118 KB         120 KB         OK
balance-viewer                155 KB         150 KB         EXCEEDED
```

**Status values:**
- `OK` - Within budget
- `EXCEEDED` - Over budget, PR will fail

## Baseline Tracking

The `bundle-baseline.json` file tracks historical sizes to detect regressions:

```json
{
  "address-validator": {
    "totalSize": 102400,
    "sizeKB": 100,
    "timestamp": "2026-09-25T00:00:00.000Z"
  }
}
```

### Updating the Baseline

After intentional changes that affect bundle size:

```bash
npm run build
node scripts/bundle-budget.mjs --update-baseline
```

Commit the updated baseline with your PR.

## What Gets Measured

### Included
- Feature slice implementation code
- Feature-specific dependencies
- Lazy-loaded chunks for the feature route

### Excluded
- Shared core modules (`core/*`)
- Next.js runtime and framework code
- Vendor chunks shared across all features
- Static assets (CSS, images)

This ensures each feature is only charged for its incremental cost.

## When Budget Is Exceeded

If your feature exceeds its budget:

1. **Review dependencies** - Did you add a heavy library?
   - Check package size on npm or bundlephobia.com
   - Consider lighter alternatives
   - Use dynamic imports for optional functionality

2. **Code-split heavy operations**
   - Move heavy computations to web workers
   - Lazy load rarely-used components
   - Split large utility functions

3. **Optimize imports**
   - Import only what you need: `import { specific } from 'lib'`
   - Avoid entire libraries: `import * as lib from 'lib'`
   - Check for duplicate dependencies in package-lock.json

4. **Request budget increase**
   - If the feature genuinely requires more budget
   - Document why in the PR description
   - Update `FEATURE_BUDGETS` in `scripts/bundle-budget.mjs`
   - Update this documentation

## Adding New Features

New features inherit the default budget (150 KB) unless specified otherwise.

To set a custom budget:

1. Edit `scripts/bundle-budget.mjs`
2. Add entry to `FEATURE_BUDGETS` object:
   ```javascript
   const FEATURE_BUDGETS = {
     'your-feature': 120, // KB
   };
   ```
3. Document the justification in your PR

## CI Integration

The bundle budget check runs after build:

```yaml
- name: Check bundle budgets
  run: |
    npm run build
    node scripts/bundle-budget.mjs
```

Exit codes:
- **0** - All features within budget
- **1** - Budget violations detected
- **2** - Script error (missing build output, etc.)

## Testing Budget Enforcement

To verify the budget system catches violations:

1. Add a deliberately heavy dependency to a test feature
2. Run `npm run build && node scripts/bundle-budget.mjs`
3. Confirm the check fails with `EXCEEDED` status
4. Remove the dependency

## Budget Evolution

As the project grows:

- Monitor baseline drift over time
- Review whether default budget remains appropriate
- Consider stricter budgets for simple tools
- Document rationale for budget increases
- Keep budgets tight enough to prevent bloat, loose enough to allow reasonable implementations

## Best Practices

- Check bundle size before requesting review
- Update baseline only when intentional
- Never increase budget to bypass review
- Document heavy dependencies in PR description
- Consider performance impact on slow connections
- Remember: users on mobile networks pay for every KB
