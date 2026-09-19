import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { renderFlow } from "@/canvas/test-support";
import type { CanvasNode } from "@armadra/shared";

/**
 * Electron 分支的渲染面（W3.1）。
 *
 * 这里**不测**点击命中、缩放清晰度、guest 存活——那三样只有真 Electron 能
 * 回答，而且探针已经逐条答过了（`docs/research/nodeterm/webview-probe.md`）。
 * jsdom 里的 `<webview>` 只是一个未知元素，所以这份用例钉的是渲染侧自己能
 * 决定的几件事：分流判定、partition 只定一次、后台标签是隐藏不是卸载、以及
 * 导航由 `src` 属性驱动。
 *
 * 探针第 5 条还有一条对自动化的硬约束：真 Electron 里的交互测试**只能用
 * CDP 注入输入**，`webContents.sendInputEvent` 到不了 guest，用它写的用例会
 * 全绿地什么都没测。W3.3 的闸门脚本照此写。
 */

const store = vi.hoisted(() => ({
  document: { nodes: [] as CanvasNode[] },
  focusNodeId: null as string | null,
  maximized: {} as Record<string, unknown>,
  workspace: { id: "w1", rootPath: "/tmp" },
  selectNodes: vi.fn(),
  updateNode: vi.fn(),
  updateNodeData: vi.fn(),
  setCollapsed: vi.fn(),
  maximizeNode: vi.fn(),
  restoreNode: vi.fn(),
  removeNodes: vi.fn(),
  resizeNode: vi.fn(),
  addNode: vi.fn(),
}));

vi.mock("@/store/canvas-store", () => {
  const useCanvasStore = <T,>(selector: (state: typeof store) => T) =>
    selector(store);
  useCanvasStore.getState = () => store;
  return { useCanvasStore };
});

vi.mock("@/platform", () => ({
  openExternal: vi.fn(),
  isTauri: vi.fn(() => false),
  pickFiles: vi.fn(async () => [] as string[]),
}));

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn() }),
}));

import { BrowserNode } from "./BrowserNode";

const node = {
  id: "b1",
  boardId: "board",
  type: "browser",
  title: "浏览器",
  color: "#0a84ff",
  position: { x: 0, y: 0 },
  size: { width: 640, height: 440 },
  data: { kind: "browser", url: "https://example.test/" },
  createdAt: "2026-09-05T00:00:00.000Z",
  updatedAt: "2026-09-05T00:00:00.000Z",
} as CanvasNode;

function paint() {
  return renderFlow(
    <BrowserNode
      id="b1"
      node={node}
      selected={false}
      collapsed={false}
      focused={false}
    />,
    { nodeId: "b1" },
  );
}

function guests(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>('[data-slot="browser-webview"]'),
  );
}

beforeEach(() => {
  store.document.nodes = [node];
  store.updateNodeData.mockClear();
  (window as unknown as Record<string, unknown>).armadra = {};
});

afterEach(() => {
  cleanup();
  delete (window as unknown as Record<string, unknown>).armadra;
});

describe("浏览器节点的分流", () => {
  it("壳在时渲染 <webview>，一个受控会话都不开", () => {
    paint();
    expect(guests()).toHaveLength(1);
    expect(guests()[0]!.getAttribute("src")).toBe("https://example.test/");
  });

  it("壳不在时一个 <webview> 都不渲染——旧 screencast 路径原样保留", () => {
    delete (window as unknown as Record<string, unknown>).armadra;
    paint();
    expect(guests()).toHaveLength(0);
  });
});

describe("partition", () => {
  it("按工作空间共享一个 jar，且创建时定一次", () => {
    const view = paint();
    const before = guests()[0]!.getAttribute("partition");
    expect(before).toBe("persist:armadra-browser-w1");

    // 重渲染不改它。Electron 只在 attach 时读这个属性，之后再改会被静默忽
    // 略（探针 C）——所以这里必须是「从头到尾同一个值」，不是「改了也行」。
    view.rerenderNode(
      <BrowserNode
        id="b1"
        node={node}
        selected={true}
        collapsed={false}
        focused={true}
      />,
    );
    expect(guests()[0]!.getAttribute("partition")).toBe(before);
  });
});

describe("标签", () => {
  it("后台标签用 display:none 留在 DOM 里，不卸载", () => {
    paint();
    // 页面开一个新窗口 → 变成本节点的新标签。
    fireEvent(
      guests()[0]!,
      Object.assign(new Event("new-window"), {
        url: "https://second.test/",
      }),
    );

    const all = guests();
    expect(all).toHaveLength(2);
    // 旧标签还在 DOM 里，只是不可见——卸载它等于杀掉那个渲染进程。
    expect(all[0]!.style.display).toBe("none");
    expect(all[1]!.style.display).not.toBe("none");
    expect(all[1]!.getAttribute("src")).toBe("https://second.test/");
  });

  it("非 http(s) 的新窗口不开标签", () => {
    paint();
    fireEvent(
      guests()[0]!,
      Object.assign(new Event("new-window"), { url: "file:///etc/passwd" }),
    );
    expect(guests()).toHaveLength(1);
  });
});

describe("导航", () => {
  it("地址栏回车改的是 src 属性，不是 loadURL", () => {
    paint();
    const address = screen.getByLabelText("网址");
    fireEvent.change(address, { target: { value: "github.com" } });
    fireEvent.keyDown(address, { key: "Enter" });

    expect(guests()[0]!.getAttribute("src")).toBe("https://github.com");
    expect(store.updateNodeData).toHaveBeenCalledWith("b1", {
      url: "https://github.com",
    });
  });

  it("did-navigate 只更新地址栏并回写 URL，不动 src——否则是自激循环", () => {
    paint();
    const guest = guests()[0]!;
    fireEvent(
      guest,
      Object.assign(new Event("did-navigate"), {
        url: "https://example.test/deep",
      }),
    );

    expect(guest.getAttribute("src")).toBe("https://example.test/");
    expect((screen.getByLabelText("网址") as HTMLInputElement).value).toBe(
      "https://example.test/deep",
    );
    expect(store.updateNodeData).toHaveBeenCalledWith("b1", {
      url: "https://example.test/deep",
    });
  });
});
