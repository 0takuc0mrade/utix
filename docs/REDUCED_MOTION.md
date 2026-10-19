# Reduced-Motion Preference Support

Utix provides comprehensive reduced-motion accessibility support across all shared UI primitives, dynamic routes, and feature slices in compliance with **WCAG 2.1 AA (Success Criterion 2.3.3: Animation from Interactions)**.

## Core Principle: State Visibility Without Animation Dependency

Users who configure their operating system or browser to prefer reduced motion (`prefers-reduced-motion: reduce`) must not experience vestibular disorientation or delayed feedback:

1. **Immediate State Visibility**: Async loading, status reveals, and interactive feedback do not depend on animation completion.
2. **Static Affordances**: Loading skeletons preserve their exact dimensional layout and `data-contract-state="loading"` attribute as solid, non-pulsing placeholders.
3. **Instant Transitions**: Hover, active, focus, and status transition delays are reduced to zero.

---

## Shared Testable Utilities (`core/ui/accessibility.ts`)

### 1. `prefersReducedMotion(defaultValue = false): boolean`

Synchronous query evaluating the media query `(prefers-reduced-motion: reduce)`.

```typescript
import { prefersReducedMotion } from "@/core/ui";

const shouldAnimate = !prefersReducedMotion();
```

- **Default Behavior**: Defaults to `false` (motion enabled) when `window` or `window.matchMedia` is unavailable (e.g. during server-side rendering).
- **Safe Fallback**: Any media-query evaluation error gracefully returns the default value without throwing.

### 2. `useReducedMotion(defaultValue = false): boolean`

React hook that subscribes to OS and browser preference changes in real time.

```typescript
import { useReducedMotion } from "@/core/ui";

export function CustomVisualizer() {
  const reducedMotion = useReducedMotion();

  return (
    <div className={reducedMotion ? "opacity-100" : "animate-fade-in-up"}>
      Content
    </div>
  );
}
```

- **Lifecycle**: Attaches a change listener to `window.matchMedia('(prefers-reduced-motion: reduce)')` and automatically cleans up on unmount.
- **Cross-Browser**: Supports modern `addEventListener('change', ...))` as well as legacy `addListener(...)`.

---

## Component Level Guarantees

| Component | Normal Motion | Reduced Motion (`prefers-reduced-motion: reduce`) |
| :--- | :--- | :--- |
| **`Skeleton`** | `animate-pulse` | `motion-reduce:animate-none` (static solid placeholder) |
| **`Button`** | `transition duration-200` | `motion-reduce:transition-none` (instant state switch) |
| **`StatusMessage`** | Smooth reveal & shadow | `motion-reduce:transition-none motion-reduce:transform-none` |
| **Global Shell** | Smooth scroll & keyframe animations | Instant scroll (`scroll-behavior: auto !important`), zero animation duration |

---

## Global CSS Overrides (`app/globals.css`)

```css
@media (prefers-reduced-motion: reduce) {
  html {
    scroll-behavior: auto;
  }

  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }

  .animate-fade-in-up,
  .animate-float,
  .animate-pulse {
    animation: none !important;
  }
}
```

---

## Accessibility Regression Coverage

This section documents the automated accessibility regression coverage for dense forms, tables, and error recovery flows. The goal is to prevent silent regressions in keyboard navigation, focus management, screen-reader announcements, reduced-motion behavior, and error recovery.

The suite lives alongside the existing reduced-motion tests and runs in the same Vitest project:

```bash
npx vitest run core/ui/__tests__/accessibility-regression.tsx
```

The suite is written against the public component APIs and asserts on DOM attributes, focus order, and announcement regions rather than internal implementation details. This keeps the coverage compatible with existing public APIs and user-facing behavior.

### Covered Workflows

| Area | Workflow | What is asserted |
| :--- | :--- | :--- |
| Dense forms | Transaction inspection form with many inputs | Tab order follows DOM order; every control has an accessible name; required fields expose `aria-required`; invalid fields link to error messages via `aria-describedby`. |
| Dense tables | Soroban diagnostics table | Table has a caption and scoped header cells; rows are reachable by tab and keyboard scroll; focus indicator is visible and not removed by `:remove`. |
| Error recovery | Failed submit and retry flow | Errors are announced through a polite live region; focus moves to the error summary on failure and returns to the first invalid field on retry; success is announced without movement. |
| Reduced motion | All core workflows | With `prefers-reduced-motion: reduce` matched, loading placeholders are static and status transitions are instant. |

### Test Harness Notes

- **Media query mocking**: The suite installs a stubbed `window.matchMedia` that returns the desired `matches` value and dispatches change events to subscribers. This exercises both the synchronous `prefersReducedMotion` utility and the `useReducedMotion` hook without touching the real browser preference.
- **Keyboard driven**: Interactions use `user-event` keyboard sequences (Tab, Shift+Tab, Enter, Escape) so the tests exercise the same paths assistive technology users depend on.
- **Focus assertions**: Tests assert on `document.activeElement` and on the presence of a focus visual indicator class or computed style.
- **Live region assertions**: Error and success messages are checked for `aria-live="polite"` (and `aria-atomic="true"` where applicable) and for the expected text content.

### Operational Edge Cases

- **SSR and hydration**: `prefersReducedMotion` must not throw when `window` is undefined. Tests cover the default value path and confirm the hook returns the default on the first render before effects run.
- **Legacy browsers**: Media query listeners fall back to `addListener`/`removeListener` when `addEventListener` is not available. Tests exercise both branches.
- **Change listener cleanup**: Unmounting a component that uses the hook must remove the listener; tests assert the removal call and that no state updates are attempted after unmount.
- **Dynamic preference changes**: When the OS preference flips at runtime, the hook updates and components switch between animated and static rendering without a reload.
- **Dense form focus traps**: Modal and drawer workflows must retain focus within the dialog and return focus to the trigger on close. Tests assert the return-focus contract.
- **Table overflow**: Horizontally scrollable tables must remain keyboard scrollable (`tabindex="0"`) and have an accessible name via `aria-labelledby` or a caption.
- **Error recovery retry**: After a failed submit, correcting fields and retrying must clear stale error messages and announce success exactly once.

### Failure Modes

| Failure mode | Symptom | Detection |
| :--- | :--- | :--- |
| Missing accessible name on a dense form control | Screen reader announces an unlabeled input | Assertion on label/aria-label/aria-labelledby presence |
| Error not announced | User sees an error but screen reader does not | Assertion on live region text and role |
| Focus lost on recovery | Focus falls to document body after retry | Assertion on document.activeElement |
| Reduced motion ignored | Skeleton still pulses when preference is reduce | Assertion on className/computed style with media query stub |
| Table headers unscoped | Screen reader cannot associate cells with headers | Assertion on `scope` attribute of th cells |

### Rollback and Recovery Steps

If an accessibility regression is introduced by a future change:

1. **Reproduce**: Run `nx vitest run core/ui/__tests__/accessibility-regression.test.tsx` and capture the failing assertion and component name.
2. **Isolate**: Revert only the component or style change that introduced the regression. Do not revert the test suite; the suite is the regression guard.
3. **Verify**: Re-run the full suite and the reduced-motion suite (`nx vitest run core/ui/__tests__/reduced-motion.test.tsx`) to confirm both green.
4. **Document**: If the regression was detected in production, add a short note to this file under the relevant workflow row and link the fixing commit.

There is no data migration required for this change: the suite adds test coverage and documentation only, and does not alter public APIs, schemas, or user-facing behavior.

---

## Verification & Testing

Run the dedicated reduced-motion test suite:

```bash
nx vitest run core/ui/__tests__/reduced-motion.test.tsx
```

Run the accessibility regression suite added by this change:

```bash
nx vitest run core/ui/__tests/accessibility-regression.tsx
```

Run both together to confirm the full accessibility contract:

```bash
nx vitest run core/ui/__tests__/reduced-motion.test.tsx core/ui/__tests__/accessibility-regression.test.tsx
```
