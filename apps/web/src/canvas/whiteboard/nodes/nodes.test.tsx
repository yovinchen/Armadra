import { describe, expect, it, vi } from "vitest";
import { fireEvent } from "@testing-library/react";
import type { NodeProps } from "@xyflow/react";

/**
 * 五种白板节点的渲染（React Flow 计划 §2.2 / F22–F26）。
 *
 * 盯三件事：形状真的画出来了（`d` 不是空的）、编辑区带着 `nodrag`
 * （否则在里面选词会把对象拖走）、图片走的是现算的资产地址而不是文档里
 * 存下来的 URL。
 */

const storeState = {
  workspace: { id: "w1" },
  whiteboard: { engine: "armadra-flow", version: 2, items: [], references: [] },
  selectedItemIds: [] as string[],
  setWhiteboard: vi.fn(),
  setSelection: vi.fn(),
};

vi.mock("@/store/canvas-store", () => ({
  useCanvasStore: Object.assign(
    (selector: (state: unknown) => unknown) => selector(storeState),
    { getState: () => storeState },
  ),
  beginCoalesce: vi.fn(),
  endCoalesce: vi.fn(),
}));

vi.mock("../scheme", () => ({ useCanvasScheme: () => "light" }));

vi.mock("../../assets", () => ({
  assetUrlFor: (workspaceId: string | null, path: string) =>
    workspaceId ? `http://runtime/${workspaceId}/${path}` : null,
}));

const { makeItem, renderFlow } = await import("../../test-support");
const { default: InkNode } = await import("./InkNode");
const { default: ShapeNode } = await import("./ShapeNode");
const { default: TextNode } = await import("./TextNode");
const { default: ImageNode } = await import("./ImageNode");
const { default: LineNode } = await import("./LineNode");

type AnyNodeProps = NodeProps<never>;

function props(data: unknown, selected = false): AnyNodeProps {
  return {
    id: "wb:item-1",
    data,
    selected,
    type: "wb.shape",
    dragging: false,
    zIndex: 1,
    isConnectable: true,
    positionAbsoluteX: 0,
    positionAbsoluteY: 0,
    deletable: true,
    draggable: true,
    selectable: true,
  } as unknown as AnyNodeProps;
}

describe("InkNode", () => {
  it("点集画成闭合的填充路径", () => {
    const item = makeItem("ink", {
      w: 100,
      h: 50,
      points: [
        [0, 0, 0.5],
        [100, 50, 0.6],
      ],
    });
    const { container } = renderFlow(<InkNode {...props(item)} />);
    const path = container.querySelector("path");
    expect(path?.getAttribute("d")).toMatch(/Z$/u);
    expect(path?.getAttribute("fill")).toBe("#1d1d1d");
  });

  it("高亮笔半透明并用 multiply 压在下面的字上", () => {
    const item = makeItem("ink", { highlight: true, points: [[0, 0, 0.5]] });
    const { container } = renderFlow(<InkNode {...props(item)} />);
    const svg = container.querySelector("svg");
    expect(svg?.style.mixBlendMode).toBe("multiply");
    expect(Number(svg?.style.opacity)).toBeLessThan(1);
  });
});

describe("ShapeNode", () => {
  it("六种几何形都画得出路径，未填充时 fill 是 none", () => {
    const item = makeItem("shape", { geo: "hexagon", w: 120, h: 80 });
    const { container } = renderFlow(<ShapeNode {...props(item)} />);
    const path = container.querySelector("path");
    expect(path?.getAttribute("d")).toMatch(/^M /u);
    expect(path?.getAttribute("fill")).toBe("none");
  });

  it("有标签时渲染标签", () => {
    const item = makeItem("shape", { label: "步骤一" });
    const { getByText } = renderFlow(<ShapeNode {...props(item)} />);
    expect(getByText("步骤一")).toBeTruthy();
  });
});

describe("TextNode", () => {
  it("双击进编辑，编辑区带 nodrag（在里面选词不会拖走对象）", () => {
    const item = makeItem("text", { text: "两行\n文字" });
    const { getAllByText, container } = renderFlow(
      <TextNode {...props(item)} />,
    );
    // 两份：撑高度的隐藏副本在前，可见的那一份在后。
    const shown = getAllByText(/两行/u);
    expect(shown).toHaveLength(2);
    fireEvent.doubleClick(shown[1]!);
    const textarea = container.querySelector("textarea");
    expect(textarea).toBeTruthy();
    expect(textarea?.className).toContain("nodrag");
    expect(textarea?.className).toContain("nowheel");
  });
});

describe("ImageNode", () => {
  it("显示地址由资产接口现算，文档里只有相对路径", () => {
    const item = makeItem("image", {
      assetPath: ".armadra/assets/0011223344556677.png",
    });
    const { container } = renderFlow(<ImageNode {...props(item)} />);
    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      "http://runtime/w1/.armadra/assets/0011223344556677.png",
    );
  });
});

describe("LineNode", () => {
  it("箭头位打开时多画一条箭头路径", () => {
    const plain = makeItem("line", {
      points: [
        [0, 0],
        [100, 0],
      ],
    });
    const withArrow = { ...plain, arrowEnd: true };
    const a = renderFlow(<LineNode {...props(plain)} />);
    const b = renderFlow(<LineNode {...props(withArrow)} />);
    expect(b.container.querySelectorAll("path").length).toBe(
      a.container.querySelectorAll("path").length + 1,
    );
  });

  it("选中时才出现端点把手", () => {
    const item = makeItem("line");
    const idle = renderFlow(<LineNode {...props(item)} />);
    expect(idle.container.querySelectorAll("circle")).toHaveLength(0);
    const active = renderFlow(<LineNode {...props(item, true)} />, {
      selected: true,
    });
    expect(active.container.querySelectorAll("circle").length).toBeGreaterThan(
      0,
    );
  });
});
