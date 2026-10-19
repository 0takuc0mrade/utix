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
- **Cross-Browser**: Supports modern `addEventListener('change', ...)` as well as legacy `addListener(...)`.

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

## Verification & Testing

Run the dedicated reduced-motion test suite:

```bash
npx vitest run core/ui/__tests__/reduced-motion.test.tsx
```
