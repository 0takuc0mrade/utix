import { render, screen } from "@testing-library/react";
import { createRef, type ComponentProps } from "react";
import { describe, expect, it } from "vitest";
import { expectNoAxeViolations } from "@/core/testing/axe";
import { StatusMessage, type StatusType } from "@/core/ui/StatusMessage";

/**
 * `StatusMessage` is the single live-region primitive every feature slice
 * announces outcomes through, so its ARIA contract is a shared dependency
 * rather than a local detail: the wrong role either interrupts a screen-reader
 * user on every success, or swallows a validation error.
 *
 * The contract under test:
 *   - `error` is assertive (`role="alert"`), everything else is polite
 *     (`role="status"`), so a stream of successes never interrupts
 *   - `data-contract-state` mirrors the status type for the shared harness
 *   - title is always rendered; description and action are optional
 *   - the decorative icon is hidden from assistive technology
 *   - focusability is opt-in via `tabIndex`, never imposed
 *   - unknown props are forwarded rather than swallowed
 */
const STATUS_TYPES: readonly StatusType[] = ["success", "error", "warning", "info"];

function renderStatus(props: Partial<ComponentProps<typeof StatusMessage>> = {}) {
  return render(<StatusMessage type="success" title="Saved" {...props} />);
}

describe("StatusMessage live-region contract", () => {
  it("announces an error assertively, as an alert", () => {
    renderStatus({ type: "error", title: "Transfer failed" });

    const region = screen.getByRole("alert");
    expect(region).toHaveAttribute("aria-live", "assertive");
    expect(region).toHaveTextContent("Transfer failed");
  });

  it.each(STATUS_TYPES.filter((type) => type !== "error"))(
    "announces %s politely, as a status region",
    (type) => {
      renderStatus({ type });

      const region = screen.getByRole("status");
      expect(region).toHaveAttribute("aria-live", "polite");
      // A success must never be an alert: that is what interrupts a user.
      expect(screen.queryByRole("alert")).toBeNull();
    }
  );

  it("mirrors the status type onto data-contract-state for the shared harness", () => {
    for (const type of STATUS_TYPES) {
      const { unmount } = renderStatus({ type });
      expect(screen.getByRole(type === "error" ? "alert" : "status")).toHaveAttribute(
        "data-contract-state",
        type
      );
      unmount();
    }
  });

  it("hides the decorative icon from assistive technology", () => {
    const { container } = renderStatus();

    const icon = container.querySelector("svg");
    expect(icon).not.toBeNull();
    // The type is already carried by the live region; an unlabelled icon would
    // be announced a second time.
    expect(icon).toHaveAttribute("aria-hidden", "true");
    expect(screen.queryByRole("img")).toBeNull();
  });
});

describe("StatusMessage optional content", () => {
  it("renders the title alone when no description or action is supplied", () => {
    const { container } = renderStatus({ title: "Nothing to do" });

    expect(screen.getByText("Nothing to do")).toBeInTheDocument();
    // No empty wrappers left behind for absent slots.
    expect(container.querySelectorAll("p")).toHaveLength(1);
  });

  it("renders a description when supplied", () => {
    renderStatus({ description: "Deposit confirmed in 2 blocks." });

    expect(screen.getByText("Deposit confirmed in 2 blocks.")).toBeInTheDocument();
  });

  it("renders an interactive action when supplied", () => {
    renderStatus({ action: <button type="button">Retry</button> });

    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("renders a non-interactive action node without demanding a control", () => {
    renderStatus({ action: <span>Waiting for confirmation</span> });

    expect(screen.getByText("Waiting for confirmation")).toBeInTheDocument();
  });
});

describe("StatusMessage focusability", () => {
  it("is focusable when the consumer asks for it", () => {
    renderStatus({ tabIndex: -1, title: "Focusable" });

    const region = screen.getBylRole("status");
    expect(region).toHaveAttribute("tabindex", "-1");

    region.focus();
    expect(document.activeElement).toBe(region);
  });

  it("is not in the tab order by default", () => {
    renderStatus();

    const region = screen.getByRole("status");
    // Announcing a status must not add a tab stop; a caller that needs one
    // passes tabIndex explicitly.
    expect(region).not.toHaveAttribute("tabindex");
  });

  it("forwards the ref to the live region", () => {
    const ref = createRef<HTMLDivElement>();
    renderStatus({ ref, type: "warning", title: "Heads up" });

    expect(ref.current).not.toBeNull();
    expect(ref.current).toBe(screen.getByRole("status"));
    expect(ref.current).toHaveAttribute("data-contract-state", "warning");
  });
});

describe("StatusMessage prop forwarding", () => {
  it("forwards unknown props and merges className", () => {
    renderStatus({
      id: "deposit-status",
      "data-testid": "status-message",
      className: "mt-2"
    });

    const region = screen.getByTestId("status-message");
    expect(region).toHaveAttribute("id", "deposit-status");
    // The consumer's class must not replace the component's own styling.
    expect(region.className).toContain("mt-2");
    expect(region.className).toContain("rounded-lg");
  });
});

describe("StatusMessage accessibility", () => {
  it.each(STATUS_TYPES)("has no WCAG D/AA violations for %s", async (type) => {
    const { container } = renderStatus({
      type,
      action: <button type="button">Retry</button>
    });

    await expectNoAxeViolations(container);
  });

  it("has no violations when it is focusable and carries an action", async () => {
    const { container } = renderStatus({
      tabIndex: 0,
      type: "error",
      action: <button type="button">Retry</button>
    });

    await expectNoAxeViolations(container);
  });
});
