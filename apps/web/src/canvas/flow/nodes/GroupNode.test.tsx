import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import type { CanvasNode, FrameBinding } from "@armadra/shared";

const store = vi.hoisted(() => ({
  document: { nodes: [] as CanvasNode[], edges: [] },
  workspace: { id: "w1", rootPath: "/tmp" },
  resizeNode: vi.fn(),
  updateNodeData: vi.fn(),
}));

vi.mock("@/store/canvas-store", () => {
  const useCanvasStore = <T,>(selector: (state: typeof store) => T) =>
    selector(store);
  useCanvasStore.getState = () => store;
  return { useCanvasStore };
});

/** GitHub 徽标自己要打接口；这里只关心「宿主是不是 GroupNode」。 */
vi.mock("@/panels/github/GithubReferenceBadge", () => ({
  GithubReferenceBadge: ({ nodeId }: { nodeId: string }) => (
    <span data-testid="github-badge">{nodeId}</span>
  ),
}));

vi.mock("../overlays/WorktreeBindingBadge", () => ({
  WorktreeBindingBadge: ({ node }: { node: CanvasNode }) => (
    <span data-testid="binding-badge">{node.id}</span>
  ),
}));

import { installDomPolyfills } from "@/app/test-harness";
import { makeNode, renderFlow } from "@/canvas/test-support";
import { NODE_META } from "@/nodes/registry";
import { GroupNode } from "./GroupNode";

/**
 * 分组 = Frame（React Flow 计划 F05 / F08）。
 *
 * 重点是 F08：worktree 绑定徽章与 GitHub 关联徽标的宿主从派生层
 * （`overlays/CanvasOverlays` 里按页面坐标绝对定位的两层）换成了 Frame
 * 自己。旧引擎那两层的定位测试跟着一起消失，换成这里的「挂在不挂在」。
 */

beforeAll(installDomPolyfills);
afterEach(cleanup);

const BINDING: FrameBinding = {
  worktreePath: "/tmp/wt",
  branch: "feature/x",
  repositoryPath: ".",
  initScript: null,
  initScriptState: "none",
  initScriptNodeId: null,
} as unknown as FrameBinding;

function group(patch: Partial<CanvasNode> = {}): CanvasNode {
  return makeNode("group", {
    title: "组",
    color: "#0a84ff",
    size: { width: 520, height: 360 },
    ...patch,
  });
}

function renderGroup(node = group(), selected = false) {
  return renderFlow(
    <GroupNode
      id={node.id}
      type="group"
      data={node}
      selected={selected}
      dragging={false}
      zIndex={0}
      isConnectable={false}
      positionAbsoluteX={0}
      positionAbsoluteY={0}
      deletable
      selectable
      draggable
    />,
    { nodeId: node.id, selected },
  );
}

describe("GroupNode", () => {
  it("标题与色带用节点色", () => {
    const { container } = renderGroup(group({ color: "#ff453a" }));
    const label = container.querySelector(".canvas-group-label") as HTMLElement;
    expect(label.textContent).toBe("组");
    expect(label.style.color).toBe("rgb(255, 69, 58)");
    expect(
      (container.querySelector(".canvas-group") as HTMLElement).style
        .borderColor,
    ).toBe("rgb(255, 69, 58)");
  });

  it("没选中不画 resize 把手，选中了按 `NODE_META.group.minSize` 夹住", () => {
    const plain = renderGroup(group(), false);
    expect(
      plain.container.querySelectorAll(".react-flow__resize-control"),
    ).toHaveLength(0);
    cleanup();

    const picked = renderGroup(group(), true);
    expect(
      picked.container.querySelectorAll(".react-flow__resize-control").length,
    ).toBeGreaterThan(0);
    expect(NODE_META.group.minSize).toEqual({ width: 200, height: 140 });
  });

  it("GitHub 关联徽标挂在 Frame 上（旧引擎里它在派生层）", () => {
    const node = group();
    renderGroup(node);
    expect(screen.getByTestId("github-badge").textContent).toBe(node.id);
  });

  it("没绑 worktree 时不画绑定徽章", () => {
    renderGroup();
    expect(screen.queryByTestId("binding-badge")).toBeNull();
  });

  it("绑了 worktree 就把徽章挂进 Frame，并且自己收回指针事件", () => {
    const node = group({
      data: { kind: "group", binding: BINDING },
    } as Partial<CanvasNode>);
    const { container } = renderGroup(node);
    const badge = screen.getByTestId("binding-badge");
    expect(badge.textContent).toBe(node.id);
    expect(
      (badge.parentElement as HTMLElement).classList.contains("nodrag"),
    ).toBe(true);
    expect(container.querySelector('[data-slot="group-frame"]')).not.toBeNull();
  });

  it("分组没有起笔的圆点，但有落点（§2.3 第四行）", () => {
    const { container } = renderGroup();
    expect(
      container.querySelectorAll('[data-slot="connection-handle"]'),
    ).toHaveLength(0);
    expect(
      container.querySelector('[data-slot="connection-drop"]'),
    ).not.toBeNull();
  });
});
