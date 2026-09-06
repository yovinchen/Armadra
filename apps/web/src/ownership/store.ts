import { create } from "zustand";

import { runtimeApi, type OwnershipDomainRecord } from "../api/client";
import {
  canvasOwnershipStatus,
  statusOf,
  type CanvasOwnershipStatus,
} from "../canvas-ownership/store";

/**
 * 六个业务域各自的写归属（Go Host 业务所有权迁移 §2.2）。
 *
 * 画布域的探测早就有了（`canvas-ownership/store`），它决定画布往哪边写。
 * 这里是同一份记录的**全貌**：其余五个域现在都还由 Runtime 写，界面要能
 * 如实说出来，而不是让人从「画布归 Host」推断别的域也搬过去了。
 *
 * 每档都是真状态。`maintenance` 是切换窗口开着——两边都拒绝写；`error` 是
 * 探不到，同样不能画成「一切正常」。
 */
export const OWNERSHIP_DOMAINS = [
  "canvas",
  "settings",
  "filesystem",
  "session",
  "agent",
  "git",
] as const;

export type OwnershipDomainName = (typeof OWNERSHIP_DOMAINS)[number];

export interface OwnershipDomainState {
  domain: OwnershipDomainName;
  status: CanvasOwnershipStatus;
  /** u64，切换时单调递增；比较用 bigint，不经过 number。 */
  epoch: bigint;
  /** 稳定的可本地化键，例如 `ownership.switch.verified`；不是路径。 */
  reasonCode: string;
  updatedAt: string;
}

export interface OwnershipState {
  /** 还没探到时是空数组，界面据此显示「未知」而不是「全归 Runtime」。 */
  domains: OwnershipDomainState[];
  /** 整份读取失败：谁在写这件事已经不确定，不能按上一次的结果显示。 */
  failed: boolean;
  probing: boolean;
  probe: () => Promise<OwnershipDomainState[]>;
  reset: () => void;
}

function toState(record: OwnershipDomainRecord): OwnershipDomainState {
  return {
    domain: record.domain,
    status: statusOf(record),
    epoch: record.epoch,
    reasonCode: record.reasonCode,
    updatedAt: record.updatedAt,
  };
}

export const useOwnership = create<OwnershipState>((set) => {
  let pending: Promise<OwnershipDomainState[]> | null = null;
  return {
    domains: [],
    failed: false,
    probing: false,

    /**
     * 设置页打开时跑一次。并发调用共用同一次请求：六行状态不该变成六次探测。
     */
    probe: () => {
      if (pending) return pending;
      set({ probing: true });
      // 同步抛出（旧 Runtime 没有这个端点、或客户端被换过）也要落到失败档，
      // 而不是把异常扔进渲染。
      let request: Promise<OwnershipDomainRecord[]>;
      try {
        request = runtimeApi.ownershipDomains();
      } catch (error) {
        request = Promise.reject(error);
      }
      pending = request
        .then((records) => {
          const domains = records.map(toState);
          set({ domains, failed: false, probing: false });
          return domains;
        })
        .catch(() => {
          // 保留上一次的列表没有意义：它可能已经不是现在的归属了。
          set({ domains: [], failed: true, probing: false });
          return [] as OwnershipDomainState[];
        })
        .finally(() => {
          pending = null;
        });
      return pending;
    },

    reset: () => {
      pending = null;
      set({ domains: [], failed: false, probing: false });
    },
  };
});

/**
 * 画布那一档以画布自己的探测为准。
 *
 * 两处读的是同一条记录，但画布探测是写入路由的依据，随 `ownership_moved`
 * 立刻重探；这份列表是设置页里的一次性快照。冲突时以前者为准，免得设置页
 * 显示的和实际写入方向不一致。
 */
export function domainStatus(
  domain: OwnershipDomainName,
  domains: OwnershipDomainState[],
): CanvasOwnershipStatus {
  if (domain === "canvas") {
    const canvas = canvasOwnershipStatus();
    if (canvas !== "unknown") return canvas;
  }
  return domains.find((entry) => entry.domain === domain)?.status ?? "unknown";
}

/**
 * 设置域此刻的档位，供设置网关与设置页共用一份判断。
 *
 * 整份读取失败时是 `error` 而不是 `unknown`：两者都禁写，但要用户做的事不同
 * ——「还没探到」等一会儿就有结果，「读不到归属记录」得先把 Runtime 接上。
 * 正在探测、还没有结果时仍然是 `unknown`，那确实是「还不知道」。
 */
export function settingsStatus(
  state: Pick<OwnershipState, "domains" | "failed"> = useOwnership.getState(),
): CanvasOwnershipStatus {
  if (state.failed) return "error";
  return domainStatus("settings", state.domains);
}
