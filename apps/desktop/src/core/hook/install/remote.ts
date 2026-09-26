import { createHash } from "node:crypto";
import { posix } from "node:path";
import { posixQuote } from "../../terminal/shell";
import { render as renderEndpoint } from "../endpoint";
import { CLIENT_NAME } from "./events";
import {
  INJECTED_AGENTS,
  artifactFiles,
  artifactLayout,
  injectionFromLayout,
} from "./inject";
import { hookCommand } from "./shared";
import { skillContent } from "./skills";

/**
 * 画布注入的远端那一份：SSH 终端里起的 CLI 读到的插件、扩展、技能、说明与
 * Hook 客户端（docs/design/remote-canvas-injection.md）。
 *
 * 本机那份在 `<数据目录>/integration/<cli>/`（`inject.ts`），路径是控制端这台
 * 机器的；SSH 终端里的 CLI 跑在执行主机上，那些路径在那边不存在。这里按同一套
 * `artifactFiles` 生成同样的产物，只是根换成执行主机上 Worker 答的目录
 * （`<Worker 状态目录>/integration/<版本>/`），路径一律 POSIX，Hook 客户端换成
 * 同步过去的 `armadra-hook.js` 与一个用远端 node 跑它的启动器。
 *
 * 启动行不带任何注入的词：远端每个 CLI 有一个同名的垫片（`shims/<cli>`），画布
 * 终端的 `PATH` 把垫片目录放在最前面，垫片从 `PATH` 里去掉自己再 `exec` 真的
 * CLI，并在参数后面接上注入的 argv、在环境里放上注入的变量。于是页面、依赖编排、
 * 节能唤醒拼的都是一行 `claude …`，与远端家目录在哪、同步有没有成功都无关——
 * 同步失败时没有垫片，CLI 照常不带注入启动。
 *
 * 纯函数：只根据 Worker 答的位置与控制端这份 Hook 客户端生成文件，不碰磁盘。
 */

/** Worker 为画布注入答的位置（`integration.locate`）。 */
export interface RemoteIntegrationSite {
  /** 注入产物的根目录，绝对 POSIX 路径。 */
  readonly root: string;
  /** Worker 自己跑在的那个 node：远端一定有它。 */
  readonly node: string;
  /** Worker 为这个控制端开的 Hook 中继 socket。 */
  readonly socket: string;
  /** 这个控制端的端点文件。 */
  readonly endpointFile: string;
  /** 节点令牌目录。 */
  readonly tokenDir: string;
}

/** 一个要落在执行主机上的文件。 */
export interface RemoteFile {
  /** 绝对 POSIX 路径，都在 {@link RemoteIntegrationSite.root} 之下。 */
  readonly path: string;
  readonly content: string;
  readonly mode: number;
  readonly sha256: string;
}

/**
 * 端点文件里的令牌。远端不拿控制端 Hook 服务的应用令牌：中继在控制端转发时
 * 换上真的（`remote/integration.ts`），执行主机上只剩这个占位，泄露了也调不动
 * 控制端任何东西——能连上中继 socket 的本来就只有 Worker 所属的那个用户。
 */
export const RELAY_TOKEN = "relay";

/** 垫片所在的目录。 */
export function shimDirectory(root: string): string {
  return posix.join(root, "shims");
}

/** 远端 Hook 客户端的启动器路径。 */
export function remoteClientBin(root: string): string {
  return posix.join(root, "bin", CLIENT_NAME);
}

function digest(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function file(path: string, content: string, mode = 0o644): RemoteFile {
  return { path, content, mode, sha256: digest(content) };
}

/**
 * 远端的启动器：用 Worker 那个 node 跑同步过去的包。不设
 * `ELECTRON_RUN_AS_NODE`——远端没有 Electron，跑的就是 node。
 */
function launcher(node: string, bundle: string): string {
  return [
    "#!/bin/sh",
    "# Armadra Hook 客户端（执行主机）。由控制端生成，改动会被覆盖。",
    `exec ${posixQuote(node)} ${posixQuote(bundle)} "$@"`,
    "",
  ].join("\n");
}

/**
 * 一个 CLI 的垫片。
 *
 * 先把垫片目录从 `PATH` 里摘掉：真 CLI 由此找得到，它再起的同名程序也不会又
 * 被注入一遍。注入的 argv 接在调用者的参数之后——与本机启动行的顺序一致：
 * `codex resume <id>` 的子命令必须在前面，`-c` 在子命令之后 Codex 也认。
 */
function shim(
  agentId: string,
  shims: string,
  args: readonly string[],
  env: readonly (readonly [string, string])[],
): string {
  const lines = [
    "#!/bin/sh",
    `# Armadra 画布注入（${agentId}）：只在画布的 SSH 终端里排在 PATH 最前面。`,
    "# 由控制端生成，改动会被覆盖。",
    `shims=${posixQuote(shims)}`,
    "rest=",
    "set -f",
    "old_ifs=$IFS",
    "IFS=:",
    "for entry in $PATH; do",
    '  [ "$entry" = "$shims" ] && continue',
    '  rest="${rest:+$rest:}$entry"',
    "done",
    "IFS=$old_ifs",
    "set +f",
    "PATH=$rest",
    "export PATH",
  ];
  for (const [key, value] of env) {
    lines.push(`${key}=${posixQuote(value)}`, `export ${key}`);
  }
  const tail = args.map((arg) => posixQuote(arg)).join(" ");
  lines.push(`exec ${agentId} "$@"${tail === "" ? "" : ` ${tail}`}`, "");
  return lines.join("\n");
}

/**
 * 执行主机上画布注入的全部文件：每个 CLI 的产物、垫片、Hook 客户端与它的启动器、
 * 这个控制端的端点文件。确定性的：同一份输入生成同样的字节，Worker 按哈希只写
 * 变了的。
 */
export function remoteIntegrationFiles(
  site: RemoteIntegrationSite,
  hookBundle: string,
): RemoteFile[] {
  const files: RemoteFile[] = [];
  const bundlePath = posix.join(site.root, "cli", `${CLIENT_NAME}.js`);
  const clientBin = remoteClientBin(site.root);
  files.push(file(bundlePath, hookBundle));
  files.push(file(clientBin, launcher(site.node, bundlePath), 0o755));
  files.push(
    file(
      site.endpointFile,
      renderEndpoint({
        socket: site.socket,
        token: RELAY_TOKEN,
        nodeTokenDir: site.tokenDir,
      }),
      0o600,
    ),
  );
  const shims = shimDirectory(site.root);
  const target = { join: posix.join, windows: false };
  for (const agentId of INJECTED_AGENTS) {
    const written = artifactFiles(site.root, agentId, clientBin, target);
    for (const [path, content] of written) files.push(file(path, content));
    const layout = artifactLayout(site.root, agentId, posix.join);
    const present = (path: string | undefined): path is string =>
      path !== undefined && written.has(path);
    const injection = injectionFromLayout(agentId, layout, clientBin, present);
    if (injection === undefined) continue;
    files.push(
      file(
        posix.join(shims, agentId),
        shim(agentId, shims, injection.args, injection.env),
        0o755,
      ),
    );
  }
  return files;
}

/** 这份注入的指纹：文件列表与每个文件的哈希。控制端据此判断要不要再同步。 */
export function fingerprint(files: readonly RemoteFile[]): string {
  const hash = createHash("sha256");
  for (const entry of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(`${entry.path}\0${entry.mode}\0${entry.sha256}\n`);
  }
  return hash.digest("hex");
}

/** 远端 Codex 的信任记录要认的那条命令。 */
export function remoteCodexCommand(root: string): string {
  return hookCommand(remoteClientBin(root), "codex");
}

/** 技能正文还没登记时（协作域没装配）远端也不注入：只有 Hook 没有规则没有意义。 */
export function remoteInjectionReady(): boolean {
  return skillContent() !== undefined;
}
