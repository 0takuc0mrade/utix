import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDynamicRevealFocus } from "@/core/hooks/useDynamicRevealFocus";

function TestComponent() {
  const [showFields, setShowFields] = useState(false);
  const [unrelatedCount, setUnrelatedCount] = useState(0);
  const { targetRef, triggerRef, triggerReveal, triggerDismiss } =
    useDynamicRevealFocus<HTMLInputElement, HTMLSelectElement>();

  return (
    <div>
      <label htmlFor="selector">Choose option</label>
      <select
        id="selector"
        ref={triggerRef}
        value={showFields ? "revealed" : "hidden"}
        onChange={(e) => {
          if (e.target.value === "revealed") {
            setShowFields(true);
            triggerReveal();
          } else {
            setShowFields(false);
            triggerDismiss();
          }
        }}
      >
        <option value="hidden">Hidden</option>
        <option value="revealed">Revealed</option>
      </select>

      <label htmlFor="other-input">Other Input</label>
      <input id="other-input" data-testid="other-input" />

      <button
        type="button"
        onClick={() => setUnrelatedCount((c) => c + 1)}
        data-testid="re-render-btn"
      >
        Re-render {unrelatedCount}
      </button>

      {showFields ? (
        <fieldset aria-label="Dynamic section">
          <legend>Dynamic section</legend>
          <label htmlFor="revealed-input">Revealed field</label>
          <input id="revealed-input" ref={targetRef} data-testid="revealed-input" />
        </fieldset>
      ) : null}
    </div>
  );
}

function renderWithReducedMotion() {
  const originalMatchMedia = window.matchMedia;
  window.matchMedia = vi.fn((query: string) => ({
    matches: query.includes("prefers-reduced-motion"),
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
  return () => {
    window.matchMedia = originalMatchMedia;
  };
}

describe("useDynamicRevealFocus", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("does not steal focus on initial render", () => {
    render(<TestComponent />);
    expect(document.activeElement).toBe(document.body);
  });

  it("moves focus to the revealed input on explicit user trigger", () => {
    render(<TestComponent />);
    const select = screen.getByLabelText("Choose option");

    fireEvent.change(select, { target: { value: "revealed" } });

    const revealedInput = screen.getByTestId("revealed-input");
    expect(document.activeElement).toBe(revealedInput);
  });

  it("does not steal focus during unrelated re-renders", () => {
    render(<TestComponent />);
    const select = screen.getByLabelText("Choose option");

    fireEvent.change(select, { target: { value: "revealed" } });
    expect(document.activeElement).toBe(screen.getByTestId("revealed-input"));

    // User moves focus to another input
    const otherInput = screen.getByTestId("other-input");
    otherInput.focus();
    expect(document.activeElement).toBe(otherInput);

    // Unrelated background update / re-render occurs
    fireEvent.click(screen.getByTestId("re-render-btn"));
    // Focus MUST continue to remain on otherInput!
    expect(document.activeElement).toBe(otherInput);
  });

  it("returns focus to trigger control when dynamic content is dismissed", () => {
    render(<TestComponent />);
    const select = screen.getByLabelText("Choose option");

    // Reveal
    fireEvent.change(select, { target: { value: "revealed" } });
    expect(document.activeElement).toBe(screen.getByTestId("revealed-input"));

    // Dismiss
    fireEvent.change(select, { target: { value: "hidden" } });
    expect(document.activeElement).toBe(select);
  });

  it("keeps the revealed control keyboard-reachable and labelled", () => {
    render(<TestComponent />);
    const select = screen.getByLabelText("Choose option");

    fireEvent.change(select, { target: { value: "revealed" } });

    const revealedInput = screen.getByLabelText("Revealed field");
    expect(revealedInput).toBe(screen.getByTestId("revealed-input"));
    expect(revealedInput).toHaveAttribute("id", "revealed-input");
    expect(revealedInput.tabIndex).not.toBe(-1);
  });

  it("announces the revealed region to screen readers via its accessible name", () => {
    render(<TestComponent />);
    const select = screen.getByLabelText("Choose option");

    fireEvent.change(select, { target: { value: "revealed" } });

    const group = screen.getByRole("group", { name: "Dynamic section" });
    expect(group).toBeTruthy();
    expect(screen.getByText("Dynamic section")).toBeTruthy();
  });

  it("restores focus to trigger when target is unmounted during dismiss", () => {
    render(<TestComponent />);
    const select = screen.getByLabelText("Choose option");

    fireEvent.change(select, { target: { value: "revealed" } });
    expect(document.activeElement).toBe(screen.getByTestId("revealed-input"));

    // Dismiss removes the target from the DOM before focus restoration.
    fireEvent.change(select, { target: { value: "hidden" } });

    expect(screen.queryByTestId("revealed-input")).toBeNull();
    expect(document.activeElement).toBe(select);
  });

  it("does not throw when reveal is triggered before the target is mounted", () => {
    expect(() => {
      render(<TestComponent />);
      const select = screen.getByLabelText("Choose option");
      fireEvent.change(select, { target: { value: "revealed" } });
    }).not.toThrow();
  });

  it("respects prefers-reduced-motion by focusing immediately without animation dependency", () => {
    const restore = renderWithReducedMotion();
    try {
      render(<TestComponent />);
      const select = screen.getByLabelText("Choose option");

      fireEvent.change(select, { target: { value: "revealed" } });

      // Focus must be synchronous regardless of motion preference.
      expect(document.activeElement).toBe(screen.getByTestId("revealed-input"));
    } finally {
      restore();
    }
  });
});
