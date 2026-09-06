import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";
import type { AgentGlow } from "@/agent/status-store";

import { installDomPolyfills } from "@/app/test-harness";
import { useMinimapPreferences } from "@/app/minimap-preferences";
import { toItemId } from "@/canvas/whiteboard/model";
import {
  MINIMAP_COLORS,
  Minimap,
  minimapFill,
  minimapItemOf,
  minimapStroke,
  minimapStrokeWidth,
} from "./Minimap";

/**
 * 状态缩略图（React Flow 计划 F20）。
 *
 * 旧引擎的 `overlays/minimap.test.ts` 有 13 项，其中 9 项是几何与指针换算
 * （`fitPageBounds` / `minimapPointToPage` / `itemAtPoint` …）——那些现在
 * 由 React Flow 的 `<MiniMap>` 负责，我们只剩颜色。另加
 * `CanvasNavigationPanel.test.tsx` 那一项收起开关。
 */

beforeAll(installDomPolyfills);
beforeEach(() => useMinimapPreferences.getState().setCollapsed(false));
afterEach(cleanup);

function flowNode(
  id: string,
  type: "armadra" | "group" | "wb.text",
  selected = false,
) {
  return { id, type, selected } as const;
}

const noGlow = () => undefined;
const glowOf = (glow: AgentGlow) => () => glow;

describe("状态描边", () => {
  it("三种光晕各自映射到自己的 token", () => {
    expect(minimapStroke({ glow: "working" })).toBe(MINIMAP_COLORS.working);
    expect(minimapStroke({ glow: "attention" })).toBe(MINIMAP_COLORS.attention);
    expect(minimapStroke({ glow: "unread" })).toBe(MINIMAP_COLORS.unread);
  });

  it("没有状态的节点、分组与白板对象一律中性描边", () => {
    expect(minimapStroke({})).toBe(MINIMAP_COLORS.plain);
    expect(minimapStroke({ plain: true, glow: "working" })).toBe(
      MINIMAP_COLORS.plain,
    );
  });

  it("有状态的画粗一点：缩略图上 1px 的色差不够", () => {
    expect(minimapStrokeWidth(MINIMAP_COLORS.working)).toBe(4);
    expect(minimapStrokeWidth(MINIMAP_COLORS.plain)).toBe(2);
  });

  it("选中的节点填得实一点，白板对象最淡", () => {
    expect(minimapFill({ selected: true })).toContain("55%");
    expect(minimapFill({})).toContain("28%");
    expect(minimapFill({ plain: true })).toContain("35%");
  });
});

describe("节点 → 上色输入", () => {
  it("只有 `armadra` 节点参与状态描边", () => {
    expect(minimapItemOf(flowNode("n1", "armadra"), glowOf("working"))).toEqual(
      { plain: false, selected: false, glow: "working" },
    );
  });

  it("分组与白板对象一律 plain，不查状态表", () => {
    expect(minimapItemOf(flowNode("g1", "group"), glowOf("working"))).toEqual({
      plain: true,
      selected: false,
    });
    expect(
      minimapItemOf(flowNode(toItemId("i1"), "wb.text"), glowOf("working")),
    ).toEqual({ plain: true, selected: false });
  });

  it("选中态原样带过去", () => {
    expect(
      minimapItemOf(flowNode("n1", "armadra", true), noGlow).selected,
    ).toBe(true);
  });
});

describe("收起开关", () => {
  const renderPanel = () =>
    render(
      <ReactFlowProvider>
        <Minimap />
      </ReactFlowProvider>,
    );

  it("展开时画缩略图，点一下收起后只剩按钮", () => {
    renderPanel();
    expect(screen.getByTestId("rf__minimap")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "收起缩略图" }));
    expect(screen.queryByTestId("rf__minimap")).toBeNull();
    expect(screen.getByRole("button", { name: "展开缩略图" })).toBeTruthy();
  });

  it("收起状态记在 `minimap-preferences` 里，重挂之后还在", () => {
    useMinimapPreferences.getState().setCollapsed(true);
    renderPanel();
    expect(screen.queryByTestId("rf__minimap")).toBeNull();
    expect(
      screen
        .getByRole("button", { name: "展开缩略图" })
        .getAttribute("aria-expanded"),
    ).toBe("false");
  });
});
