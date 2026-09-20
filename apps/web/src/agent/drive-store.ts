/**
 * 谁在驱动哪个终端（设计 `agent-delivery.md` §6）。
 *
 * 一份易失镜像，唯一的来源是 `terminal.lease` 那一帧：节点头的徽标、命令面板
 * 的「接管 / 交还」读的是同一个答案。分成两处各自订阅、各自记一份的话，两个
 * 入口迟早会对「现在轮到谁」说两句话。
 *
 * 会话退出就把这一行忘掉：租约的对象是那个 PTY，进程没了，「谁在驱动它」这个
 * 问题就不存在了。
 */
import { create } from "zustand";
import type { DriveLease, WorkspaceEvent } from "@armadra/shared";

export interface NodeDrive {
  readonly sessionId: string;
  readonly lease: DriveLease;
}

interface DriveState {
  readonly drives: Readonly<Record<string, NodeDrive>>;
  handleEvent: (event: WorkspaceEvent) => void;
  reset: () => void;
}

export const useDriveStore = create<DriveState>((set) => ({
  drives: {},
  handleEvent: (event) => {
    if (event.type === "terminal.lease") {
      const nodeId = event.nodeId;
      // 不属于任何节点的终端没有节点头，也没有面板入口。
      if (nodeId === undefined) return;
      set((state) => ({
        drives: {
          ...state.drives,
          [nodeId]: { sessionId: event.sessionId, lease: event.lease },
        },
      }));
      return;
    }
    if (event.type === "terminal.exit" && event.nodeId !== undefined) {
      const nodeId = event.nodeId;
      set((state) => {
        if (state.drives[nodeId] === undefined) return state;
        const drives = { ...state.drives };
        delete drives[nodeId];
        return { drives };
      });
    }
  },
  reset: () => set({ drives: {} }),
}));
