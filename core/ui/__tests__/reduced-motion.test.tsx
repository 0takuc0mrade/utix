import { render, renderHook, screen, act } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { prefersReducedMotion, useReducedMotion } from "../accessibility";
import { Skeleton } from "../Skeleton";
import { Button } from "../Button";
import { StatusMessage } from "../StatusMessage";

describe("Reduced-Motion Preference Coverage (#153)", () => {
  let originalMatchMedia: typeof window.matchMedia;

  beforeEach(() => {
    originalMatchMedia = window.matchMedia;
  });

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
  });

  function mockMatchMedia(matches: boolean) {
    const listeners = new Set<(e: { matches: boolean }) => void>();
    const mql = {
      matches,
      media: "(prefers-reduced-motion: reduce)",
      onchange: null,
      addEventListener: vi.fn((event: string, handler: (e: { matches: boolean }) => void) => {
        if (event === "change") listeners.add(handler);
      }),
      removeEventListener: vi.fn((event: string, handler: (e: { matches: boolean }) => void) => {
        if (event === "change") listeners.delete(handler);
      }),
      addListener: vi.fn((handler: (e: { matches: boolean }) => void) => {
        listeners.add(handler);
      }),
      removeListener: vi.fn((handler: (e: { matches: boolean }) => void) => {
        listeners.delete(handler);
      }),
      dispatchEvent: vi.fn(),
      triggerChange: (nextMatches: boolean) => {
        mql.matches = nextMatches;
        listeners.forEach((listener) => listener({ matches: nextMatches }));
      }
    };

    window.matchMedia = vi.fn().mockReturnValue(mql);
    return mql;
  }

  describe("prefersReducedMotion() helper", () => {
    it("returns false by default when media query matches is false", () => {
      mockMatchMedia(false);
      expect(prefersReducedMotion()).toBe(false);
    });

    it("returns true when media query matches is true", () => {
      mockMatchMedia(true);
      expect(prefersReducedMotion()).toBe(true);
    });

    it("falls back to defaultValue when matchMedia throws or is missing", () => {
      // @ts-expect-error Intentionally invalid matchMedia for test
      delete window.matchMedia;
      expect(prefersReducedMotion(false)).toBe(false);
      expect(prefersReducedMotion(true)).toBe(true);
    });
  });

  describe("useReducedMotion() hook", () => {
    it("returns initial reduced-motion state correctly", () => {
      mockMatchMedia(true);
      const { result } = renderHook(() => useReducedMotion());
      expect(result.current).toBe(true);
    });

    it("updates dynamically when media query changes", () => {
      const mql = mockMatchMedia(false);
      const { result } = renderHook(() => useReducedMotion());
      expect(result.current).toBe(false);

      act(() => {
        mql.triggerChange(true);
      });

      expect(result.current).toBe(true);
    });

    it("cleans up listener on unmount", () => {
      const mql = mockMatchMedia(false);
      const { unmount } = renderHook(() => useReducedMotion());
      unmount();
      expect(mql.removeEventListener).toHaveBeenCalledWith("change", expect.any(Function));
    });
  });

  describe("Component reduced-motion class assertions", () => {
    it("Skeleton includes motion-reduce:animate-none while retaining data-contract-state", () => {
      const { container } = render(<Skeleton className="custom-test" />);
      const skeleton = container.querySelector<HTMLElement>('[data-contract-state="loading"]');
      expect(skeleton).not.toBeNull();
      expect(skeleton).toHaveAttribute("data-contract-state", "loading");
      expect(skeleton?.className).toContain("motion-reduce:animate-none");
      expect(skeleton?.className).toContain("animate-pulse");
    });

    it("Button includes motion-reduce:transition-none", () => {
      render(<Button>Submit</Button>);
      const button = screen.getByRole("button", { name: "Submit" });
      expect(button.className).toContain("motion-reduce:transition-none");
    });

    it("StatusMessage includes motion-reduce:transition-none and motion-reduce:transform-none", () => {
      render(<StatusMessage type="info" title="Operation in progress" />);
      const status = screen.getByRole("status");
      expect(status.className).toContain("motion-reduce:transition-none");
      expect(status.className).toContain("motion-reduce:transform-none");
    });
  });
});
