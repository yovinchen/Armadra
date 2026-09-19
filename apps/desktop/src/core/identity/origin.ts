import { isIP } from "node:net";

/**
 * 来源的规范拼法。
 *
 * 移植自 `apps/host/internal/identity/origin.go`。会话是按来源绑定的：票据签给
 * 哪个来源，换出来的会话就只对那个来源有效，比较是**逐字节相等**，不是「差不多
 * 是同一个站点」。所以这里必须先把来源收敛成唯一一种拼法，再比较。
 *
 * 一条规矩值得单独说：**明文 HTTP 只允许回环主机**。回环 HTTP 上的 Cookie 不按
 * 端口隔离（`127.0.0.1:A` 的 Cookie 会发往同一个浏览器 profile 下的任何
 * `127.0.0.1:B`），所以这类来源拿不到 Cookie 会话——它们走的是票据换 Bearer 的
 * 原生传输。
 */

export function canonicalOrigin(value: string): string | undefined {
  if (typeof value !== "string") return undefined;
  if (value === "" || value === "null") return undefined;
  if (/[*?#\\]/.test(value)) return undefined;
  for (const character of value) {
    const code = character.codePointAt(0) as number;
    if (code <= 0x20 || code >= 0x7f) return undefined;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.username || url.password) return undefined;
  if (url.pathname !== "" && url.pathname !== "/") return undefined;
  if (value.includes("?") || value.includes("#")) return undefined;
  // `new URL("http://a")` 给出 pathname "/"；原来的字符串里不许有那条斜杠，
  // 否则 `http://a/` 与 `http://a` 会是两个来源名下的同一个会话。
  const afterScheme = value.slice(value.indexOf("://") + 3);
  if (afterScheme.includes("/")) return undefined;
  const scheme = url.protocol.slice(0, -1).toLowerCase();
  if (scheme !== "http" && scheme !== "https") return undefined;
  if (url.host === "" || afterScheme.endsWith(":")) return undefined;

  let host = url.hostname.toLowerCase();
  const bracketed = host.startsWith("[") && host.endsWith("]");
  const literal = bracketed ? host.slice(1, -1) : host;
  const version = isIP(literal);
  if (afterScheme.startsWith("[") && version !== 6) return undefined;
  if (version === 0) {
    if (/[:%[\]]/.test(host) || host.length > 253) return undefined;
    for (const label of host.split(".")) {
      if (label.length === 0 || label.length > 63) return undefined;
      if (label.startsWith("-") || label.endsWith("-")) return undefined;
      if (!/^[a-z0-9-]+$/.test(label)) return undefined;
    }
  } else if (literal.includes("%")) {
    // 带 zone 的 IPv6 是「这台机器上的某块网卡」，不是一个来源。
    return undefined;
  }
  if (scheme === "http" && host !== "localhost" && !loopbackLiteral(literal)) {
    return undefined;
  }

  let port = url.port;
  if (port !== "") {
    if (!/^\d+$/.test(port)) return undefined;
    const number = Number(port);
    if (number < 1 || number > 65535) return undefined;
    port = String(number);
    if (
      (scheme === "http" && port === "80") ||
      (scheme === "https" && port === "443")
    ) {
      port = "";
    }
  }
  if (version === 6 && !bracketed) host = `[${literal}]`;
  return `${scheme}://${host}${port === "" ? "" : `:${port}`}`;
}

export function validOrigin(value: string): boolean {
  return canonicalOrigin(value) === value;
}

/**
 * 桌面壳呈现的那种来源：回环上的明文 HTTP。
 *
 * 这是**拼法判断，不是授权**。浏览器页面也可以停在一个回环 HTTP 来源上，它只是
 * 造不出会话的起点——票据只有同用户的私有通道签得出来。壳的静态服务端口每次
 * 启动由内核分配，所以这里不可能是一个常量。
 */
export function nativeOrigin(value: string): boolean {
  if (!validOrigin(value)) return false;
  const url = new URL(value);
  if (url.protocol !== "http:") return false;
  const host = url.hostname.toLowerCase();
  if (host === "localhost") return true;
  const literal =
    host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  return loopbackLiteral(literal);
}

function loopbackLiteral(value: string): boolean {
  const version = isIP(value);
  if (version === 4) return value.startsWith("127.");
  if (version === 6) {
    const normalized = value.toLowerCase();
    return normalized === "::1" || normalized === "0:0:0:0:0:0:0:1";
  }
  return false;
}
