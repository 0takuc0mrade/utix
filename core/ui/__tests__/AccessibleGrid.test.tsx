import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { describe, it, expect, vi } from "vitest";
import { AccessibleGrid, type AccessibleGridProps } from "@core/ui/AccessibleGrid";

interface TestRow {
  id: string;
  name: string;
  value: number;
}

const testData: TestRow[] = [
  { id: "1", name: "Item A", value: 100 },
  { id: "2", name: "Item B", value: 200 },
  { id: "3", name: "Item C", value: 300 }
];

const columns = [
  {
    key: "name",
    header: "Name",
    sortable: true,
    render: (row: TestRow) => row.name
  },
  {
    key: "value",
    header: "Value",
    sortable: true,
    render: (row: TestRow) => row.value.toString()
  }
];

const rowKey = (row: TestRow) => row.id;

// Fetch a rendered cell by grid coordinates.
function cell(row: number, col: number): HTMLTableCellElement {
  const el = document.getElementById(`grid-cell-${row}-${col}`);
  if (!el) throw new Error(`missing cell ${row}-${col}`);
  return el as HTMLTableCellElement;
}

/**
 * Focus a cell the way a pointer/keyboard user would, flushing the React
 * focus handler so the grid has recorded the roving position before a
 * subsequent key press.
 */
function focusCell(row: number, col: number): HTMLTableCellElement {
  const el = cell(row, col);
  act(() => {
    el.focus();
  });
  return el;
}

// Press a key on whichever cell currently owns focus (events bubble to the grid).
function press(key: string, init: KeyboardEventInit = {}): void {
  const target = (document.activeElement as HTMLElement | null) ?? document.body;
  fireEvent.keyDown(target, { key, ...init });
}

function renderGrid(overrides: Partial<AccessibleGridProps<TestRow>> = {}) {
  const props: AccessibleGridProps<TestRow> = {
    columns,
    rows: testData,
    rowKey,
    caption: "Test table",
    ...overrides
  };
  return render(<AccessibleGrid {...props} />);
}

describe("AccessibleGrid", () => {
  it("renders table with proper ARIA roles", () => {
    renderGrid();

    const table = screen.getByRole("grid");
    expect(table).toBeITheDocument();
    expect(table).toHaveAttribute("aria-label", "Test table");
  });

  it("renders caption with accessibility help", () => {
    renderGrid();

    const caption = screen.getByText(/arrow keys to navigate/i);
    expect(caption).toBeInTheDocument();
  });

  it("renders all rows and columns", () => {
    renderGrid();

    expect(screen.getByText("Item A")).toBeInTheDocument();
    expect(screen.getByText("Item B")).toBeInTheDocument();
    expect(screen.getByText("Item C")).toBeInTheDocument();
    expect(screen.getByText("100")).toBeInTheDocument();
    expect(screen.getByText("200")).toBeInTheDocument();
    expect(screen.getByText("300")).toBeInTheDocument();
  });

  it("announces row count in status region", () => {
    renderGrid();

    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Showing 3 of 3 rows");
  });

  it("exposes total row/column counts so virtualized windows keep a stable contract", () => {
    renderGrid();

    const table = screen.getByRole("grid");
    // Header row + 3 data rows.
    expect(table).toHaveAttribute("aria-rowcount", "4");
    expect(table).toHaveAttribute("aria-colcount", "2");
  });

  it("numbers the header row first and keeps aria-colindex monotonic", () => {
    const { container } = renderGrid();

    const rows = container.querySelectorAll('[role="row"]');
    expect(rows[0]).toHaveAttribute("aria-rowindex", "1"); // header
    expect(rows[1]).toHaveAttribute("aria-rowindex", "2"); // first data row
    expect(rows[2]).toHaveAttribute("aria-rowindex", "3"); // second data row

    expect(cell(0, 0)).toHaveAttribute("aria-colindex", "1");
    expect(cell(0, 1)).toHaveAttribute("aria-colindex", "2");
  });

  it("keeps exactly one cell in the tab order (roving tabindex)", () => {
    renderGrid();

    const tabbable = [cell(0, 0), cell(0, 1), cell(1, 0), cell(1, 1)].filter((el) => el.tabIndex === 0);
    expect(tabbable).toHaveLength(1);
    expect(tabbable[0]).toBe(cell(0, 0));

    focusCell(1, 1);
    expect(cell(1, 1)).toHaveProperty("tabIndex", 0);
    expect(cell(0, 0)).toHaveProperty("tabIndex", -1);
  });

  it("moves focus with the arrow keys and stops at the top/left boundary", () => {
    renderGrid();

    focusCell(0, 0);
    expect(cell(0, 0)).toHaveFocus();

    press("ArrowRight");
    expect(cell(0, 1)).toHaveFocus();

    press("ArrowLeft");
    expect(cell(0, 0)).toHaveFocus();

    // Already at row 0 / col 0: the boundary press must not wrap or throw.
    press("ArrowUp");
    expect(cell(0, 0)).toHaveFocus();
    press("ArrowLeft");
    expect(cell(0, 0)).toHaveFocus();

    press("ArrowDown");
    expect(cell(1, 0)).toHaveFocus();
  });

  it("stops at the bottom/right boundary", () => {
    renderGrid();

    focusCell(2, 1);
    press("ArrowDown");
    expect(cell(2, 1)).toHaveFocus();
    press("ArrowRight");
    expect(cell(2, 1)).toHaveFocus();
    press("ArrowUp");
    expect(cell(1, 1)).toHaveFocus();
    press("ArrowLeft");
    expect(cell(1, 0)).toHaveFocus();
  });

  it("uses Home/End within a row and Ctrl+Home/Ctrl+End for the grid corners", () => {
    renderGrid();

    focusCell(1, 1);
    press("Home");
    expect(cell(1, 0)).toHaveFocus();

    press("End");
    expect(cell(1, 1)).toHaveFocus();

    press("Home", { ctrlKey: true });
    expect(cell(0, 0)).toHaveFocus();

    press("End", { ctrlKey: true });
    expect(cell(2, 1)).toHaveFocus();
  });

  it("preserves focus on the same row when the data is reordered", () => {
    const { rerender } = renderGrid();

    // Row "1" is the focused row; give it a distinctive column value to track.
    focusCell(0, 1);
    expect(cell(0, 1)).toHaveTextContent("100");

    const reordered = [testData[2], testData[1], testData[0]]; // ids 3, 2, 1
    rerender(
      <AccessibleGrid columns={columns} rows={reordered} rowKey={rowKey} caption="Test table" />
    );

    // Row "1" moved from index 0 to index 2; focus moved with it.
    expect(cell(2, 1)).toHaveFocus();
    expect(cell(2, 1)).toHaveTextContent("100");
  });

  it("clamps focus to a live row when the focused row is removed", () => {
    const { rerender } = renderGrid();

    focusCell(1, 0); // row id "2"

    rerender(<AccessibleGrid columns={columns} rows={[testData[0]]} rowKey={rowKey} caption="Test table" />);

    // Row id "2" is gone; focus lands on an existing cell instead of <body>.
    expect(cell(0, 0)).toHaveFocus();
    expect(document.activeElement).not.toBe(document.body);
  });

  it("does not steal focus from a column header when rows re-render with the same order", () => {
    const onSort = vi.fn();
    const { rerender } = renderGrid({ onSort });

    focusCell(0, 0);
    const header = screen.getByRole("columnheader", { name: "Name" });
    act(() => {
      header.focus();
    });
    expect(header).toHaveFocus();

    // Same order, brand new array instance: a data refresh must leave the
    // keyboard user on the header they are sorting from.
    rerender(
      <AccessibleGrid
        columns={columns}
        rows={testData.map((row) => ({ ...row }))}
        rowKey={rowKey}
        caption="Test table"
        onSort={onSort}
      />
    );

    expect(header).toHaveFocus();
  });

  it("recycles DOM nodes without emitting duplicate cell ids", () => {
    const { rerender, container } = renderGrid();

    const idsOf = () =>
      Array.from(container.querySelectorAll<HTMLElement>('[id^="grid-cell-"]')).map((el) => el.id);

    const first = idsOf();
    expect(new Set(first).size).toBe(first.length);

    rerender(
      <AccessibleGrid
        columns={columns}
        rows={[testData[2], testData[0], testData[1]]}
        rowKey={rowKey}
        caption="Test table"
      />
    );

    const second = idsOf();
    expect(new Set(second).size).toBe(second.length);
    expect(second).toHaveLength(first.length);
  });

  it("triggers sorting from the keyboard for a sortable cell", () => {
    const onSort = vi.fn();
    const { rerender } = renderGrid({ onSort });

    focusCell(0, 0);
    press("Enter");
    expect(onSort).toHaveBeenCalledWith("name", true);

    // The parent applies the sort and re-renders with the new sort state.
    rerender(
      <AccessibleGrid
        columns={columns}
        rows={testData}
        rowKey={rowKey}
        caption="Test table"
        onSort={onSort}
        sortBy="name"
        sortAscending
      />
    );
    act(() => {
      cell(0, 0).focus();
    });

    onSort.mockClear();
    press(" ");
    // Same column, currently ascending: the next press toggles the direction.
    expect(onSort).toHaveBeenCalledWith("name", false);
  });

  it("calls onSort callback when header is clicked", async () => {
    const onSort = vi.fn();
    const user = userEvent.setup();

    renderGrid({ onSort });

    const nameHeader = screen.getByText("Name");
    await user.click(nameHeader);

    expect(onSort).toHaveBeenCalledWith("name", true);
  });

  it("toggles sort direction on repeated header clicks", async () => {
    const onSort = vi.fn();
    const user = userEvent.setup();

    const { rerender } = renderGrid({ onSort, sortBy: "name", sortAscending: true });

    const nameHeader = screen.getByText("Name");
    await user.click(nameHeader);

    expect(onSort).toHaveBeenCalledWith("name", false);

    rerender(
      <AccessibleGrid
        columns={columns}
        rows={testData}
        rowKey={rowKey}
        caption="Test table"
        onSort={onSort}
        sortBy="name"
        sortAscending={false}
      />
    );

    await user.click(nameHeader);
    expect(onSort).toHaveBeenCalledWith("name", true);
  });

  it("sets aria-sort on sorted column header", () => {
    renderGrid({ sortBy: "name", sortAscending: true });

    const nameHeader = screen.getByRole("columnheader", { name: "Name" });
    expect(nameHeader).toHaveAttribute("aria-sort", "ascending");

    const valueHeader = screen.getByRole("columnheader", { name: "Value" });
    expect(valueHeader).toHaveAttribute("aria-sort", "none");
  });

  it("renders empty rows list correctly", () => {
    renderGrid({ rows: [] });

    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Showing 0 of 0 rows");
    expect(screen.getByRole("grid")).toHaveAttribute("aria-rowcount", "1");
  });

  it("applies custom className", () => {
    const { container } = renderGrid({ className: "custom-class" });

    const wrapper = container.querySelector(".custom-class");
    expect(wrapper).toBeInTheDocument();
  });

  it("has no serious or critical axe violations", async () => {
    const { container } = renderGrid();

    const results = await axe.run(container, {
      rules: {
        // jsdom has no layout engine, so contrast cannot be computed.
        "color-contrast": { enabled: false }
      }
    });

    const blocking = results.violations.filter(
      (violation) => violation.impact === "critical" || violation.impact === "serious"
    );
    expect(blocking).toEqual([]);
    expect(results.passes.length).toBeGreaterThan(0);
  });

  describe("accessibility regression coverage", () => {
    it("keeps the grid reachable and operable by keyboard alone", async () => {
      const user = userEvent.setup();
      renderGrid();

      // Tab into the grid lands on the single roving-tabindex cell.
      await user.tab();
      expect(cell(0, 0)).toHaveFocus();

      // Arrow navigation remains functional after tabbing in.
      await user.keyboard("{ArrowRight}");
      expect(cell(0, 1)).toHaveFocus();
      await user.keyboard("{ArrowDown}");
      expect(cell(1, 1)).toHaveFocus();
    });

    it("exposes a visible focus indicator contract via focusable cells", () => {
      renderGrid();

      // Every cell must be programmatically focusable so focus styling can
      // be applied by the consumer without changing the grid's public API.
      for (let row = 0; row < 3; row++) {
        for (let col = 0; col < 2; col++) {
          const el = cell(row, col);
          expect(el.tabIndex).toBeGreaterThanOrEqual(-1);
          act(() => {
            el.focus();
          });
          expect(el).toHaveFocus();
        }
      }
    });

    it("retains the roving tabindex after an empty to populated transition", () => {
      const { rerender } = renderGrid({ rows: [] });

      rerender(
        <AccessibleGrid columns={columns} rows={testData} rowKey={rowKey} caption="Test table" />
      );

      const tabbable = [cell(0, 0), cell(0, 1), cell(1, 0), cell(1, 1)].filter(
        (el) => el.tabIndex === 0
      );
      expect(tabbable).tlHaveLength(1);
    });
  });
});
