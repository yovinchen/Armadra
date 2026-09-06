import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const openFileInEditor = vi.fn();
vi.mock("@/files/open-editor", () => ({
  openFileInEditor: (...args: unknown[]) => openFileInEditor(...args),
}));

const setPanel = vi.fn();
vi.mock("@/store/canvas-store", () => ({
  useCanvasStore: (selector: (state: unknown) => unknown) =>
    selector({ panels: { problems: "drawer" }, setPanel }),
}));

import { usePreferencesStore } from "@/app/preferences-store";
import { useDiagnosticsStore } from "@/editor/language/diagnostics-store";
import { ProblemsPanel } from "./ProblemsPanel";

beforeEach(() => {
  usePreferencesStore.setState({ locale: "en" });
  useDiagnosticsStore.setState({ byUri: {} });
  openFileInEditor.mockReset();
  setPanel.mockReset();
});
afterEach(cleanup);

describe("problems panel", () => {
  it("says so plainly when there is nothing to report", () => {
    render(<ProblemsPanel />);
    expect(screen.getByText("No diagnostics")).toBeTruthy();
    expect(screen.getByText("0 errors · 0 warnings")).toBeTruthy();
  });

  it("groups by file and opens the line a diagnostic points at", () => {
    useDiagnosticsStore.setState({
      byUri: {
        "armadra:///src/main.py": [
          {
            range: {
              start: { line: 0, character: 7 },
              end: { line: 0, character: 9 },
            },
            severity: 2,
            code: "F401",
            source: "ruff",
            message: "`os` imported but unused",
          },
        ],
      },
    });
    render(<ProblemsPanel />);

    expect(screen.getByText("src/main.py")).toBeTruthy();
    expect(screen.getByText("`os` imported but unused")).toBeTruthy();
    expect(screen.getByText("0 errors · 1 warnings")).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: /imported but unused/ }),
    );
    // LSP 的行号从 0 起，编辑器从 1 起。
    expect(openFileInEditor).toHaveBeenCalledWith("src/main.py", { line: 1 });
  });

  it("shows a location outside the workspace but does not offer to open it", () => {
    useDiagnosticsStore.setState({
      byUri: {
        "armadra-external:///0f0f": [
          {
            range: {
              start: { line: 3, character: 0 },
              end: { line: 3, character: 1 },
            },
            message: "from a dependency",
          },
        ],
      },
    });
    render(<ProblemsPanel />);
    const row = screen.getByRole("button", { name: /from a dependency/ });
    expect(row.hasAttribute("disabled")).toBe(true);
    fireEvent.click(row);
    expect(openFileInEditor).not.toHaveBeenCalled();
  });
});
