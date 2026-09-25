/**
 * 谁握着哪条 TCP 连接——把一个 SSH 终端和它在远端的那棵进程树对上。
 *
 * SSH 终端在本机只是 tmux 里的一个 `ssh` 客户端；活儿发生在远端 `sshd` 为这条
 * 连接派生的会话进程下面。两端之间唯一共同、又不需要改 `ssh` 命令行或远端
 * `sshd_config` 的东西是这条 TCP 连接本身：
 *
 *   * 控制端问「我的 `ssh` 客户端用哪个本地端口连出去」；
 *   * Worker 问「我这个用户的哪个进程握着一条对端端口正是它的连接」——那是
 *     `sshd` 以用户身份运行的会话进程，shell 与其下的一切都是它的后代。
 *
 * 对不上的情况如实报不知道：经 NAT 改写了源端口、走 `ProxyJump` 或
 * `ControlMaster` 复用连接、机器上没有 `lsof` 也没有 `/proc`。不去猜「大概是
 * 最近起的那个 shell」。
 *
 * 读取优先用 `lsof`（macOS 与多数 Linux 都有），没有时在 Linux 上读 `/proc`。
 */

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, readlinkSync } from "node:fs";

export interface TcpConnection {
  readonly pid: number;
  readonly localPort: number;
  readonly remotePort: number;
}

/** `lsof -F pn` 的输出 → 连接表。只认 `local->remote` 形状的名字。 */
export function parseLsof(output: string): TcpConnection[] {
  const connections: TcpConnection[] = [];
  let pid: number | undefined;
  for (const line of output.split("\n")) {
    if (line.startsWith("p")) {
      const parsed = Number.parseInt(line.slice(1), 10);
      pid = Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
      continue;
    }
    if (!line.startsWith("n") || pid === undefined) continue;
    const match = /:(\d+)->.*:(\d+)$/u.exec(line.slice(1));
    if (match === null) continue;
    connections.push({
      pid,
      localPort: Number(match[1]),
      remotePort: Number(match[2]),
    });
  }
  return connections;
}

function lsof(args: readonly string[]): TcpConnection[] | undefined {
  try {
    const output = execFileSync(
      "lsof",
      ["-nP", "-a", ...args, "-iTCP", "-sTCP:ESTABLISHED", "-Fpn"],
      {
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5_000,
      },
    );
    return parseLsof(output);
  } catch (failure) {
    // 没有匹配时 lsof 以 1 退出、输出为空；那是「没有连接」，不是读不了。
    const status = (failure as { status?: unknown }).status;
    const stdout = (failure as { stdout?: unknown }).stdout;
    if (status === 1) {
      return parseLsof(typeof stdout === "string" ? stdout : "");
    }
    return undefined;
  }
}

/** `/proc/net/tcp{,6}` 的一行：`sl local rem st … inode`。只要已建立的。 */
export function parseProcNet(text: string): Map<string, TcpConnection> {
  const byInode = new Map<string, TcpConnection>();
  for (const line of text.split("\n").slice(1)) {
    const fields = line.trim().split(/\s+/u);
    if (fields.length < 10) continue;
    const [, local, remote, state] = fields;
    const inode = fields[9];
    if (state !== "01" || inode === undefined || inode === "0") continue;
    const localPort = Number.parseInt(local?.split(":")[1] ?? "", 16);
    const remotePort = Number.parseInt(remote?.split(":")[1] ?? "", 16);
    if (!Number.isInteger(localPort) || !Number.isInteger(remotePort)) continue;
    byInode.set(inode, { pid: 0, localPort, remotePort });
  }
  return byInode;
}

function procConnections(
  pids: readonly number[] | undefined,
): TcpConnection[] | undefined {
  if (process.platform !== "linux") return undefined;
  let byInode: Map<string, TcpConnection>;
  try {
    byInode = parseProcNet(readFileSync("/proc/net/tcp", "utf8"));
    try {
      for (const [inode, connection] of parseProcNet(
        readFileSync("/proc/net/tcp6", "utf8"),
      )) {
        byInode.set(inode, connection);
      }
    } catch {
      // 没开 IPv6 的机器没有这个文件。
    }
  } catch {
    return undefined;
  }
  const candidates =
    pids ??
    readdirSync("/proc")
      .map((name) => Number.parseInt(name, 10))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  const connections: TcpConnection[] = [];
  for (const pid of candidates) {
    let descriptors: string[];
    try {
      descriptors = readdirSync(`/proc/${pid}/fd`);
    } catch {
      // 别的用户的进程读不了 fd 目录，这正是我们要的边界。
      continue;
    }
    for (const descriptor of descriptors) {
      let target: string;
      try {
        target = readlinkSync(`/proc/${pid}/fd/${descriptor}`);
      } catch {
        continue;
      }
      const match = /^socket:\[(\d+)\]$/u.exec(target);
      const connection = match === null ? undefined : byInode.get(match[1]!);
      if (connection !== undefined) connections.push({ ...connection, pid });
    }
  }
  return connections;
}

/** 这几个进程握着的已建立 TCP 连接；读不了是 `undefined`。 */
export function connectionsOf(
  pids: readonly number[],
): TcpConnection[] | undefined {
  if (pids.length === 0) return [];
  if (process.platform === "win32") return undefined;
  return lsof(["-p", pids.join(",")]) ?? procConnections(pids);
}

/** 当前用户的全部进程握着的已建立 TCP 连接；读不了是 `undefined`。 */
export function ownConnections(): TcpConnection[] | undefined {
  if (process.platform === "win32") return undefined;
  const uid = process.getuid?.();
  if (uid === undefined) return undefined;
  return lsof(["-u", String(uid)]) ?? procConnections(undefined);
}
