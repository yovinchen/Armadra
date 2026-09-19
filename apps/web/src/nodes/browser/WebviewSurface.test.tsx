import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
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
  // 真实实现就是「preload 装没装 window.armadra」；测试按同一条判定走，
  // 这样「壳在 / 壳不在」两组用例仍然只靠那一个全局开关切换。
  isDesktop: () =>
    typeof (window as { armadra?: unknown }).armadra !== "undefined",
}));

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn() }),
}));

import { toast } from "sonner";

import { usePreferencesStore } from "@/app/preferences-store";
import { dispatchWorkspaceEvent } from "@/api/events";

import { resetBrowserAlerts } from "./alerts";
import { BrowserNode } from "./BrowserNode";
import { BROWSER_DISCARD_MS, DISCARD_TICK_MS } from "./discard";

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
  usePreferencesStore.setState({
    browser: { discard: true, discardMinutes: 5, backgroundMax: 8 },
  });
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

  it("壳不在时不渲染 guest，只说明节点为什么用不了（W3.5）", () => {
    delete (window as unknown as Record<string, unknown>).armadra;
    const view = paint();
    expect(guests()).toHaveLength(0);
    // 既不是空白，也不是一个按不动的工具栏：一条说清楚原因的提示。
    expect(
      view.container.textContent?.includes("browser.unavailable.desktopOnly") ||
        view.container.textContent?.includes("桌面应用") ||
        view.container.textContent?.includes("desktop app"),
    ).toBe(true);
  });
});

/**
 * 密度（契约 §3.4，2026-09-19）：工具栏 28px、地址栏 12px，页面本身拿走
 * 剩下的全部高度——guest 是 `100%`，所以节点一 resize 网页就按比例跟上。
 */
describe("工具栏密度", () => {
  it("工具栏收到 28px，地址栏 12px，页面吃掉剩下的高度", () => {
    const view = paint();
    const address = screen.getByLabelText("网址");
    expect(address.className).toContain("text-[12px]");

    const toolbar = address.closest("div") as HTMLElement;
    expect(toolbar.className).toContain("h-[28px]");

    const stage = view.container.querySelector(
      '[data-slot="browser-stage"]',
    ) as HTMLElement;
    expect(stage.className).toContain("flex-1");
    expect(stage.className).toContain("min-h-0");
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

describe("隐藏回收（W3.2）", () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(() => vi.useRealTimers());

  /** 隐藏一个 guest：开第二个标签，第一个就退到后台。 */
  function backgroundTheFirstTab() {
    fireEvent(
      guests()[0]!,
      Object.assign(new Event("new-window"), { url: "https://second.test/" }),
    );
  }

  it("隐藏超过 5 分钟后卸载元素，并给出「为省内存释放了」的提示", () => {
    paint();
    // guest 停在一个比初始 src 更深的地址上——回收要记住的是**这一页**。
    fireEvent(
      guests()[0]!,
      Object.assign(new Event("did-navigate"), {
        url: "https://example.test/deep",
      }),
    );
    // 加载中是回收的一条否决，所以先让页面加载完。
    fireEvent(guests()[0]!, new Event("did-stop-loading"));
    backgroundTheFirstTab();
    expect(guests()).toHaveLength(2);

    act(() => {
      vi.advanceTimersByTime(BROWSER_DISCARD_MS + DISCARD_TICK_MS * 2);
    });

    // 后台那一个的元素没了（= 进程释放），活动标签一动不动。
    expect(guests()).toHaveLength(1);
    const notice = document.querySelector('[data-slot="browser-discarded"]');
    expect(notice).not.toBeNull();
    // 说的是内存，不是权限。
    expect(notice!.textContent).toContain("为省内存释放");
  });

  /**
   * 设置在**定时器触发时重读**：人在设置页动了开关，不用等这棵子树重渲，
   * 也不用重开节点——下一个 tick 就按新值判断。
   */
  it("回收开关在定时器触发时重读，关掉之后就不再回收", () => {
    paint();
    fireEvent(guests()[0]!, new Event("did-stop-loading"));
    backgroundTheFirstTab();

    usePreferencesStore.getState().setBrowserPreference("discard", false);
    act(() => {
      vi.advanceTimersByTime(BROWSER_DISCARD_MS + DISCARD_TICK_MS * 2);
    });
    expect(guests()).toHaveLength(2);

    // 再打开，下一个 tick 就回收——没有中间的「要等下一次渲染」。
    usePreferencesStore.getState().setBrowserPreference("discard", true);
    act(() => {
      vi.advanceTimersByTime(DISCARD_TICK_MS * 2);
    });
    expect(guests()).toHaveLength(1);
  });

  it("阈值也在定时器触发时重读，调大之后原来该回收的留了下来", () => {
    paint();
    fireEvent(guests()[0]!, new Event("did-stop-loading"));
    backgroundTheFirstTab();

    usePreferencesStore.getState().setBrowserPreference("discardMinutes", 60);
    act(() => {
      vi.advanceTimersByTime(BROWSER_DISCARD_MS + DISCARD_TICK_MS * 2);
    });
    expect(guests()).toHaveLength(2);

    usePreferencesStore.getState().setBrowserPreference("discardMinutes", 1);
    act(() => {
      vi.advanceTimersByTime(DISCARD_TICK_MS * 2);
    });
    expect(guests()).toHaveLength(1);
    // 提示里的分钟数跟着设置走，不是那个写死的 5。
    expect(
      document.querySelector('[data-slot="browser-discarded"]')!.textContent,
    ).toContain("1 分钟");
  });

  it("回到被回收的标签时重放记住的 URL，且不把那次导航回写成新事实", () => {
    paint();
    fireEvent(
      guests()[0]!,
      Object.assign(new Event("did-navigate"), {
        url: "https://example.test/deep",
      }),
    );
    // 加载中是回收的一条否决，所以先让页面加载完。
    fireEvent(guests()[0]!, new Event("did-stop-loading"));
    backgroundTheFirstTab();
    act(() => {
      vi.advanceTimersByTime(BROWSER_DISCARD_MS + DISCARD_TICK_MS * 2);
    });

    // 切回第一个标签。
    const tabs = document.querySelectorAll<HTMLElement>('[role="tab"]');
    act(() => {
      fireEvent.click(tabs[0]!);
    });

    const restored = guests().find(
      (each) => each.getAttribute("src") === "https://example.test/deep",
    );
    expect(restored).toBeDefined();

    // 重放触发的 `did-navigate` 是回声：它不该再写一次文档。
    store.updateNodeData.mockClear();
    act(() => {
      fireEvent(
        restored!,
        Object.assign(new Event("did-navigate"), {
          url: "https://example.test/deep",
        }),
      );
    });
    expect(store.updateNodeData).not.toHaveBeenCalled();
  });
});

/**
 * 请求方在另一个进程里，看不到这一侧的模型：这四条钉住「落不了地的请求会被
 * 说出来」，而不是按了没反应。
 */
describe("请求落不了地时不再静默", () => {
  type DriveCommand = {
    kind: string;
    nodeId: string;
    action?: string;
    tabId?: string;
    url?: string;
  };
  let drive: ((command: DriveCommand) => void) | null = null;
  const control = vi.fn(async () => ({ ok: false }));

  beforeEach(() => {
    drive = null;
    resetBrowserAlerts();
    control.mockClear();
    vi.mocked(toast.error).mockClear();
    (window as unknown as Record<string, unknown>).armadra = {
      browser: {
        register: vi.fn(async () => ({ ok: true })),
        unregister: vi.fn(async () => ({ ok: true })),
        view: vi.fn(async () => ({ ok: true })),
        control,
        onDrive: (listener: (command: DriveCommand) => void) => {
          drive = listener;
          return () => {};
        },
      },
    };
  });

  function takeover(): HTMLElement {
    return screen.getByRole("button", {
      name: (name: string) =>
        name.includes("接管") || name.includes("Take over"),
    });
  }

  it("租约没换手时给出提示，而不是把按钮弹回去就算了", async () => {
    paint();
    await act(async () => {
      fireEvent.click(takeover());
    });
    expect(control).toHaveBeenCalledWith({ nodeId: "b1", action: "takeover" });
    expect(toast.error).toHaveBeenCalledTimes(1);
  });

  it("抛出的租约请求和被拒的一样要说出来", async () => {
    control.mockRejectedValueOnce(new Error("socket closed"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    paint();
    await act(async () => {
      fireEvent.click(takeover());
    });
    expect(toast.error).toHaveBeenCalledTimes(1);
  });

  it("关掉最后一个标签、切到不存在的标签都会说一声", () => {
    paint();
    expect(drive).not.toBeNull();
    act(() => {
      drive!({ kind: "tabs", nodeId: "b1", action: "close", tabId: "wv-1" });
    });
    act(() => {
      drive!({ kind: "tabs", nodeId: "b1", action: "switch", tabId: "gone" });
    });
    expect(toast.error).toHaveBeenCalledTimes(2);
  });

  /**
   * #8：`ActivityStatus` 过去只在 `index.ts` 被 re-export，从未渲染过。
   * 这一条钉住它确实挂在头部——Agent 的动作对人可见。
   */
  it("Agent 的动作与页面对话框出现在头部租约徽标旁", () => {
    paint();
    act(() => {
      drive!({
        kind: "lease",
        nodeId: "b1",
        lease: {
          state: "agent",
          generation: 1,
          expiresAt: "",
          holder: { kind: "agent", id: "a1", displayName: "Claude" },
        },
      } as never);
    });
    act(() =>
      dispatchWorkspaceEvent({
        type: "browser.activity",
        sessionId: "s1",
        actor: "agent",
        actorId: "a1",
        verb: "click",
        target: "#submit",
        outcome: "ok",
        reasonCode: "",
        at: new Date().toISOString(),
      }),
    );
    const status = document.querySelector('[data-slot="browser-status"]');
    expect(status).not.toBeNull();
    expect(status!.textContent).toContain("click");

    act(() =>
      dispatchWorkspaceEvent({
        type: "browser.dialog",
        sessionId: "s1",
        dialog: {
          dialogId: "d1",
          tabId: "t1",
          kind: "confirm",
          message: "真的要提交吗",
          defaultPrompt: "",
          url: "https://example.test/",
          openedAt: new Date().toISOString(),
        },
      }),
    );
    expect(
      document.querySelector('[data-slot="browser-prompt"]')!.textContent,
    ).toBe("页面询问");
  });

  it("别的节点的标签请求既不执行也不提示", () => {
    paint();
    act(() => {
      drive!({
        kind: "tabs",
        nodeId: "other",
        action: "switch",
        tabId: "gone",
      });
    });
    expect(toast.error).not.toHaveBeenCalled();
  });
});
