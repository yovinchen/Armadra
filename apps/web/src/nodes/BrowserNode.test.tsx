import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type {
  BrowserSession,
  CanvasNode,
  WorkspaceEvent,
} from "@armadra/shared";

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

import { BrowserNode, surfacePoint } from "./BrowserNode";
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

function frame(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    type: "browser.frame",
    sessionId: "s1",
    generation: 1,
    frameSeq: 4,
    navigationEpoch: 7,
    viewportWidth: 1280,
    viewportHeight: 720,
    deviceScaleFactor: 1,
    encoding: "jpeg",
    data: "AAAA",
    capturedAt: "2026-09-05T00:00:01.000Z",
    ...overrides,
  } as WorkspaceEvent;
}

const drawImage = vi.fn();
/** 最近一次 `new Image()`；测试自己触发 `onload`，jsdom 不解码 data URI。 */
let lastImage: { src: string; onload: (() => void) | null } | null = null;

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
  lastImage = null;
  vi.stubGlobal(
    "Image",
    class {
      onload: (() => void) | null = null;
      #src = "";
      constructor() {
        lastImage = this as unknown as {
          src: string;
          onload: (() => void) | null;
        };
      }
      set src(value: string) {
        this.#src = value;
      }
      get src() {
        return this.#src;
      }
    },
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
  it("paints a frame for this session and ignores other sessions", async () => {
    renderBrowser();
    await waitFor(() => expect(api.createBrowserSession).toHaveBeenCalled());
    const canvas = (await screen.findByLabelText(
      "页面画面",
    )) as HTMLCanvasElement;

    dispatchWorkspaceEvent(frame());
    expect(lastImage?.src).toBe("data:image/jpeg;base64,AAAA");
    lastImage?.onload?.();
    expect(drawImage).toHaveBeenCalledTimes(1);
    expect(canvas.width).toBe(1280);
    expect(canvas.height).toBe(720);

    // 别的会话的帧不属于这个节点，连 Image 都不该建。
    lastImage = null;
    dispatchWorkspaceEvent(frame({ sessionId: "other", data: "BBBB" }));
    expect(lastImage).toBeNull();
    expect(drawImage).toHaveBeenCalledTimes(1);
  });

  it("posts a click in viewport coordinates with the frame's epoch", async () => {
    renderBrowser();
    const canvas = (await screen.findByLabelText(
      "页面画面",
    )) as HTMLCanvasElement;
    await waitFor(() => expect(api.createBrowserSession).toHaveBeenCalled());
    dispatchWorkspaceEvent(frame());

    // 显示框是 viewport 的一半，所以坐标要乘 2。
    canvas.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 640, height: 360 }) as DOMRect;

    fireEvent.pointerDown(canvas, { clientX: 100, clientY: 50, button: 0 });
    fireEvent.pointerUp(canvas, { clientX: 100, clientY: 50, button: 0 });

    await waitFor(() => expect(api.browserInput).toHaveBeenCalled());
    const [workspaceId, sessionId, request] = api.browserInput.mock.calls[0]!;
    expect(workspaceId).toBe("w1");
    expect(sessionId).toBe("s1");
    expect(request.navigationEpoch).toBe(7);
    expect(request.frameSeq).toBe(4);
    expect(request.events[0]).toMatchObject({
      kind: "mousePressed",
      x: 200,
      y: 100,
      button: "left",
    });
    expect(request.events[1]).toMatchObject({ kind: "mouseReleased" });
  });

  it("holds a screencast subscription and drops it without ending the session", async () => {
    const view = renderBrowser(true);
    await waitFor(() =>
      expect(api.browserSubscribe).toHaveBeenCalledWith("w1", "s1", {
        visibility: "focused",
      }),
    );
    view.unmount();
    await waitFor(() =>
      expect(api.browserUnsubscribe).toHaveBeenCalledWith("w1", "s1", "sub-1"),
    );
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
