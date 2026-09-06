import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
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

vi.mock("@/platform", () => ({ openExternal: vi.fn() }));

import {
  BrowserStreamClientSchema,
  BrowserStreamFrameSchema,
  create,
  fromBinary,
  toBinary,
} from "@armadra/protocol";

import { BrowserNode } from "./BrowserNode";
import { surfacePoint } from "./geometry";
import { resetWorkspaceEvents } from "@/api/events";

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
  return render(
    <BrowserNode
      id="b1"
      node={node}
      selected={selected}
      collapsed={false}
      focused={false}
    />,
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
