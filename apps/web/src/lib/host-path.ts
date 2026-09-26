/**
 * 一条路径算不算「那台机器上的绝对路径」。
 *
 * 页面在浏览器里，看不见路径最后落在哪台机器上，所以规则由调用方按路径的归属
 * 选：core 本机的路径按 core 的平台（`app/core-host.ts`），Windows 上是盘符或
 * UNC；执行主机（SSH 工作区、远端 Worker）上的路径一律按 POSIX——那一侧只有
 * POSIX 主机。
 */
export type PathRules = "posix" | "windows";

/** 控制字符与 NUL 在哪种规则下都不该出现在一条路径里。 */
const CONTROL = /[\u0000-\u001f\u007f]/;
/** Windows 路径里不允许的字符（`:` 只许出现在盘符里，下面单独判）。 */
const WINDOWS_FORBIDDEN = /[\x22<>|?*]/;

export function isAbsoluteHostPath(path: string, rules: PathRules): boolean {
  if (path === "" || CONTROL.test(path)) return false;
  if (rules === "posix") return path.startsWith("/");
  if (WINDOWS_FORBIDDEN.test(path)) return false;
  const drive = /^[A-Za-z]:[\\/]/.exec(path);
  if (drive) return !path.slice(2).includes(":");
  // UNC：`\\server\share\…`，服务器与共享名都不能空。
  return /^\\\\[^\\/:]+[\\/][^\\/:]+(?:[\\/][^:]*)?$/.test(path);
}

/**
 * 一个可执行文件的绝对路径。POSIX 侧照旧不收空白（命令会话的启动定义逐词冻
 * 结）；Windows 的程序大多装在 `Program Files` 下，空格是路径的一部分。
 */
export function isAbsoluteExecutable(path: string, rules: PathRules): boolean {
  if (!isAbsoluteHostPath(path, rules)) return false;
  return rules === "windows" || !/\s/.test(path);
}
