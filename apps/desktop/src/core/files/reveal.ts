import { execFile } from "node:child_process";
import { dirname } from "node:path";
import type { CoreContext } from "../main";
import { answeredAsync } from "../language/routes";
import { resolveInRoot, workspaceRelativePath } from "../workspaces/roots";
import { workspaceId } from "../workspaces/routes";
import {
  DomainError,
  forbidden,
  jsonObject,
  requiredString,
} from "../workspaces/support";
import { getWorkspace } from "../workspaces/table";

/**
 * `POST /api/workspaces/{workspaceId}/reveal` —— 文件树右键「在访达 / 资源管理器
 * 中显示」。
 *
 * 为什么由 core 拉起系统打开器，而不是走壳的 `shell:show-item-in-folder`：壳那条
 * 通道只认数据目录与下载目录（`shell-core/reveal-path.ts`），而且是故意不收工作区
 * 根目录的——壳不知道哪些目录是工作区，让页面自己报根目录等于让白名单说调用方想
 * 听的话。知道工作区根目录在哪的是 core，所以越界判定就在这里做，壳的白名单一个
 * 字也不用放宽。
 *
 * 只在本机工作区上有意义：远端工作区的文件在另一台机器上，这台机器的文件管理器
 * 打不开。服务器壳上 core 不在用户眼前，页面那边就不显示这一项。
 */

/** 在系统文件管理器里定位一个绝对路径要跑的那条命令。 */
export interface RevealCommand {
  readonly file: string;
  readonly args: readonly string[];
}

/**
 * PURE. 按平台选打开器。
 *
 * macOS 的 `open -R` 与 Windows 的 `explorer.exe /select,` 都能选中那一项；
 * Linux 没有统一的「选中」协议，退一步打开它所在的目录。
 */
export function revealCommand(
  platform: NodeJS.Platform,
  path: string,
): RevealCommand {
  if (platform === "darwin") return { file: "open", args: ["-R", path] };
  if (platform === "win32") {
    // `/select,<path>` 必须是一个参数：逗号后面不能有空格，路径里的空格由
    // execFile 的引号规则处理，不经过任何 shell。
    return { file: "explorer.exe", args: [`/select,${path}`] };
  }
  return { file: "xdg-open", args: [dirname(path)] };
}

/** 真正拉起进程的那一步；测试换成记录 argv 的假实现。 */
export type RevealLauncher = (command: RevealCommand) => Promise<void>;

export const launchReveal: RevealLauncher = (command) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      command.file,
      [...command.args],
      { windowsHide: true, timeout: 10_000 },
      (error) => {
        // `explorer.exe /select,` 选中成功也常以 1 退出，退出码说明不了什么；
        // 只有根本起不来（ENOENT 之类）才算失败。
        if (error && typeof error.code === "string") reject(error);
        else resolve();
      },
    );
    child.unref();
  });

export interface RevealOptions {
  readonly platform?: NodeJS.Platform;
  readonly launch?: RevealLauncher;
}

export function installReveal(
  context: CoreContext,
  options: RevealOptions = {},
): void {
  const database = context.db.database;
  const platform = options.platform ?? process.platform;
  const launch = options.launch ?? launchReveal;

  context.server.router.handle(
    "POST",
    "/api/workspaces/{workspaceId}/reveal",
    answeredAsync(async (match, request) => {
      const workspace = getWorkspace(database, workspaceId(match));
      if ((workspace.executionHostId ?? "") !== "") {
        throw new DomainError(
          501,
          "unsupported",
          "Revealing a file is only possible for a workspace on this machine",
        );
      }
      // 只要求能看这个工作区：打开的是系统自己的文件管理器，不执行工作区里的
      // 任何东西，所以不看工作区的 execute 开关（它默认是关的，看了等于这一项
      // 几乎永远不出现）。「会拉起一个程序」这件事由路由 scope 那一档管。
      if (!workspace.permissions.read) {
        throw forbidden("This workspace is not readable");
      }
      const body = jsonObject(request.body);
      const requested = requiredString(body, "path");
      // `.` 是根目录本身；其余一律按工作区内相对路径解析，并在跟随符号链接之后
      // 再证明一次仍在根目录里（`resolveInRoot` 用的就是 `contains`）。
      const target = resolveInRoot(
        workspace.rootPath,
        requested === "." ? "." : workspaceRelativePath(requested),
      );
      try {
        await launch(revealCommand(platform, target));
      } catch (error) {
        throw new DomainError(
          500,
          "reveal_failed",
          error instanceof Error ? error.message : String(error),
        );
      }
      return { status: 200, body: { ok: true } };
    }),
  );
}
