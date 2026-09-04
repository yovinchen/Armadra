import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { CanvasNode } from "@armadra/shared";

const store = vi.hoisted(() => ({
  updateNodeData: vi.fn(),
}));

vi.mock("@/store/canvas-store", () => {
  const useCanvasStore = <T,>(selector: (state: typeof store) => T) =>
    selector(store);
  useCanvasStore.getState = () => store;
  return { useCanvasStore };
});

import { StickyNode } from "./StickyNode";

const node = {
  id: "n1",
  boardId: "b1",
  type: "sticky",
  title: "便签",
  color: "#ffd60a",
  position: { x: 0, y: 0 },
  data: { kind: "sticky", content: "# 标题\n\n- [x] 完成" },
  createdAt: "2026-09-04T00:00:00.000Z",
  updatedAt: "2026-09-04T00:00:00.000Z",
} as CanvasNode;

function renderSticky() {
  return render(
    <StickyNode
      id="n1"
      node={node}
      selected={false}
      collapsed={false}
      focused={false}
    />,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("StickyNode", () => {
  it("does not tint the surface with a historical node colour", () => {
    const { container } = renderSticky();
    const surface = container.querySelector(
      '[data-slot="sticky-node"]',
    ) as HTMLElement;
    expect(surface.style.background).toBe("");
    expect(surface.style.boxShadow).toBe("");
    expect(surface.className).toContain("bg-[var(--card)]");
  });

  it("renders the content as Markdown when idle", () => {
    const { container } = renderSticky();
    expect(container.querySelector("h1")?.textContent).toBe("标题");
    expect(container.querySelector("input[type=checkbox]")).not.toBeNull();
    expect(container.querySelector("textarea")).toBeNull();
  });

  it("switches to a textarea on click and commits on blur", () => {
    renderSticky();
    fireEvent.click(screen.getByRole("button", { name: "便签" }));
    const textarea = screen.getByLabelText("便签") as HTMLTextAreaElement;
    expect(textarea.value).toBe("# 标题\n\n- [x] 完成");

    fireEvent.change(textarea, { target: { value: "改过了" } });
    fireEvent.blur(textarea);
    expect(store.updateNodeData).toHaveBeenCalledWith("n1", {
      content: "改过了",
    });
  });

  it("drops the draft on Escape", () => {
    renderSticky();
    fireEvent.click(screen.getByRole("button", { name: "便签" }));
    const textarea = screen.getByLabelText("便签");
    fireEvent.change(textarea, { target: { value: "不要保存" } });
    fireEvent.keyDown(textarea, { key: "Escape" });
    expect(store.updateNodeData).not.toHaveBeenCalled();
  });

  it("shows a relative timestamp instead of a character count", () => {
    const { container } = renderSticky();
    expect(container.textContent).not.toMatch(/字|characters/);
    expect(container.textContent).toMatch(/月|年|天|小时|分钟|刚刚/);
  });
});
