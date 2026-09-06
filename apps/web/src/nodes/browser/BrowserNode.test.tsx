import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { renderFlow } from "@/canvas/test-support";
import type { BrowserSession, CanvasNode } from "@armadra/shared";

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

const api = vi.hoisted(() => ({
  browserAvailability: vi.fn(),
  createBrowserSession: vi.fn(),
  browserSubscribe: vi.fn(),
  browserUnsubscribe: vi.fn(),
  browserInput: vi.fn(),
  browserNavigate: vi.fn(),
  browserViewport: vi.fn(),
  browserCapture: vi.fn(),
  browserLease: vi.fn(),
  browserTabs: vi.fn(),
  browserOpenTab: vi.fn(),
  browserActivateTab: vi.fn(),
  browserCloseTab: vi.fn(),
  browserDialog: vi.fn(),
  browserUpload: vi.fn(),
  importFiles: vi.fn(),
  closeBrowserSession: vi.fn(),
  installBrowserManaged: vi.fn(),
}));

const toasts = vi.hoisted(() => ({ toast: vi.fn(), error: vi.fn() }));

vi.mock("@/store/canvas-store", () => {
  const useCanvasStore = <T,>(selector: (state: typeof store) => T) =>
    selector(store);
  useCanvasStore.getState = () => store;
  return { useCanvasStore };
});

vi.mock("@/api/client", () => ({
  RUNTIME_URL: "http://runtime",
  runtimeApi: api,
  isConflict: (error: unknown) =>
    (error as { status?: number } | null)?.status === 409,
  terminalWebSocketUrl: (id: string) => `ws://x/${id}`,
}));

vi.mock("sonner", () => ({
  toast: Object.assign(toasts.toast, { error: toasts.error }),
}));

const platform = vi.hoisted(() => ({
  isTauri: vi.fn(() => false),
  pickFiles: vi.fn(async () => [] as string[]),
}));

vi.mock("@/platform", () => ({
  openExternal: vi.fn(),
  isTauri: platform.isTauri,
  pickFiles: platform.pickFiles,
}));

import {
  BrowserStreamClientSchema,
  BrowserStreamFrameSchema,
  create,
  fromBinary,
  toBinary,
} from "@armadra/protocol";

import { BrowserNode } from "./BrowserNode";
import { relativeToRoot, surfacePoint } from "./geometry";
import { dispatchWorkspaceEvent, resetWorkspaceEvents } from "@/api/events";

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

const session: BrowserSession = {
  sessionId: "s1",
  generation: 1,
  workspaceId: "w1",
  nodeId: "b1",
  url: "https://example.test/",
  title: "Example",
  viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
  state: "ready",
  reasonCode: "",
  navigationEpoch: 7,
  headful: false,
  keepAlive: true,
  canGoBack: false,
  canGoForward: false,
  createdAt: "2026-09-05T00:00:00.000Z",
  updatedAt: "2026-09-05T00:00:00.000Z",
  activeTabId: "",
  tabCount: 0,
  leaseGeneration: 0,
};

/**
 * 帧流的假连接（设计 §2.9）。
 *
 * 测试直接扮演 Runtime：`sent` 是这一端发上去的 `BrowserStreamClient`，
 * `deliver` 把一帧二进制 `BrowserStreamFrame` 塞下来。
 */
class FakeSocket {
  static last: FakeSocket | null = null;
  static opened: string[] = [];
  binaryType = "";
  readyState = 1;
  closed = false;
  sent: Uint8Array[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    FakeSocket.last = this;
    FakeSocket.opened.push(url);
    queueMicrotask(() => this.onopen?.());
  }

  send(payload: ArrayBufferLike | Uint8Array) {
    this.sent.push(new Uint8Array(payload as ArrayBufferLike));
  }

  close() {
    this.closed = true;
    this.readyState = 3;
  }

  /** 这一端发上去的第 n 条 `BrowserStreamClient`。 */
  client(index: number) {
    return fromBinary(BrowserStreamClientSchema, this.sent[index]!);
  }

  deliver(overrides: Record<string, unknown> = {}) {
    const message = create(BrowserStreamFrameSchema, {
      sessionId: "s1",
      generation: 1n,
      frameSeq: 4n,
      navigationEpoch: 7n,
      viewportWidth: 1280,
      viewportHeight: 720,
      deviceScaleFactor: 1,
      encoding: "jpeg",
      data: new Uint8Array([0xff, 0xd8, 0xff]),
      capturedAtUnixMs: 0n,
      ...overrides,
    });
    this.onmessage?.({
      data: toBinary(BrowserStreamFrameSchema, message).buffer,
    });
  }
}

const drawImage = vi.fn();

function renderBrowser(selected = false) {
  return renderFlow(
    <BrowserNode
      id="b1"
      node={node}
      selected={selected}
      collapsed={false}
      focused={false}
    />,
    { nodeId: "b1", selected },
  );
}

beforeEach(() => {
  api.browserAvailability.mockResolvedValue({
    available: true,
    executable: "/usr/bin/chromium",
    source: "detected",
    reasonCode: "",
    searched: [],
  });
  api.createBrowserSession.mockResolvedValue(session);
  api.browserSubscribe.mockResolvedValue({
    subscriptionId: "sub-1",
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
    quality: 60,
    maxFps: 15,
  });
  api.browserUnsubscribe.mockResolvedValue(undefined);
  api.browserTabs.mockResolvedValue({ tabs: [], activeTabId: "", limit: 16 });
  api.browserActivateTab.mockResolvedValue({
    tabs: [],
    activeTabId: "",
    limit: 16,
  });
  api.browserCloseTab.mockResolvedValue({
    tabs: [],
    activeTabId: "",
    limit: 16,
  });
  api.browserOpenTab.mockResolvedValue({
    tabs: [],
    activeTabId: "",
    limit: 16,
  });
  api.browserDialog.mockResolvedValue({});
  api.browserUpload.mockResolvedValue({
    paths: [],
    tabId: "t1",
    answeredChooser: true,
  });
  platform.isTauri.mockReturnValue(false);
  platform.pickFiles.mockResolvedValue([]);
  api.browserInput.mockResolvedValue({ accepted: 1, navigationEpoch: 7 });
  api.browserCapture.mockResolvedValue({
    path: ".armadra/captures/a.png",
    width: 1280,
    height: 720,
    sha256: "a".repeat(64),
    bytes: 100,
    navigationEpoch: 7,
  });

  drawImage.mockClear();
  FakeSocket.last = null;
  FakeSocket.opened = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  // jsdom 不解 JPEG；这里只要一个「能画的东西」，画得对不对是浏览器的事。
  vi.stubGlobal("createImageBitmap", () =>
    Promise.resolve({ width: 1280, height: 720, close: vi.fn() }),
  );
  HTMLCanvasElement.prototype.getContext = vi.fn(
    () => ({ drawImage }) as unknown as CanvasRenderingContext2D,
  ) as unknown as HTMLCanvasElement["getContext"];
});

afterEach(() => {
  cleanup();
  resetWorkspaceEvents();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("surfacePoint", () => {
  it("maps the displayed box back to CSS viewport pixels", () => {
    expect(
      surfacePoint(
        { left: 10, top: 20, width: 640, height: 360 },
        { width: 1280, height: 720 },
        170,
        110,
      ),
    ).toEqual({ x: 320, y: 180 });
  });
});

describe("BrowserNode 受控模式", () => {
  it("paints a frame from the dedicated stream and acknowledges it", async () => {
    renderBrowser();
    await waitFor(() => expect(api.createBrowserSession).toHaveBeenCalled());
    const canvas = (await screen.findByLabelText(
      "页面画面",
    )) as HTMLCanvasElement;
    await waitFor(() => expect(FakeSocket.last).not.toBeNull());
    const socket = FakeSocket.last!;

    // 连上就订阅：`hello` 带可见性与带宽等级，没有第二次「订阅」调用。
    await waitFor(() => expect(socket.sent.length).toBeGreaterThan(0));
    expect(socket.client(0).message.case).toBe("hello");
    expect(api.browserSubscribe).not.toHaveBeenCalled();
    expect(FakeSocket.opened[0]).toContain(
      "/api/workspaces/w1/browser/sessions/s1/stream",
    );

    socket.deliver();
    await waitFor(() => expect(drawImage).toHaveBeenCalledTimes(1));
    expect(canvas.width).toBe(1280);
    expect(canvas.height).toBe(720);
    // 画完才确认：背压量的是这一端真的跟上了没有，不是网络缓冲区。
    const ack = socket.client(socket.sent.length - 1);
    expect(ack.message.case).toBe("ack");
    expect(ack.message.value).toBe(4n);
  });

  it("sends a click up the stream in viewport coordinates with the frame's epoch", async () => {
    renderBrowser();
    const canvas = (await screen.findByLabelText(
      "页面画面",
    )) as HTMLCanvasElement;
    await waitFor(() => expect(api.createBrowserSession).toHaveBeenCalled());
    await waitFor(() => expect(FakeSocket.last).not.toBeNull());
    const socket = FakeSocket.last!;
    socket.deliver();
    await waitFor(() => expect(drawImage).toHaveBeenCalled());

    // 显示框是 viewport 的一半，所以坐标要乘 2。
    canvas.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 640, height: 360 }) as DOMRect;

    fireEvent.pointerDown(canvas, { clientX: 100, clientY: 50, button: 0 });
    fireEvent.pointerUp(canvas, { clientX: 100, clientY: 50, button: 0 });

    await waitFor(() =>
      expect(
        socket.sent.some(
          (_, index) => socket.client(index).message.case === "input",
        ),
      ).toBe(true),
    );
    const index = socket.sent.findIndex(
      (_, at) => socket.client(at).message.case === "input",
    );
    const input = socket.client(index).message.value as {
      navigationEpoch: bigint;
      frameSeq: bigint;
      events: { kind: number; x: number; y: number; button: string }[];
    };
    expect(input.navigationEpoch).toBe(7n);
    expect(input.frameSeq).toBe(4n);
    expect(input.events.map((event) => [event.x, event.y])).toEqual([
      [200, 100],
      [200, 100],
    ]);
    expect(input.events[0]!.button).toBe("left");
    // HTTP 回退在连接可用时不该被用到。
    expect(api.browserInput).not.toHaveBeenCalled();
  });

  it("closes the stream on unmount without ending the session", async () => {
    const view = renderBrowser(true);
    await waitFor(() => expect(FakeSocket.last).not.toBeNull());
    const socket = FakeSocket.last!;
    view.unmount();
    await waitFor(() => expect(socket.closed).toBe(true));
    expect(api.closeBrowserSession).not.toHaveBeenCalled();
  });

  it("saves a screenshot and reports the workspace path", async () => {
    renderBrowser();
    await waitFor(() => expect(api.createBrowserSession).toHaveBeenCalled());
    fireEvent.click(await screen.findByRole("button", { name: "截图" }));
    await waitFor(() =>
      expect(toasts.toast).toHaveBeenCalledWith(
        "截图已保存到 .armadra/captures/a.png",
      ),
    );
  });
});

describe("BrowserNode 不可用与兼容模式", () => {
  beforeEach(() => {
    api.browserAvailability.mockResolvedValue({
      available: false,
      executable: "",
      source: "none",
      reasonCode: "chrome_not_found",
      searched: ["/usr/bin/chromium", "/opt/google/chrome/chrome"],
    });
  });

  it("falls back to the compatibility iframe when no browser is available", async () => {
    const { container } = renderBrowser();
    await waitFor(() =>
      expect(container.querySelector("iframe")).not.toBeNull(),
    );
    expect(container.querySelector("iframe")?.getAttribute("src")).toBe(
      "https://example.test/",
    );
    expect(api.createBrowserSession).not.toHaveBeenCalled();
  });

  it("explains why controlled mode cannot run and offers no controlled buttons", async () => {
    renderBrowser();
    fireEvent.click(await screen.findByRole("radio", { name: "受控" }));

    expect(
      await screen.findByText("没有找到可用的 Chrome / Chromium"),
    ).toBeTruthy();
    expect(screen.getByText("/usr/bin/chromium")).toBeTruthy();
    expect(screen.getByText("/opt/google/chrome/chrome")).toBeTruthy();

    for (const label of ["后退", "前进", "刷新", "截图", "外部打开"]) {
      expect(screen.queryByRole("button", { name: label })).toBeNull();
    }
    // 地址栏同样不给：受控模式下没有会话可以导航。
    expect(screen.queryByLabelText("网址")).toBeNull();
    expect(api.createBrowserSession).not.toHaveBeenCalled();
  });
});

describe("BrowserNode 标签条", () => {
  const twoTabs = {
    tabs: [
      {
        tabId: "t1",
        url: "https://example.test/",
        title: "Example",
        active: true,
        openerTabId: "",
        navigationEpoch: 7,
        loading: false,
        favicon: "data:image/png;base64,iVBORw0KGgo=",
      },
      {
        tabId: "t2",
        url: "https://popup.test/",
        title: "",
        active: false,
        openerTabId: "t1",
        navigationEpoch: 1,
        loading: true,
        favicon: "",
      },
    ],
    activeTabId: "t1",
    limit: 16,
  };

  it("stays out of the way for one tab and appears when a page opens a second", async () => {
    api.browserTabs.mockResolvedValue({
      tabs: [twoTabs.tabs[0]],
      activeTabId: "t1",
      limit: 16,
    });
    renderBrowser();
    await waitFor(() => expect(api.browserTabs).toHaveBeenCalled());
    // 一个标签时条上没有信息可给：标题在节点头部，地址在地址栏。
    expect(screen.queryByRole("tablist")).toBeNull();

    // `window.open` 之后 Runtime 整张表一起推下来。
    dispatchWorkspaceEvent({
      type: "browser.tabs",
      sessionId: "s1",
      tabs: twoTabs,
    });
    const strip = await screen.findByRole("tablist");
    const tabs = within(strip).getAllByRole("tab");
    expect(tabs).toHaveLength(2);
    expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
    // 图标随标签一起来，不是界面自己去站点上取的。
    expect(
      strip.querySelector('img[src^="data:image/png;base64,"]'),
    ).not.toBeNull();
    // 还没有标题的标签显示地址，而不是一片空白。
    expect(tabs[1]?.textContent).toContain("https://popup.test/");
    expect(
      strip.querySelector('[data-slot="browser-tab-loading"]'),
    ).not.toBeNull();
  });

  it("switches, closes and opens tabs through the runtime", async () => {
    api.browserTabs.mockResolvedValue(twoTabs);
    renderBrowser();
    const strip = await screen.findByRole("tablist");

    fireEvent.click(within(strip).getAllByRole("tab")[1]!);
    await waitFor(() =>
      expect(api.browserActivateTab).toHaveBeenCalledWith("w1", "s1", "t2"),
    );

    fireEvent.click(
      within(strip).getAllByRole("button", { name: "关闭标签" })[0]!,
    );
    await waitFor(() =>
      expect(api.browserCloseTab).toHaveBeenCalledWith("w1", "s1", "t1"),
    );

    fireEvent.click(within(strip).getByRole("button", { name: "新建标签" }));
    await waitFor(() =>
      expect(api.browserOpenTab).toHaveBeenCalledWith(
        "w1",
        "s1",
        "https://example.test/",
      ),
    );
  });

  it("shows a mark on the tab a dialog is blocking", async () => {
    api.browserTabs.mockResolvedValue({
      ...twoTabs,
      tabs: [
        twoTabs.tabs[0],
        {
          ...twoTabs.tabs[1],
          loading: false,
          pendingDialog: {
            dialogId: "d1",
            tabId: "t2",
            kind: "confirm",
            message: "真的要删除吗？",
            defaultPrompt: "",
            url: "https://popup.test/",
            openedAt: "2026-09-07T00:00:00.000Z",
          },
        },
      ],
    });
    renderBrowser();
    const strip = await screen.findByRole("tablist");
    // 待答复的对话框和加载中是两个不同的记号：前者要人答复，在它之前这个
    // 标签上的输入一律被拒（§2.4）。
    expect(
      strip.querySelector('[data-slot="browser-tab-dialog"]'),
    ).not.toBeNull();
    expect(strip.querySelector('[data-slot="browser-tab-loading"]')).toBeNull();
  });
});

describe("BrowserNode 对话框", () => {
  it("answers a prompt with the text that was typed", async () => {
    renderBrowser();
    // 会话真的落到状态里之后再推事件：`createBrowserSession` 被调用只说明
    // 请求发出去了，订阅是挂在 sessionId 上的。
    await waitFor(() => expect(api.browserTabs).toHaveBeenCalled());
    dispatchWorkspaceEvent({
      type: "browser.dialog",
      sessionId: "s1",
      dialog: {
        dialogId: "d1",
        tabId: "t1",
        kind: "prompt",
        message: "叫什么名字？",
        defaultPrompt: "匿名",
        url: "https://example.test/form",
        openedAt: "2026-09-07T00:00:00.000Z",
      },
    });

    expect(await screen.findByText("叫什么名字？")).toBeTruthy();
    const field = screen.getByLabelText("回答") as HTMLInputElement;
    // 页面给的默认值先填上：`prompt(msg, default)` 的第二个参数是页面对人的
    // 建议，丢掉它等于把信息藏起来。
    expect(field.value).toBe("匿名");
    fireEvent.change(field, { target: { value: "小明" } });
    fireEvent.click(screen.getByRole("button", { name: "确定" }));

    await waitFor(() =>
      expect(api.browserDialog).toHaveBeenCalledWith("w1", "s1", {
        tabId: "t1",
        dialogId: "d1",
        accept: true,
        promptText: "小明",
      }),
    );
  });

  it("offers only OK for an alert and never sends prompt text", async () => {
    renderBrowser();
    // 会话真的落到状态里之后再推事件：`createBrowserSession` 被调用只说明
    // 请求发出去了，订阅是挂在 sessionId 上的。
    await waitFor(() => expect(api.browserTabs).toHaveBeenCalled());
    dispatchWorkspaceEvent({
      type: "browser.dialog",
      sessionId: "s1",
      dialog: {
        dialogId: "d2",
        tabId: "t1",
        kind: "alert",
        message: "保存失败",
        defaultPrompt: "",
        url: "https://example.test/",
        openedAt: "2026-09-07T00:00:00.000Z",
      },
    });
    expect(await screen.findByText("保存失败")).toBeTruthy();
    // `alert` 只有一种答复，给一个「取消」按钮是在暗示有第二种。
    expect(screen.queryByRole("button", { name: "取消" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "确定" }));
    await waitFor(() =>
      expect(api.browserDialog).toHaveBeenCalledWith("w1", "s1", {
        tabId: "t1",
        dialogId: "d2",
        accept: true,
      }),
    );
  });

  it("closes itself when somebody else answers the dialog", async () => {
    renderBrowser();
    await waitFor(() => expect(api.browserTabs).toHaveBeenCalled());
    const opened = {
      dialogId: "d3",
      tabId: "t1",
      kind: "confirm" as const,
      message: "离开这一页？",
      defaultPrompt: "",
      url: "https://example.test/",
      openedAt: "2026-09-07T00:00:00.000Z",
    };
    dispatchWorkspaceEvent({
      type: "browser.dialog",
      sessionId: "s1",
      dialog: opened,
    });
    expect(await screen.findByText("离开这一页？")).toBeTruthy();

    // 同一个事件、没有 `dialog`，就是「已经被答复了」——别的设备答的，或者
    // Runtime 到点 dismiss 的。这一端该收起来，而不是等自己超时。
    dispatchWorkspaceEvent({ type: "browser.dialog", sessionId: "s1" });
    await waitFor(() => expect(screen.queryByText("离开这一页？")).toBeNull());
    expect(api.browserDialog).not.toHaveBeenCalled();
  });
});

describe("BrowserNode 文件选择器", () => {
  const chooser = {
    type: "browser.fileChooser" as const,
    sessionId: "s1",
    chooser: {
      chooserId: "c1",
      tabId: "t1",
      frameId: "",
      multiple: false,
      accept: "",
      openedAt: "2026-09-07T00:00:00.000Z",
    },
  };

  it("imports the bytes first on the web, then fills the input with the path", async () => {
    api.importFiles.mockResolvedValue({
      path: ".armadra/imports/2026",
      files: [
        {
          path: ".armadra/imports/2026/photo.png",
          size: 3,
          sha256: "a".repeat(64),
          mtime: "2026-09-07T00:00:00.000Z",
          binary: true,
        },
      ],
    });
    renderBrowser();
    // 会话真的落到状态里之后再推事件：`createBrowserSession` 被调用只说明
    // 请求发出去了，订阅是挂在 sessionId 上的。
    await waitFor(() => expect(api.browserTabs).toHaveBeenCalled());
    dispatchWorkspaceEvent(chooser);

    expect(await screen.findByText("页面要选择文件")).toBeTruthy();
    // 浏览器里只拿得到字节，所以要先导入——这是可见的副作用，文案说明白。
    expect(
      screen.getByText("选中的文件会先导入到 .armadra/imports/。"),
    ).toBeTruthy();
    const input = screen.getByLabelText("要提交的文件") as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File([new Uint8Array([1, 2, 3])], "photo.png")] },
    });

    await waitFor(() =>
      expect(api.browserUpload).toHaveBeenCalledWith("w1", "s1", {
        chooserId: "c1",
        paths: [".armadra/imports/2026/photo.png"],
      }),
    );
  });

  it("uses the native picker on the desktop and refuses a file outside the workspace", async () => {
    platform.isTauri.mockReturnValue(true);
    platform.pickFiles.mockResolvedValue(["/etc/passwd"]);
    renderBrowser();
    // 会话真的落到状态里之后再推事件：`createBrowserSession` 被调用只说明
    // 请求发出去了，订阅是挂在 sessionId 上的。
    await waitFor(() => expect(api.browserTabs).toHaveBeenCalled());
    dispatchWorkspaceEvent(chooser);

    expect(await screen.findByText("页面要选择文件")).toBeTruthy();
    expect(screen.getByText("只能选工作空间里的文件。")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "选择文件" }));
    await waitFor(() =>
      expect(toasts.error).toHaveBeenCalledWith("文件不在这个工作空间里"),
    );
    // Runtime 会拒；界面在选完的那一刻就说清楚，不必先发一个注定失败的请求。
    expect(api.browserUpload).not.toHaveBeenCalled();

    platform.pickFiles.mockResolvedValue(["/tmp/docs/report.pdf"]);
    fireEvent.click(screen.getByRole("button", { name: "选择文件" }));
    await waitFor(() =>
      expect(api.browserUpload).toHaveBeenCalledWith("w1", "s1", {
        chooserId: "c1",
        paths: ["docs/report.pdf"],
      }),
    );
  });
});

describe("relativeToRoot", () => {
  it("keeps a chooser inside the workspace root", () => {
    expect(relativeToRoot("/tmp/project", "/tmp/project/docs/a.pdf")).toBe(
      "docs/a.pdf",
    );
    expect(relativeToRoot("/tmp/project/", "/tmp/project/a.pdf")).toBe("a.pdf");
    // 前缀相同但不是同一个目录，是最容易被字符串比较放过的一种越界。
    expect(
      relativeToRoot("/tmp/project", "/tmp/project-other/a.pdf"),
    ).toBeNull();
    expect(relativeToRoot("/tmp/project", "/etc/passwd")).toBeNull();
    expect(relativeToRoot("/tmp/project", "/tmp/project")).toBeNull();
    expect(relativeToRoot("", "/tmp/project/a.pdf")).toBeNull();
    expect(
      relativeToRoot("C:\\work\\project", "C:\\work\\project\\a.pdf"),
    ).toBe("a.pdf");
  });
});
