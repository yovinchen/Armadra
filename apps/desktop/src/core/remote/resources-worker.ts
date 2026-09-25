/**
 * Worker 这一侧的资源读取：一轮请求，答这台主机的总览加上若干 SSH 会话的进程树。
 *
 * 设计要求「远端合并为一轮读取、无逐 PID SSH」：控制端把这一轮要测的会话连同
 * 各自 `ssh` 客户端的本地端口一次发来，这里做一次 `ps` 全表、一次连接表，对上
 * 之后按本机同一套规矩算（`resources/sample.ts`）：RSS 按树求和并标为估计、
 * `(pid, 启动时间)` 去重、CPU 要两次样本——采样器存在 Worker 会话里，所以第二轮
 * 起才有 CPU，第一轮如实是 `null`。
 */

import { cpus, homedir } from "node:os";
import {
  memoryPressure,
  powerSource,
  swapUsage,
} from "../resources/platform-probe";
import {
  type HostResources,
  type ProcessRow,
  type SessionResources,
  Sampler,
  childrenByParent,
  cpuPercent,
  hostResources,
  round,
  sessionResources,
} from "../resources/sample";
import { ownConnections } from "../resources/sockets";
import type { WorkerSession } from "./session";

/** 控制端要测的一个会话。 */
export interface RemoteSessionQuery {
  readonly sessionId: string;
  /** 本机 `ssh` 客户端连出去用的端口；不知道就是 `null`。 */
  readonly clientPort: number | null;
}

/** 一个会话在远端量到的东西；`unknownReason` 非空时数字都是 `null`。 */
export type RemoteSessionMetrics = Pick<
  SessionResources,
  | "cpuPercent"
  | "memoryBytes"
  | "memoryEstimated"
  | "childCount"
  | "state"
  | "startTimeUnixMs"
  | "children"
  | "unknownReason"
> & { readonly sessionId: string; readonly pid: number | null };

export interface RemoteResourceRead {
  readonly host: HostResources;
  readonly sessions: readonly RemoteSessionMetrics[];
}

function parseQueries(raw: readonly unknown[]): RemoteSessionQuery[] {
  const queries: RemoteSessionQuery[] = [];
  for (const entry of raw.slice(0, 256)) {
    if (typeof entry !== "object" || entry === null) continue;
    const value = entry as Record<string, unknown>;
    if (typeof value.sessionId !== "string") continue;
    const port = value.clientPort;
    queries.push({
      sessionId: value.sessionId,
      clientPort:
        typeof port === "number" && Number.isInteger(port) && port > 0
          ? port
          : null,
    });
  }
  return queries;
}

/** 全机 CPU：所有进程的 CPU 差之和除以核数；没有基线是 `null`。 */
function hostCpu(
  table: Map<number, ProcessRow>,
  previous: Map<number, ProcessRow> | undefined,
  elapsedMs: number,
  cores: number,
): number | null {
  if (previous === undefined || cores <= 0) return null;
  let total = 0;
  let known = false;
  for (const row of table.values()) {
    const percent = cpuPercent(row, previous, elapsedMs);
    if (percent !== null) {
      total += percent;
      known = true;
    }
  }
  return known ? round(Math.min(total / cores, 100)) : null;
}

/**
 * 握着对端端口为 `clientPort` 的连接的进程里最靠上的那个——`sshd` 的用户会话
 * 进程。有两个互不为祖先的候选就是对不上，不挑一个。
 */
function leaderFor(
  clientPort: number,
  holders: ReadonlyMap<number, number[]>,
  table: Map<number, ProcessRow>,
): number | undefined {
  const pids = [...new Set(holders.get(clientPort) ?? [])].filter((pid) =>
    table.has(pid),
  );
  if (pids.length === 0) return undefined;
  const set = new Set(pids);
  const tops = pids.filter((pid) => {
    let parent = table.get(pid)?.parent;
    const visited = new Set<number>();
    while (parent !== undefined && parent > 1 && !visited.has(parent)) {
      if (set.has(parent)) return false;
      visited.add(parent);
      parent = table.get(parent)?.parent;
    }
    return true;
  });
  return tops.length === 1 ? tops[0] : undefined;
}

export function readRemoteResources(
  session: WorkerSession,
  raw: readonly unknown[],
): RemoteResourceRead {
  const sampler = session.slot("resources.sampler", () => new Sampler());
  const queries = parseQueries(raw);
  const refresh = sampler.refresh();
  const children = childrenByParent(refresh.table);
  const cores = cpus().length;
  const sampledAt = new Date(refresh.atMs).toISOString();
  const host = hostResources({
    dataDir: homedir(),
    cpuCores: cores,
    pressure: memoryPressure(),
    power: powerSource(),
    swap: swapUsage(),
    cpuPercent: hostCpu(
      refresh.table,
      refresh.previousTable,
      refresh.elapsedMs,
      cores,
    ),
    sampledAt,
  });

  const wanted = queries.some((query) => query.clientPort !== null);
  const connections = wanted ? ownConnections() : [];
  const holders = new Map<number, number[]>();
  for (const connection of connections ?? []) {
    const list = holders.get(connection.remotePort) ?? [];
    list.push(connection.pid);
    holders.set(connection.remotePort, list);
  }

  const sessions = queries.map((query): RemoteSessionMetrics => {
    const unknown: RemoteSessionMetrics = {
      sessionId: query.sessionId,
      pid: null,
      cpuPercent: null,
      memoryBytes: null,
      memoryEstimated: false,
      childCount: null,
      state: null,
      startTimeUnixMs: null,
      children: [],
      unknownReason: "remote",
    };
    if (query.clientPort === null || connections === undefined) return unknown;
    const leader = leaderFor(query.clientPort, holders, refresh.table);
    if (leader === undefined) return unknown;
    const measured = sessionResources(
      {
        sessionId: query.sessionId,
        sessionKey: "",
        workspaceId: "",
        nodeId: null,
        generation: 0,
        backend: "tmux",
        cwd: "",
        pid: leader,
        exited: false,
        remote: false,
      },
      refresh,
      refresh.previousTable,
      refresh.elapsedMs,
      children,
    );
    return {
      sessionId: query.sessionId,
      pid: leader,
      cpuPercent: measured.cpuPercent,
      memoryBytes: measured.memoryBytes,
      memoryEstimated: measured.memoryEstimated,
      childCount: measured.childCount,
      state: measured.state,
      startTimeUnixMs: measured.startTimeUnixMs,
      children: measured.children,
      unknownReason: measured.unknownReason,
    };
  });
  return { host, sessions };
}
