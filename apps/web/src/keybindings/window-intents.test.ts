import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearCanvasCommands,
  registerCanvasCommand,
} from "../canvas/commands";
import { useCanvasStore } from "../store/canvas-store";
import { subscribeWindowIntents } from "./window-intents";

/**
 * 壳的两条窗口事件，页面这一半。
 *
 * 以前两条都没人订阅：⌘W 直接把整个窗口藏了，通知点开也不会选中节点。
 * 这里钉住的是「先问页面」这条路真的接通了——**每一个 intent 都必须回一次
 * 答复**，因为「没接住」正是壳去关窗的信号。
 */

const intentListeners: ((intent: string, token: string) => void)[] = [];
const clickListeners: ((event: { nodeId: string }) => void)[] = [];
const answers: { token: string; handled: boolean }[] = [];

function installBridge(): void {
  Object.defineProperty(window, "armadra", {
    value: {
      window: {
        onKeyIntent: (listener: (intent: string, token: string) => void) => {
          intentListeners.push(listener);
          return () => intentListeners.splice(0, intentListeners.length);
        },
        onNotificationClick: (listener: (event: { nodeId: string }) => void) => {
          clickListeners.push(listener);
          return () => clickListeners.splice(0, clickListeners.length);
        },
        resolveKeyIntent: async (token: string, handled: boolean) => {
          answers.push({ token, handled });
          return { ok: true };
        },
      },
    },
    configurable: true,
    writable: true,
  });
}

beforeEach(() => {
  intentListeners.length = 0;
  clickListeners.length = 0;
  answers.length = 0;
  clearCanvasCommands();
  // 选中会按当前文档过滤，所以得有一份最小文档。
  useCanvasStore.setState({
    selectedNodeIds: [],
    focusNodeId: null,
    document: {
      nodes: [{ id: "node-1" }, { id: "node-7" }, { id: "node-9" }],
    } as never,
  });
});

afterEach(() => {
  Reflect.deleteProperty(
    window as unknown as Record<string, unknown>,
    "armadra",
  );
  clearCanvasCommands();
  vi.restoreAllMocks();
});

describe("⌘W 的意图", () => {
  it("有选中节点时关节点，并回「接了」", async () => {
    const closed = vi.fn();
    registerCanvasCommand("canvas.closeNode", closed);
    useCanvasStore.setState({ selectedNodeIds: ["node-1"] });
    installBridge();
    subscribeWindowIntents();

    intentListeners[0]?.("close-window", "intent-1");
    await Promise.resolve();

    expect(closed).toHaveBeenCalledTimes(1);
    expect(answers).toEqual([{ token: "intent-1", handled: true }]);
  });

  it("没有节点可关时回「没接」，壳才好去关窗", async () => {
    registerCanvasCommand("canvas.closeNode", vi.fn());
    installBridge();
    subscribeWindowIntents();

    intentListeners[0]?.("close-window", "intent-2");
    await Promise.resolve();

    expect(answers).toEqual([{ token: "intent-2", handled: false }]);
  });

  it("画布还没挂载时也回「没接」，不假装关了个节点", async () => {
    // 命令表是空的（启动瞬间、单测）：这时候没人接得住。
    useCanvasStore.setState({ selectedNodeIds: ["node-1"] });
    installBridge();
    subscribeWindowIntents();

    intentListeners[0]?.("close-window", "intent-3");
    await Promise.resolve();

    expect(answers).toEqual([{ token: "intent-3", handled: false }]);
  });

  it("专注模式下的那个节点也算，会先被选上", async () => {
    const closed = vi.fn();
    registerCanvasCommand("canvas.closeNode", closed);
    useCanvasStore.setState({ selectedNodeIds: [], focusNodeId: "node-9" });
    installBridge();
    subscribeWindowIntents();

    intentListeners[0]?.("close-window", "intent-4");
    await Promise.resolve();

    expect(useCanvasStore.getState().selectedNodeIds).toEqual(["node-9"]);
    expect(closed).toHaveBeenCalledTimes(1);
    expect(answers).toEqual([{ token: "intent-4", handled: true }]);
  });

  it("不认识的意图一样要回一次", async () => {
    installBridge();
    subscribeWindowIntents();

    intentListeners[0]?.("something-else", "intent-5");
    await Promise.resolve();

    expect(answers).toEqual([{ token: "intent-5", handled: false }]);
  });
});

describe("主进程通知被点开", () => {
  it("选中那个节点", () => {
    installBridge();
    subscribeWindowIntents();

    clickListeners[0]?.({ nodeId: "node-7" });

    expect(useCanvasStore.getState().selectedNodeIds).toEqual(["node-7"]);
  });
});

describe("不在桌面壳里", () => {
  it("什么也不订阅，退订是空操作", () => {
    expect(() => subscribeWindowIntents()()).not.toThrow();
    expect(intentListeners).toEqual([]);
  });
});
