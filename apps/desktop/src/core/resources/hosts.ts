/**
 * 多执行主机的资源快照：在本机那一份上加上远端主机的总览。
 *
 * 快照原来只有一台主机（控制机自己）。一个工作空间可能同时牵涉别的机器——它
 * 本身绑在 SSH 执行主机上，或者画布上开着连向某台主机的 SSH 终端。面板按主机
 * 筛选，就需要每台主机各自的总览：`executionHosts` 列出这个工作空间牵涉到的每台
 * 远端主机，总览来自那台主机上一轮的读取（`remote.ts`）。读不到的主机照样列出，
 * 各项为 `null`——面板上是破折号，不是一台空闲的机器。
 *
 * 做成子类而不是改 `ResourceService.snapshot`：订阅、推送节奏与壳进程计量都不必
 * 知道远端的存在，采样循环调的 `snapshot` 就是这里覆盖的这个。
 */

import type { DatabaseSync } from "node:sqlite";

import type { HostResources } from "./sample";
import { remoteResources } from "./remote";
import {
  ResourceService,
  type ResourceServiceOptions,
  type ResourceSnapshot,
} from "./service";
import { executionHostOf } from "./sessions";

export interface HostAwareSnapshot extends ResourceSnapshot {
  /** 这个工作空间牵涉到的远端主机，按 id 排序；本机的在 `host`。 */
  readonly executionHosts: readonly HostResources[];
}

/** 一台读不到的远端主机：列出来，但每一项都不知道。 */
export function unknownHost(hostId: string, sampledAt: string): HostResources {
  return {
    hostId,
    location: "remote",
    platform: "unknown",
    cpuPercent: null,
    cpuCores: null,
    memory: {
      totalBytes: null,
      usedBytes: null,
      availableBytes: null,
      swapTotalBytes: null,
      swapUsedBytes: null,
      pressure: null,
    },
    loadAverage: null,
    disk: null,
    power: { source: null, batteryPercent: null, charging: null },
    uptimeSeconds: null,
    sampledAt,
  };
}

export class HostAwareResourceService extends ResourceService {
  private readonly database: DatabaseSync;

  constructor(options: ResourceServiceOptions) {
    super(options);
    this.database = options.database;
  }

  override snapshot(workspaceId: string): HostAwareSnapshot {
    const base = super.snapshot(workspaceId);
    const hostIds = new Set<string>();
    const bound = executionHostOf(this.database, workspaceId);
    if (bound !== "") hostIds.add(bound);
    for (const session of base.sessions) {
      if (
        session.executionHostId !== "local" &&
        session.executionHostId !== ""
      ) {
        hostIds.add(session.executionHostId);
      }
    }
    const executionHosts = [...hostIds]
      .sort()
      .map(
        (hostId) =>
          remoteResources.host(hostId) ?? unknownHost(hostId, base.sampledAt),
      );
    return { ...base, executionHosts };
  }
}
