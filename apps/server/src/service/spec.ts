import { isAbsolute, posix, win32 } from "node:path";

/**
 * 服务定义的输入，以及它的校验。
 *
 * 这一族模块只做一件事：**写出一份运维可以审阅的定义文件**。它从不调用
 * launchctl、systemctl 或 sc.exe，从不 enable、从不 start。渲染是 Spec 的纯
 * 函数，同样的输入永远渲染出同样的字节，所以一份生成的定义可以进版本管理、可以
 * diff。
 *
 * 四条规则在这里成立（其余三条在 `render.ts` 与 `upgrade.ts`）：
 *
 *   1. **账号永远不推断**。`--run-as` 必须显式给；服务器模式的意义就是跑在一个
 *      专用的非特权账号上，把它默认成当前用户等于把这个决定藏起来。
 *   2. **拒绝特权账号**。root / Administrator / SYSTEM 一类一律拒绝生成。
 *   3. **定义里不含凭据**。`--env` 的名字里出现 TOKEN / SECRET / PASSWORD /
 *      CREDENTIAL 一类字样就拒绝——是拒绝而不是删掉：一份被悄悄少掉一项的定义
 *      会启动一个运维没有审阅过的配置。
 *   4. **控制字符一律拒绝**。每个渲染器都会转义自己写的东西，但 systemd 值里的
 *      一个换行、批处理里的一个引号改变的是外围指令的含义，不是那个值。
 */

export const PLATFORMS = ["darwin", "linux", "windows"] as const;
export type ServicePlatform = (typeof PLATFORMS)[number];

export const DEFAULT_IDENTIFIER = "local.armadra.server";

/** 数据目录里记录「这份定义是给它生成的」的文件。不含任何凭据。 */
export const MARKER_NAME = "service-definition.json";

/** 每份渲染出来的定义里都有这一串，`uninstall` 靠它认出自己写的文件。 */
export const GENERATED_MARKER = "armadra-server install";

export class ServiceDefinitionError extends Error {
  readonly name = "ServiceDefinitionError";
}

const RESERVED_ACCOUNTS = new Set([
  "root",
  "administrator",
  "system",
  "localsystem",
  "networkservice",
  "localservice",
  "trustedinstaller",
]);

const SECRET_MARKERS = [
  "TOKEN",
  "SECRET",
  "PASSWORD",
  "PASSWD",
  "CREDENTIAL",
  "APIKEY",
  "API_KEY",
  "PRIVATE_KEY",
  "SESSION",
];

export interface Spec {
  readonly identifier: string;
  readonly platform: ServicePlatform;
  readonly executable: string;
  /**
   * 可执行文件与 `serve` 之间那个脚本路径。
   *
   * 以 `node out/main.js serve …` 形态部署时，`executable` 是 node，真正的入口
   * 是这个脚本；打成自带启动器的形态时它是空串。写出来而不是推断，是因为一份
   * 服务定义必须能逐字复现运维审阅时看到的那条命令行。
   */
  readonly script: string;
  readonly runAs: string;
  readonly dataDir: string;
  readonly workingDir: string;
  readonly logPath: string;
  readonly listen: string;
  readonly webRoot: string;
  readonly publicOrigins: readonly string[];
  readonly certFile: string;
  readonly keyFile: string;
  readonly environment: readonly string[];
}

export interface SpecInput {
  readonly identifier?: string | undefined;
  readonly platform?: string | undefined;
  readonly executable?: string | undefined;
  readonly script?: string | undefined;
  readonly runAs?: string | undefined;
  readonly dataDir?: string | undefined;
  readonly workingDir?: string | undefined;
  readonly logPath?: string | undefined;
  readonly listen?: string | undefined;
  readonly webRoot?: string | undefined;
  readonly publicOrigins?: readonly string[] | undefined;
  readonly certFile?: string | undefined;
  readonly keyFile?: string | undefined;
  readonly environment?: readonly string[] | undefined;
}

function refuse(message: string): never {
  throw new ServiceDefinitionError(`服务定义无效：${message}`);
}

function checkValue(name: string, value: string): void {
  if (value === "") refuse(`${name} 不能为空`);
  for (const character of value) {
    const code = character.codePointAt(0) as number;
    if (code < 0x20 || code === 0x7f) refuse(`${name} 不能含控制字符`);
  }
}

/** POSIX 的定义带 POSIX 路径，Windows 的按 Windows 的规矩。 */
function cleanFor(platform: ServicePlatform, value: string): string {
  return platform === "windows"
    ? win32.normalize(value)
    : posix.normalize(value);
}

function absoluteFor(platform: ServicePlatform, value: string): boolean {
  return platform === "windows"
    ? win32.isAbsolute(value)
    : value.startsWith("/") || isAbsolute(value);
}

function checkPath(
  platform: ServicePlatform,
  name: string,
  value: string,
): string {
  checkValue(name, value);
  if (!absoluteFor(platform, value)) refuse(`${name} 必须是绝对路径`);
  return cleanFor(platform, value);
}

export function checkIdentifier(value: string): void {
  if (value.length > 96) refuse("标识太长");
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] as string;
    const inner = index !== 0 && index !== value.length - 1;
    const ok =
      /[a-z0-9]/.test(character) || (inner && /[.\-_]/.test(character));
    if (!ok) refuse("标识只接受小写字母、数字、点、短横和下划线");
  }
}

export function checkAccount(value: string): void {
  if (value.length > 96) refuse("账号名太长");
  for (const character of value) {
    if (/\s/.test(character) || /["'<>&|;$`]/.test(character)) {
      refuse("账号名含不支持的字符");
    }
    const code = character.codePointAt(0) as number;
    if (code < 0x20 || code === 0x7f) refuse("账号名不能含控制字符");
  }
  if (RESERVED_ACCOUNTS.has(value.toLowerCase())) {
    refuse(`拒绝生成以 ${value} 身份运行的定义；请用一个专用的非特权账号`);
  }
}

export function checkEnvironment(entry: string): void {
  const separator = entry.indexOf("=");
  if (separator <= 0) refuse("环境变量写成 NAME=VALUE");
  checkValue("环境变量", entry);
  const name = entry.slice(0, separator);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    refuse(`环境变量名 ${name} 不是一个普通变量名`);
  }
  const upper = name.toUpperCase();
  for (const marker of SECRET_MARKERS) {
    if (upper.includes(marker)) {
      refuse(`拒绝把 ${name} 写进服务定义；凭据请走别的通道`);
    }
  }
}

/** 校验并补齐可以安全推断的默认值。账号不在可推断之列。 */
export function normalizeSpec(input: SpecInput): Spec {
  const platformText = input.platform ?? process.platform;
  if (!(PLATFORMS as readonly string[]).includes(platformText)) {
    refuse(`不支持的目标平台 ${platformText}`);
  }
  const platform = platformText as ServicePlatform;
  const identifier = input.identifier ?? DEFAULT_IDENTIFIER;
  checkIdentifier(identifier);
  const runAs = (input.runAs ?? "").trim();
  if (runAs === "") {
    refuse("必须给 --run-as ACCOUNT；服务账号永远不取当前用户");
  }
  checkAccount(runAs);
  const listen = (input.listen ?? "").trim();
  if (listen === "") refuse("必须给监听地址");
  checkValue("监听地址", listen);
  const executable = checkPath(
    platform,
    "可执行文件",
    input.executable ?? refuse("必须给可执行文件路径"),
  );
  const dataDir = checkPath(
    platform,
    "数据目录",
    input.dataDir ?? refuse("必须给数据目录"),
  );
  const webRoot = checkPath(
    platform,
    "页面目录",
    input.webRoot ?? refuse("必须给 --web-root"),
  );
  const workingDir = checkPath(
    platform,
    "工作目录",
    input.workingDir ?? dataDir,
  );
  const logPath = checkPath(
    platform,
    "日志文件",
    input.logPath ?? joinFor(platform, dataDir, "server.log"),
  );
  const certFile = input.certFile ?? "";
  const keyFile = input.keyFile ?? "";
  if ((certFile === "") !== (keyFile === "")) {
    refuse("TLS 需要证书与私钥成对给出");
  }
  const publicOrigins = input.publicOrigins ?? [];
  for (const origin of publicOrigins) checkValue("对外来源", origin);
  for (const entry of input.environment ?? []) checkEnvironment(entry);
  const script = input.script ?? "";
  return {
    identifier,
    platform,
    executable,
    script: script === "" ? "" : checkPath(platform, "启动脚本", script),
    runAs,
    dataDir,
    workingDir,
    logPath,
    listen,
    webRoot,
    publicOrigins: [...publicOrigins],
    certFile: certFile === "" ? "" : checkPath(platform, "TLS 证书", certFile),
    keyFile: keyFile === "" ? "" : checkPath(platform, "TLS 私钥", keyFile),
    // 顺序是渲染出来的字节的一部分：同样的 flag 换个次序也要得到同一份文件。
    environment: [...(input.environment ?? [])].sort(),
  };
}

export function joinFor(platform: ServicePlatform, ...parts: string[]): string {
  return platform === "windows" ? win32.join(...parts) : posix.join(...parts);
}

export function dirFor(platform: ServicePlatform, value: string): string {
  return platform === "windows" ? win32.dirname(value) : posix.dirname(value);
}

/** 服务管理器真正执行的那条命令行的参数部分。 */
export function specArguments(spec: Spec): string[] {
  const args = [
    ...(spec.script === "" ? [] : [spec.script]),
    "serve",
    "--data-dir",
    spec.dataDir,
    "--listen",
    spec.listen,
    "--web-root",
    spec.webRoot,
  ];
  for (const origin of spec.publicOrigins) args.push("--public-origin", origin);
  if (spec.certFile !== "") {
    args.push("--tls-cert", spec.certFile, "--tls-key", spec.keyFile);
  }
  return args;
}

export function fileNameFor(spec: Spec): string {
  switch (spec.platform) {
    case "darwin":
      return `${spec.identifier}.plist`;
    case "linux":
      return `${spec.identifier}.service`;
    default:
      return `${spec.identifier}.install.cmd`;
  }
}

/** 定义文件的权限。服务管理器以别的用户读它，所以它是全局可读的——而这只有在
 * 渲染器拒绝往里写任何秘密的前提下才安全（上面的第 3 条）。 */
export const DEFINITION_MODE = 0o644;
