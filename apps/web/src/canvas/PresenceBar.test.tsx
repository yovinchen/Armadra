import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Board, BoardDocument, BoardPresence } from "@armadra/shared";

const acquireLease = vi.fn();
vi.mock("@/api/client", () => ({
  runtimeApi: {
    acquireLease: (...args: unknown[]) => acquireLease(...args),
  },
}));

import { installDomPolyfills } from "@/app/test-harness";
import { useCanvasStore } from "@/store/canvas-store";
import {
  applyPresence,
  isReadOnly,
  resetPresenceClient,
} from "@/store/canvas/presence";
import { TooltipProvider } from "@/ui/tooltip";
import { PresenceBar } from "./PresenceBar";

/**
 * 在线设备条与只读判定（core JSON §9）：只有自己时一个像素都不画，别的设备
 * 拿着租约时画布只读、有一句提示、接管要先确认。
 */

const ME = "me-0000000000";
const OTHER = "other-00000000";
const stamp = "2026-09-26T08:00:00.000Z";
const board: Board = {
  id: "019ff7d1-7419-74df-89e2-b1619d36ea7d",
  workspaceId: "019ff7d1-0d12-7421-833d-2c5e8d64ed21",
  name: "Default",
  sortOrder: 0,
  viewport: { x: 0, y: 0, zoom: 1 },
  whiteboard: "",
  createdAt: stamp,
  updatedAt: stamp,
};
const document: BoardDocument = { board, nodes: [], edges: [] };

/** `sameDevice`：别的客户端是同一台设备上的另一个窗口（同一个 deviceKey）。 */
function presence(
  holder: string | null,
  clients: string[],
  sameDevice = false,
): BoardPresence {
  const keyOf = (clientId: string) =>
    clientId === ME || sameDevice ? "key-mine" : "key-ipad";
  const nameOf = (clientId: string) =>
    clientId === ME || sameDevice ? "macOS" : "iPad";
  return {
    boardId: board.id,
    clients: clients.map((clientId) => ({
      clientId,
      deviceName: nameOf(clientId),
      deviceKey: keyOf(clientId),
      lastSeenAt: stamp,
    })),
    lease:
      holder === null
        ? null
        : {
            clientId: holder,
            deviceName: nameOf(holder),
            deviceKey: keyOf(holder),
            acquiredAt: stamp,
          },
  };
}

function mount() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <TooltipProvider>
        <PresenceBar />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

beforeAll(installDomPolyfills);
beforeEach(() => {
  resetPresenceClient(ME);
  acquireLease.mockReset();
  useCanvasStore.setState({
    workspace: { id: board.workspaceId } as never,
    boardId: board.id,
  });
  useCanvasStore.getState().setDocument(document);
  useCanvasStore.getState().setPresence(null);
});
afterEach(() => {
  cleanup();
  resetPresenceClient();
});

describe("presence", () => {
  it("draws nothing and stays writable when this is the only client", () => {
    applyPresence(presence(ME, [ME]));
    expect(isReadOnly(useCanvasStore.getState())).toBe(false);
    const { container } = mount();
    expect(container.innerHTML).toBe("");
  });

  it("is writable while the lease is free", () => {
    applyPresence(presence(null, [ME, OTHER]));
    expect(isReadOnly(useCanvasStore.getState())).toBe(false);
  });

  it("goes read-only when another client holds the lease and blocks edits", () => {
    const change = applyPresence(presence(OTHER, [ME, OTHER]));
    expect(change).toEqual({ lost: true, gained: false });
    expect(isReadOnly(useCanvasStore.getState())).toBe(true);
    expect(useCanvasStore.getState().addNode("sticky")).toBe("");
    mount();
    expect(screen.getByText("iPad 正在编辑")).toBeTruthy();
  });

  it("goes read-only without write access even alone, keeps it across events, and says so", () => {
    // 服务器壳上只读共享的成员：心跳回答 writable 为假，租约空着也不能写。
    const change = applyPresence({ ...presence(null, [ME]), writable: false });
    expect(change).toEqual({ lost: true, gained: false });
    expect(isReadOnly(useCanvasStore.getState())).toBe(true);
    expect(useCanvasStore.getState().addNode("sticky")).toBe("");
    // 事件里没有 writable：别人来了的那一帧不能把只读冲掉。
    applyPresence(presence(null, [ME, OTHER]));
    expect(isReadOnly(useCanvasStore.getState())).toBe(true);
    mount();
    expect(screen.getByText("只读")).toBeTruthy();
    // 改成可写之后的下一拍心跳解除只读。
    const regained = applyPresence({ ...presence(ME, [ME]), writable: true });
    expect(regained).toEqual({ lost: false, gained: true });
    expect(isReadOnly(useCanvasStore.getState())).toBe(false);
  });

  it("ignores a snapshot of another board", () => {
    applyPresence({ ...presence(OTHER, [ME, OTHER]), boardId: "elsewhere" });
    expect(isReadOnly(useCanvasStore.getState())).toBe(false);
  });

  it("names another window on this device and takes over without asking", async () => {
    // 心跳回答带着自己的 deviceKey；之后的事件帧没有，沿用上一拍的。
    applyPresence({ ...presence(ME, [ME]), deviceKey: "key-mine" });
    applyPresence(presence(OTHER, [ME, OTHER], true));
    expect(isReadOnly(useCanvasStore.getState())).toBe(true);
    acquireLease.mockResolvedValue(presence(ME, [ME, OTHER], true));
    mount();
    expect(screen.getByText("本机另一个窗口正在编辑")).toBeTruthy();
    expect(screen.getByLabelText("本机另一个窗口")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "接管" }));
    // 没有确认框：一次点击就接过来。
    expect(screen.queryByText("接管编辑？")).toBeNull();
    expect(acquireLease).toHaveBeenCalledWith(board.workspaceId, board.id, {
      clientId: ME,
      deviceName: expect.any(String),
      takeover: true,
    });
    await vi.waitFor(() =>
      expect(isReadOnly(useCanvasStore.getState())).toBe(false),
    );
  });

  it("asks before taking over, then takes the lease", async () => {
    applyPresence(presence(OTHER, [ME, OTHER]));
    acquireLease.mockResolvedValue(presence(ME, [ME, OTHER]));
    mount();
    fireEvent.click(screen.getByRole("button", { name: "接管" }));
    expect(acquireLease).not.toHaveBeenCalled();
    const buttons = await screen.findAllByRole("button", { name: "接管" });
    fireEvent.click(buttons[buttons.length - 1] as HTMLElement);
    expect(acquireLease).toHaveBeenCalledWith(board.workspaceId, board.id, {
      clientId: ME,
      deviceName: expect.any(String),
      takeover: true,
    });
    await vi.waitFor(() =>
      expect(isReadOnly(useCanvasStore.getState())).toBe(false),
    );
  });
});
