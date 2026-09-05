import {
  adoptedSessionSchema,
  powerLeaseRequestSchema,
  powerLeaseSchema,
  powerStateSchema,
  resourceSnapshotSchema,
  resourceSubscriptionSchema,
  type PowerLeaseRequest,
} from "@armadra/shared";
import { json, noContentSchema, query, request } from "./request";

export const resourcesApi = {
  /* ----------------------------------- 资源 ----------------------------- */
  /**
   * 一次即时采样（T02，终端宿主设计 §8）。
   *
   * Runtime 会在这条请求里先垫一次 CPU 基线再采，所以首屏拿到的是真实
   * 数字而不是「第一次刷新恒为 0」。测不出来的指标是 `null`，面板显示
   * 短横，绝不显示 0。
   */
  resources: (workspaceId: string, signal?: AbortSignal) =>
    request(
      `/api/workspaces/${workspaceId}/resources`,
      resourceSnapshotSchema,
      {
        signal,
      },
    ),
  /**
   * 订阅 / 续约。**只有拿着订阅的时候 Runtime 才采样**：面板关掉后最后一份
   * 订阅过期，采样循环自己停下，不占 CPU。带上上次的 `subscriptionId` 就是
   * 续约；已经过期的 id 不算错，Runtime 会发一个新的回来。
   */
  subscribeResources: (
    workspaceId: string,
    subscriptionId?: string,
    /**
     * 这份订阅自己要的节奏，毫秒。离屏的节点徽标要慢的（30s）；不传就是
     * 设置里的那档。Runtime 把它夹在 `[resources.intervalMs, 60s]`：可以要
     * 得更少，要不到更多。
     */
    intervalMs?: number,
  ) =>
    request(
      `/api/workspaces/${workspaceId}/resources/subscription`,
      resourceSubscriptionSchema,
      {
        method: "POST",
        ...json({
          ...(subscriptionId ? { subscriptionId } : {}),
          ...(intervalMs ? { intervalMs } : {}),
        }),
      },
    ),
  unsubscribeResources: (workspaceId: string, subscriptionId: string) =>
    request(
      `/api/workspaces/${workspaceId}/resources/subscription/${query(subscriptionId)}`,
      noContentSchema,
      { method: "DELETE" },
    ),
  /**
   * 认领孤立会话：Runtime 把行重新绑回去，并告诉前端**该用哪个 nodeId**
   * 建节点——那就是会话自己的 key，所以恢复出来的节点拥有的正是原来那个
   * 会话。节点本身还是画布建、随画布保存。
   */
  adoptOrphanSession: (workspaceId: string, sessionId: string) =>
    request(
      `/api/workspaces/${workspaceId}/resources/orphans/${query(sessionId)}/adopt`,
      adoptedSessionSchema,
      { method: "POST" },
    ),
  /** 终止孤立会话；`orphanId` 是 `session:<id>` 或 `ref:<名字>`。 */
  terminateOrphanSession: (workspaceId: string, orphanId: string) =>
    request(
      `/api/workspaces/${workspaceId}/resources/orphans/${query(orphanId)}/terminate`,
      noContentSchema,
      { method: "POST" },
    ),

  /* --------------------------------- 防休眠 ------------------------------ */
  /** 当前策略、生效机制与全部租约（T02，设计 §9）。 */
  power: () => request("/api/power", powerStateSchema),
  /**
   * 申请租约。请求合法就一定回一个租约——**是否真的生效**看 `active` 与
   * `blockedBy`：被策略挡下的申请照样记录、照样显示，否则「为什么跑一半
   * 睡过去了」就没地方查。
   */
  acquirePowerLease: (input: PowerLeaseRequest) =>
    request("/api/power/leases", powerLeaseSchema, {
      method: "POST",
      ...json(powerLeaseRequestSchema.parse(input)),
    }),
  renewPowerLease: (leaseId: string, ttlSeconds?: number) =>
    request(`/api/power/leases/${query(leaseId)}/renew`, powerLeaseSchema, {
      method: "POST",
      ...json(ttlSeconds === undefined ? {} : { ttlSeconds }),
    }),
  releasePowerLease: (leaseId: string) =>
    request(`/api/power/leases/${query(leaseId)}`, powerStateSchema, {
      method: "DELETE",
    }),
};
