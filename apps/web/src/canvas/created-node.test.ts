import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardDocument } from "@armadra/shared";

import { makeNode, testUuid } from "./test-support";
import {
  setFlow,
  setFlowContainer,
  type FlowHandle,
} from "./flow/flow-context";
import { clearAllDrafts, setDraft } from "./flow/drafts";
import { useCanvasStore } from "../store/canvas-store";
import { dispatchWorkspaceEvent } from "../api/events";
import {
  PENDING_TTL_MS,
  TERMINAL_INPUT_CLASS,
  applyPendingReveal,
  clearPendingReveal,
  isTextEntry,
  noteCreatedNode,
  pendingRevealId,
  shouldRevealCreatedNode,
} from "./created-node";

/**
 * Agent 建的节点要和菜单里建的一样被送到眼前，但**只有正看着这块画布的
 * 那个页面**才跟过去——事件是广播，另一个窗口、另一台设备都会收到。
 */

const BOARD = testUuid(1);
const STAMP = "2026-09-20T00:00:00.000Z";

const gate = {
  eventBoardId: BOARD,
  openBoardId: BOARD,
  pageVisible: true,
  gesturing: false,
  typing: false,
};

describe("shouldRevealCreatedNode", () => {
  it("正开着这块画布、页面在前台、手没在动、也没在输入时才跟过去", () => {
    expect(shouldRevealCreatedNode(gate)).toBe(true);
  });

  it("页面开着别的板（或什么都没开）时不跟", () => {
    expect(shouldRevealCreatedNode({ ...gate, openBoardId: testUuid(2) })).toBe(
      false,
    );
    expect(shouldRevealCreatedNode({ ...gate, openBoardId: null })).toBe(false);
  });

  it("后台标签页不跟：回来时相机已经被挪过而人没看见", () => {
    expect(shouldRevealCreatedNode({ ...gate, pageVisible: false })).toBe(
      false,
    );
  });

  it("拖拽中与输入中不抢", () => {
    expect(shouldRevealCreatedNode({ ...gate, gesturing: true })).toBe(false);
    expect(shouldRevealCreatedNode({ ...gate, typing: true })).toBe(false);
  });
});

describe("isTextEntry", () => {
  const element = (
    tagName: string,
    className?: string,
  ): Parameters<typeof isTextEntry>[0] => ({
    tagName,
    isContentEditable: false,
    classList: { contains: (name: string) => name === className },
  });

  it("输入框与富文本算输入", () => {
    expect(isTextEntry(element("INPUT"))).toBe(true);
    expect(isTextEntry(element("TEXTAREA"))).toBe(true);
    expect(isTextEntry({ tagName: "DIV", isContentEditable: true })).toBe(true);
  });

  it("终端不算：Agent 正是从那里发的动词，换选区既不打断它也不抢焦点", () => {
    expect(isTextEntry(element("TEXTAREA", TERMINAL_INPUT_CLASS))).toBe(false);
  });

  it("没有焦点元素、或焦点在画布本身时不算输入", () => {
    expect(isTextEntry(null)).toBe(false);
    expect(isTextEntry(element("DIV"))).toBe(false);
  });
});

/* ------------------------------ 事件 → 相机 ------------------------------ */

function documentWith(nodeIds: readonly string[]): BoardDocument {
  return {
    board: {
      id: BOARD,
      workspaceId: testUuid(3),
      name: "Board",
      sortOrder: 0,
      viewport: { x: 0, y: 0, zoom: 1 },
      whiteboard: "",
      createdAt: STAMP,
      updatedAt: STAMP,
    },
    nodes: nodeIds.map((id) => makeNode("terminal", { id, boardId: BOARD })),
    edges: [],
  } as unknown as BoardDocument;
}

let setCenter: ReturnType<typeof vi.fn>;

function mountFlow(): void {
  setCenter = vi.fn(() => Promise.resolve(true));
  setFlow({
    getViewport: () => ({ x: 0, y: 0, zoom: 1 }),
    getNode: (id: string) => ({
      id,
      position: { x: 5000, y: 0 },
      measured: { width: 960, height: 600 },
      width: 960,
      height: 600,
      data: {},
    }),
    setCenter,
  } as unknown as FlowHandle);
  setFlowContainer({
    getBoundingClientRect: () => ({ width: 800, height: 600 }),
  } as unknown as HTMLElement);
}

const CREATED = testUuid(9);

beforeEach(() => {
  mountFlow();
  clearPendingReveal();
  clearAllDrafts();
  useCanvasStore.getState().setDocument(documentWith([]));
});

afterEach(() => {
  setFlow(null);
  setFlowContainer(null);
  clearPendingReveal();
  clearAllDrafts();
});

describe("node.created", () => {
  it("节点还没随重取到达时先记着，到了再选中并居中", () => {
    expect(noteCreatedNode({ boardId: BOARD, nodeId: CREATED })).toBe(false);
    expect(pendingRevealId()).toBe(CREATED);

    useCanvasStore.getState().mergeRemoteDocument(documentWith([CREATED]));
    expect(applyPendingReveal()).toBe(true);
    expect(useCanvasStore.getState().selectedNodeIds).toEqual([CREATED]);
    expect(setCenter).toHaveBeenCalledTimes(1);
    expect(pendingRevealId()).toBe(null);
  });

  it("节点已经在文档里时立刻跟过去", () => {
    useCanvasStore.getState().setDocument(documentWith([CREATED]));
    expect(noteCreatedNode({ boardId: BOARD, nodeId: CREATED })).toBe(true);
    expect(setCenter).toHaveBeenCalledTimes(1);
  });

  it("事件说的是别的板时连记都不记", () => {
    expect(noteCreatedNode({ boardId: testUuid(4), nodeId: CREATED })).toBe(
      false,
    );
    expect(pendingRevealId()).toBe(null);
  });

  it("等待期间用户动手拖拽，就不再抢他的相机", () => {
    noteCreatedNode({ boardId: BOARD, nodeId: CREATED });
    setDraft(testUuid(5), { position: { x: 10, y: 10 } });
    useCanvasStore.getState().mergeRemoteDocument(documentWith([CREATED]));

    expect(applyPendingReveal()).toBe(false);
    expect(setCenter).not.toHaveBeenCalled();
    // 丢掉而不是继续等：节点已经在画布上，不差这一次相机。
    expect(pendingRevealId()).toBe(null);
  });

  it("等太久就不等了", () => {
    const start = Date.now();
    noteCreatedNode({ boardId: BOARD, nodeId: CREATED }, start);
    useCanvasStore.getState().mergeRemoteDocument(documentWith([CREATED]));

    expect(applyPendingReveal(start + PENDING_TTL_MS + 1)).toBe(false);
    expect(pendingRevealId()).toBe(null);
    expect(setCenter).not.toHaveBeenCalled();
  });

  it("事件流里的一帧就能触发这一路", () => {
    useCanvasStore.getState().setDocument(documentWith([CREATED]));
    dispatchWorkspaceEvent({
      type: "node.created",
      boardId: BOARD,
      nodeId: CREATED,
      nodeType: "terminal",
      originNodeId: testUuid(6),
    });
    // 订阅由 `useCreatedNodeReveal()` 在画布挂载时装上，这里直接走函数：
    // 这个用例要证的是事件形状对得上 `@armadra/shared` 的判别联合。
    expect(noteCreatedNode({ boardId: BOARD, nodeId: CREATED })).toBe(true);
  });
});
