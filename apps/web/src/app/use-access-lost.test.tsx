import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const info = vi.fn();
vi.mock("sonner", () => ({
  toast: { info: (...args: unknown[]) => info(...args) },
}));

import { connectWorkspaceEvents, resetWorkspaceEvents } from "../api/events";
import { useCanvasStore } from "../store/canvas-store";
import { usePreferencesStore } from "./preferences-store";
import { useWorkspaceAccessLost } from "./use-access-lost";

/**
 * 服务器壳上撤销共享：core 以 4403 关掉这块工作空间的事件流。此前页面照旧
 * 停在那块画布上（侧栏「当前工作空间永远在树里」），之后的每一次读写都是
 * 403，却没有任何提示。
 */

const WORKSPACE = "019ff7d1-0d12-7421-833d-2c5e8d64ed22";

class FakeSocket {
  static instances: FakeSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: (() => void) | null = null;
  onclose: ((event?: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }
  close() {}
}

const original = globalThis.WebSocket;

beforeEach(() => {
  FakeSocket.instances = [];
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
  usePreferencesStore.setState({ locale: "zh-CN" });
  info.mockReset();
});
afterEach(() => {
  resetWorkspaceEvents();
  globalThis.WebSocket = original;
  useCanvasStore.getState().setWorkspace(null);
});

describe("useWorkspaceAccessLost", () => {
  it("事件流以 4403 关闭时离开这块工作空间，并说一句为什么", () => {
    useCanvasStore
      .getState()
      .setWorkspace({ id: WORKSPACE, name: "共享项目" } as never);
    renderHook(() => useWorkspaceAccessLost());
    const release = connectWorkspaceEvents(WORKSPACE);
    FakeSocket.instances[0]!.onopen?.();
    FakeSocket.instances[0]!.onclose?.({ code: 4403 });
    expect(useCanvasStore.getState().workspace).toBeNull();
    expect(info).toHaveBeenCalledWith("「共享项目」已不再共享给你");
    release();
  });

  it("别的关闭码只是断线，留在原处", () => {
    useCanvasStore
      .getState()
      .setWorkspace({ id: WORKSPACE, name: "共享项目" } as never);
    renderHook(() => useWorkspaceAccessLost());
    const release = connectWorkspaceEvents(WORKSPACE);
    FakeSocket.instances[0]!.onclose?.({ code: 1006 });
    expect(useCanvasStore.getState().workspace?.id).toBe(WORKSPACE);
    expect(info).not.toHaveBeenCalled();
    release();
  });
});
