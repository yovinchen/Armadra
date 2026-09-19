/**
 * 服务器壳的命令行。
 *
 * 七条子命令，一张表：`serve | install | uninstall | status | logs | upgrade |
 * version`。解析是纯函数——没有 I/O、不读环境以外的东西、不打印——所以每条规则
 * 都能单测，而「拒绝」是解析结果的一种，不是一个 `process.exit`。
 *
 * 两条规则写在这里而不是在执行处，因为它们必须在任何副作用之前成立：
 *
 *   * **监听非回环地址必须显式给 `--public-origin`**。服务器壳面对的是真正的
 *     浏览器，来源白名单是会话能不能成立的前提；没有它就把自己挂到公网上，是
 *     一个没人声明过的决定。
 *   * **`install` / `uninstall` 必须显式给 `--service-dir` 与 `--run-as`**，
 *     账号永远不从当前用户推断（服务定义的规则，见 `service/spec.ts`）。
 */

export const USAGE = `用法: armadra-server <命令> [选项]

  serve        在本进程里装配 core，托管 apps/web 产物并对外提供 HTTPS
  install      生成 launchd / systemd / sc.exe 的服务定义（只写文件，不注册）
  uninstall    删除本命令生成过的那个定义文件
  status       报告版本、监听、TLS、已生成的定义与漂移
  logs         读日志文件的尾部
  upgrade      校验候选可执行文件并旁写替换（没有 --confirm 只打印计划）
  version      打印版本报告

serve:
  --listen HOST:PORT     监听地址，默认 127.0.0.1:0（端口由内核分配）
  --public-origin ORIGIN 对外来源，可重复；监听非回环地址时必须给
  --data-dir DIR         数据目录
  --web-root DIR         apps/web 的构建产物目录
  --tls-cert PATH        TLS 证书（PEM）；与 --tls-key 成对
  --tls-key PATH         TLS 私钥（PEM）
  --device-name NAME     配对时记录的设备名，默认「服务器配对」
  --no-pairing           启动时不铸配对码

install:
  --service-dir DIR      定义文件写入的绝对目录（必须显式给）
  --run-as ACCOUNT       服务运行账号（必须显式给，拒绝特权账号）
  --identifier ID        反向 DNS 标识，默认 local.armadra.server
  --target-platform P    darwin | linux | windows，默认本机
  --executable PATH      服务启动的可执行文件，默认本进程的可执行文件
  --working-dir DIR      工作目录，默认数据目录
  --log-file PATH        日志文件，默认 <数据目录>/server.log
  --env NAME=VALUE       服务导出的环境变量，可重复；名字含凭据字样一律拒绝
  --listen / --public-origin / --tls-cert / --tls-key / --web-root 同 serve

uninstall:
  --service-dir DIR      定义所在目录，默认安装时记下的那个
  --identifier ID        要删除的定义标识

logs:
  --log-file PATH        要读的日志文件，默认 <数据目录>/server.log
  --lines N              读多少行，默认 200，上限 5000

upgrade:
  --binary PATH          候选可执行文件的绝对路径
  --expect-version V     候选必须自报的版本
  --checksum-file PATH   候选的 sha256 校验文件（\`<hex>  <文件名>\` 一行）
  --rollback             回到上一次成功升级换下来的那个可执行文件
  --confirm              真的替换；不给只打印计划

通用:
  --data-dir DIR         数据目录
  --output json          机器可读输出（status / version / upgrade）
  --help, -h             打印本帮助`;

export const DEFAULT_LISTEN = "127.0.0.1:0";
export const DEFAULT_DEVICE_NAME = "服务器配对";

export type CommandName =
  | "serve"
  | "install"
  | "uninstall"
  | "status"
  | "logs"
  | "upgrade"
  | "version";

const COMMANDS: readonly CommandName[] = [
  "serve",
  "install",
  "uninstall",
  "status",
  "logs",
  "upgrade",
  "version",
];

/** 每条子命令认的 flag。不在表里的 flag 是解析错误，不是被忽略的选项。 */
const FLAGS: Record<CommandName, readonly string[]> = {
  serve: [
    "--listen",
    "--public-origin",
    "--data-dir",
    "--web-root",
    "--tls-cert",
    "--tls-key",
    "--device-name",
    "--no-pairing",
    "--output",
  ],
  install: [
    "--service-dir",
    "--run-as",
    "--identifier",
    "--target-platform",
    "--executable",
    "--working-dir",
    "--log-file",
    "--env",
    "--listen",
    "--public-origin",
    "--data-dir",
    "--web-root",
    "--tls-cert",
    "--tls-key",
    "--output",
  ],
  uninstall: ["--service-dir", "--identifier", "--data-dir", "--output"],
  status: ["--data-dir", "--output"],
  logs: ["--log-file", "--lines", "--data-dir", "--output"],
  upgrade: [
    "--binary",
    "--expect-version",
    "--checksum-file",
    "--rollback",
    "--confirm",
    "--data-dir",
    "--output",
  ],
  version: ["--output"],
};

/** 不带值的 flag。其余一律 `--flag value` 或 `--flag=value`。 */
const SWITCHES = new Set(["--no-pairing", "--rollback", "--confirm"]);

/** 可重复的 flag，重复出现是追加而不是覆盖。 */
const REPEATED = new Set(["--public-origin", "--env"]);

export interface ParsedCommand {
  readonly kind: "run";
  readonly command: CommandName;
  readonly values: ReadonlyMap<string, readonly string[]>;
}

export type ParseResult =
  | ParsedCommand
  | { readonly kind: "help" }
  | { readonly kind: "error"; readonly reason: string };

export function parseCommandLine(argv: readonly string[]): ParseResult {
  if (argv.length === 0) return { kind: "help" };
  const [head, ...rest] = argv as [string, ...string[]];
  if (head === "--help" || head === "-h") return { kind: "help" };
  if (!(COMMANDS as readonly string[]).includes(head)) {
    return { kind: "error", reason: `没有这个子命令：${head}` };
  }
  const command = head as CommandName;
  const accepted = FLAGS[command];
  const values = new Map<string, string[]>();
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index] as string;
    if (argument === "--help" || argument === "-h") return { kind: "help" };
    const equals = argument.indexOf("=");
    const flag = equals < 0 ? argument : argument.slice(0, equals);
    if (!accepted.includes(flag)) {
      return { kind: "error", reason: `${command} 不认识 ${flag}` };
    }
    if (SWITCHES.has(flag)) {
      if (equals >= 0) return { kind: "error", reason: `${flag} 不带值` };
      values.set(flag, ["true"]);
      continue;
    }
    let value: string | undefined;
    if (equals >= 0) {
      value = argument.slice(equals + 1);
      if (value === "") value = undefined;
    } else {
      value = rest[index + 1];
      index += 1;
    }
    if (value === undefined) {
      return { kind: "error", reason: `${flag} 需要一个值` };
    }
    const existing = values.get(flag);
    if (existing !== undefined && !REPEATED.has(flag)) {
      return { kind: "error", reason: `${flag} 只能给一次` };
    }
    values.set(flag, existing === undefined ? [value] : [...existing, value]);
  }
  return { kind: "run", command, values };
}

/* ------------------------------- 取值的帮手 ------------------------------- */

export function single(
  values: ReadonlyMap<string, readonly string[]>,
  flag: string,
): string | undefined {
  const found = values.get(flag);
  return found === undefined ? undefined : (found[found.length - 1] as string);
}

export function many(
  values: ReadonlyMap<string, readonly string[]>,
  flag: string,
): readonly string[] {
  return values.get(flag) ?? [];
}

export function switched(
  values: ReadonlyMap<string, readonly string[]>,
  flag: string,
): boolean {
  return values.get(flag) !== undefined;
}

export function wantsJson(
  values: ReadonlyMap<string, readonly string[]>,
): boolean {
  return single(values, "--output") === "json";
}

/* ------------------------------ 监听地址 --------------------------------- */

export interface ListenAddress {
  readonly host: string;
  readonly port: number;
}

/**
 * `HOST:PORT`，IPv6 写成 `[::1]:8443`。端口 0 表示由内核分配；指定的端口被占用
 * 是一个错误，绝不换一个端口——换端口意味着来源和证书都对不上了。
 */
export function parseListen(value: string): ListenAddress | undefined {
  let host: string;
  let portText: string;
  if (value.startsWith("[")) {
    const close = value.indexOf("]");
    if (close < 0 || value[close + 1] !== ":") return undefined;
    host = value.slice(1, close);
    portText = value.slice(close + 2);
  } else {
    const separator = value.lastIndexOf(":");
    if (separator <= 0) return undefined;
    host = value.slice(0, separator);
    portText = value.slice(separator + 1);
  }
  if (host === "" || !/^\d{1,5}$/.test(portText)) return undefined;
  const port = Number(portText);
  if (port > 65535) return undefined;
  return { host, port };
}

/** 回环字面量。主机名不算：主机名是别人的 `/etc/hosts` 说了算的东西。 */
export function loopbackHost(host: string): boolean {
  const literal =
    host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (literal === "localhost") return true;
  if (/^127(\.\d{1,3}){3}$/.test(literal)) return true;
  const lowered = literal.toLowerCase();
  return lowered === "::1" || lowered === "0:0:0:0:0:0:0:1";
}
