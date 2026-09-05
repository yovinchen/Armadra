import { create } from "zustand";

import { runtimeApi, type CanvasOwnershipRecord } from "../api/client";

/**
 * 画布写归属（H01 §4）。
 *
 * 五个状态都是真状态，没有「大概没事」这一档：
 *  - `unknown`：还没探到。此时既不写 Runtime 也不写 Host，界面也不能
 *    显示成「已保存」——那会把没落盘的改动说成落盘了。
 *  - `runtime` / `host`：写走对应那一侧，**永远只走一侧**，没有双写。
 *  - `maintenance`：切换窗口开着，两边都拒绝写。画布只读。
 *  - `error`：探测失败。同样禁写，并且不能渲染成空画布。
 */
export type CanvasOwnershipStatus =
  | "unknown"
  | "runtime"
  | "host"
  | "maintenance"
  | "error";

/** 只有归属已经落定时才允许写；其余三档一律禁写。 */
export function canEditCanvas(
  status: CanvasOwnershipStatus,
): status is "runtime" | "host" {
  return status === "runtime" || status === "host";
}

/**
 * 归属记录 → 界面档位。只看 owner 与 phase，不看域：六个域的记录形状一样，
 * 设置页里的其余五个域用的是同一条规则。
 */
export function statusOf(
  record: Pick<CanvasOwnershipRecord, "owner" | "phase">,
): CanvasOwnershipStatus {
  if (record.phase !== "settled") return "maintenance";
  return record.owner === "host" ? "host" : "runtime";
}

export interface CanvasOwnershipState {
  status: CanvasOwnershipStatus;
  /** u64，切换时单调递增；比较用 bigint，不经过 number。 */
  epoch: bigint | null;
  /** 稳定的可本地化键，例如 `ownership.switch.verified`；不是路径。 */
  reasonCode: string;
  /** 探测正在飞行中；同一时刻只允许一次。 */
  probing: boolean;
  probe: () => Promise<CanvasOwnershipStatus>;
  reset: () => void;
}

export const useCanvasOwnership = create<CanvasOwnershipState>((set, get) => {
  let pending: Promise<CanvasOwnershipStatus> | null = null;
  return {
    status: "unknown",
    epoch: null,
    reasonCode: "",
    probing: false,

    /**
     * 启动时跑一次，`ownership_moved` 之后再跑一次。
     *
     * 并发调用共用同一次请求：一次维护窗口里几十个节点同时撞上 409，
     * 不该变成几十次探测。
     */
    probe: () => {
      if (pending) return pending;
      set({ probing: true });
      // 同步抛出（旧 Runtime 没有这个端点、或客户端被替换过）也要落到
      // `error`，而不是把异常扔进渲染；同时处理器要当场挂上，别让这个
      // 拒绝在微任务队列里裸奔一轮。
      let request: Promise<CanvasOwnershipRecord>;
      try {
        request = runtimeApi.canvasOwnership();
      } catch (error) {
        request = Promise.reject(error);
      }
      pending = request
        .then((record) => {
          const status = statusOf(record);
          set({
            status,
            epoch: record.epoch,
            reasonCode: record.reasonCode,
            probing: false,
          });
          return status;
        })
        .catch(() => {
          // 探不到就是探不到。保留上一次的纪元没有意义：谁在写这件事
          // 已经不确定了，写入必须停下。
          set({ status: "error" as const, probing: false });
          return "error" as const;
        })
        .finally(() => {
          pending = null;
        });
      return pending;
    },

    reset: () => {
      pending = null;
      set({ status: "unknown", epoch: null, reasonCode: "", probing: false });
    },
  };
});

/** 非 React 处（保存队列、网关）用这个读当前档位。 */
export function canvasOwnershipStatus(): CanvasOwnershipStatus {
  return useCanvasOwnership.getState().status;
}
