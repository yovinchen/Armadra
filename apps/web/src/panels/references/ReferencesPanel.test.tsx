import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { installDomPolyfills } from "@/app/test-harness";
import { useReferencesStore } from "@/editor/language/references-store";
import { useCanvasStore } from "@/store/canvas-store";
import { ReferencesPanel } from "./ReferencesPanel";

installDomPolyfills();

const openFileInEditor = vi.fn();
vi.mock("@/files/open-editor", () => ({
  openFileInEditor: (...args: unknown[]) => openFileInEditor(...args),
}));

afterEach(() => cleanup());

beforeEach(() => {
  openFileInEditor.mockReset();
  useReferencesStore.getState().clear();
  useCanvasStore.getState().setPanel("references", "drawer");
});

function showResults() {
  useReferencesStore.getState().begin("openSession");
  useReferencesStore.getState().show(
    [
      {
        uri: "armadra:///src/a.ts",
        path: "src/a.ts",
        locations: [
          { line: 4, character: 2, preview: "openSession(id)" },
          { line: 40, character: 0 },
        ],
      },
      {
        uri: "armadra:///src/b.ts",
        path: "src/b.ts",
        locations: [{ line: 0, character: 0, preview: "import { open }" }],
      },
    ],
    2,
  );
}

describe("ReferencesPanel", () => {
  it("groups by file and opens the line that was clicked", () => {
    showResults();
    render(<ReferencesPanel />);
    expect(screen.getByText("src/a.ts")).toBeTruthy();
    expect(screen.getByText("src/b.ts")).toBeTruthy();
    // LSP 的行号从 0 起，编辑器的定位接口从 1 起。
    fireEvent.click(screen.getByLabelText("打开 src/a.ts 第 5 行"));
    expect(openFileInEditor).toHaveBeenCalledWith("src/a.ts", { line: 5 });
  });

  it("collapses one file without losing the others", () => {
    showResults();
    render(<ReferencesPanel />);
    const header = screen
      .getByText("src/a.ts")
      .closest("button") as HTMLButtonElement;
    expect(header.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(header);
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByLabelText("打开 src/a.ts 第 5 行")).toBeNull();
    expect(screen.getByLabelText("打开 src/b.ts 第 1 行")).toBeTruthy();
  });

  // 工作区之外的引用打不开。省略它们会让计数对不上，所以说出来。
  it("reports the references it cannot open", () => {
    showResults();
    render(<ReferencesPanel />);
    expect(screen.getByText("另有 2 处在工作区之外，不能打开")).toBeTruthy();
  });

  it("closes from its own header", () => {
    showResults();
    render(<ReferencesPanel />);
    fireEvent.click(screen.getByLabelText("关闭"));
    expect(useCanvasStore.getState().panels.references).toBe("closed");
  });

  it("says the search failed rather than showing an empty list", () => {
    useReferencesStore.getState().begin("x");
    useReferencesStore.getState().fail("no server");
    render(<ReferencesPanel />);
    expect(screen.getByText("查找引用失败")).toBeTruthy();
  });
});
