/**
 * Accessibility coverage for keyboard, focus, and async status states (#274).
 *
 * Provides utilities for:
 * - Keyboard navigation (focus trapping, roving tabindex)
 * - Focus management (restore focus after modal close)
 * - Async status announcements (ARIA live regions)
 * - Screen reader-friendly loading/error/success states
 */

import { useEffect, useState } from "react";

export type AriaLive = 'polite' | 'assertive' | 'off';

export type AsyncStatus = 'idle' | 'loading' | 'success' | 'error';

/**
 * Get the appropriate ARIA live region announcement for an async status.
 */
export function getStatusAnnouncement(
  status: AsyncStatus,
  successMessage = 'Operation completed successfully',
  errorMessage = 'Operation failed',
): string {
  switch (status) {
    case 'loading':
      return 'Loading, please wait';
    case 'success':
      return successMessage;
    case 'error':
      return errorMessage;
    default:
      return '';
  }
}

/**
 * Get the appropriate ARIA live politeness for a status.
 * Errors are assertive (interrupt), others are polite (wait for pause).
 */
export function getStatusLivePoliteness(status: AsyncStatus): AriaLive {
  return status === 'error' ? 'assertive' : 'polite';
}

/**
 * Generate ARIA attributes for an async status region.
 */
export function getStatusAriaAttributes(status: AsyncStatus): {
  'aria-live': AriaLive;
  'aria-busy': boolean;
  'aria-atomic': boolean;
  role: string;
} {
  return {
    'aria-live': getStatusLivePoliteness(status),
    'aria-busy': status === 'loading',
    'aria-atomic': true,
    role: status === 'error' ? 'alert' : 'status',
  };
}

/**
 * Focus trap: keeps keyboard focus within a container (e.g., modal).
 * Returns a cleanup function.
 */
export function trapFocus(container: HTMLElement): () => void {
  const FOCUSABLE_SELECTOR =
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key !== 'Tab') return;
    const focusable = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
    if (focusable.length === 0) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    if (e.shiftKey) {
      if (document.activeElement === first) {
        e.preventDefault();
        last.focus();
      }
    } else {
      if (document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }

  container.addEventListener('keydown', handleKeyDown);
  return () => container.removeEventListener('keydown', handleKeyDown);
}

/**
 * Restore focus to a previously focused element after a modal closes.
 * Returns a cleanup function that should be called when the modal closes.
 */
export function manageFocusReturn(previouslyFocused: HTMLElement | null): () => void {
  return () => {
    if (previouslyFocused && document.contains(previouslyFocused)) {
      previouslyFocused.focus();
    }
  };
}

/**
 * Roving tabindex: only one item in a group is tabbable at a time.
 * Arrow keys move focus between items.
 */
export function setupRovingTabindex(container: HTMLElement, itemSelector: string): () => void {
  const items = Array.from(container.querySelectorAll<HTMLElement>(itemSelector));
  if (items.length === 0) return () => {};

  // Only the first item is initially tabbable
  items.forEach((item, i) => {
    item.setAttribute('tabindex', i === 0 ? '0' : '-1');
  });

  function handleKeyDown(e: KeyboardEvent) {
    const currentIndex = items.findIndex((el) => el === document.activeElement);
    if (currentIndex === -1) return;

    let nextIndex = -1;
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        nextIndex = (currentIndex + 1) % items.length;
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        nextIndex = (currentIndex - 1 + items.length) % items.length;
        break;
      case 'Home':
        nextIndex = 0;
        break;
      case 'End':
        nextIndex = items.length - 1;
        break;
      default:
        return;
    }

    e.preventDefault();
    items[currentIndex].setAttribute('tabindex', '-1');
    items[nextIndex].setAttribute('tabindex', '0');
    items[nextIndex].focus();
  }

  container.addEventListener('keydown', handleKeyDown);
  return () => container.removeEventListener('keydown', handleKeyDown);
}

/**
 * Check if an element is visible and focusable.
 */
export function isFocusable(element: HTMLElement): boolean {
  return (
    element.offsetParent !== null &&
    !element.hasAttribute('disabled') &&
    element.getAttribute('tabindex') !== '-1'
  );
}

/**
 * Get all focusable elements in a container, in DOM order.
 */
export function getFocusableElements(container: HTMLElement): HTMLElement[] {
  const FOCUSABLE_SELECTOR =
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(isFocusable);
}

/**
 * Query whether the user has requested reduced motion (#153).
 * Returns defaultValue (false by default) if window or matchMedia is unavailable.
 */
export function prefersReducedMotion(defaultValue = false): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return defaultValue;
  }
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return defaultValue;
  }
}

/**
 * React hook to observe user reduced-motion preference changes (#153).
 * Preserves state visibility without relying on animation completion.
 */
export function useReducedMotion(defaultValue = false): boolean {
  const [reducedMotion, setReducedMotion] = useState<boolean>(() =>
    prefersReducedMotion(defaultValue)
  );

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }

    const mediaQueryList = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReducedMotion(mediaQueryList.matches);

    const listener = (event: MediaQueryListEvent | MediaQueryList) => {
      setReducedMotion(event.matches);
    };

    if (typeof mediaQueryList.addEventListener === "function") {
      mediaQueryList.addEventListener("change", listener as (e: MediaQueryListEvent) => void);
      return () =>
        mediaQueryList.removeEventListener("change", listener as (e: MediaQueryListEvent) => void);
    } else if (typeof (mediaQueryList as any).addListener === "function") {
      (mediaQueryList as any).addListener(listener);
      return () => (mediaQueryList as any).removeListener(listener);
    }
  }, []);

  return reducedMotion;
}

