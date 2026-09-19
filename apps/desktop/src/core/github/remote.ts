/**
 * git remote 与 API base 的本地解析。移植自
 * `apps/host/internal/githubapi/remote.go`。
 *
 * 全部在本地完成，在任何请求之前：属于另一个服务的 remote 不用联网就能认出来，
 * 这就是「企业版仓库不会被拿到公有服务上去查」的实现。
 */

import { apiFailure } from "./errors";

export const PUBLIC_API_BASE = "https://api.github.com";

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/**
 * 单标签主机名是允许的：内网的 GitHub Enterprise 常常只有一个没有域名的名字，
 * 拒绝它等于让企业场景没法配置。
 */
const HOST_PATTERN =
  /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?)*$/;

export interface ParsedRemote {
  readonly owner: string;
  readonly name: string;
  readonly webHost: string;
}

function invalid(reason: string): never {
  throw apiFailure("INVALID_ARGUMENT", 0, reason);
}

/**
 * 每次请求都要对着解析的那个 base。
 *
 * 只接受 HTTPS：http 的 base 会把 bearer 令牌明文放到线上；带凭据、查询或片段
 * 的东西根本不是一个 base。
 */
export function normalizeApiBase(value: string | undefined): string {
  const raw = (value ?? "").trim();
  if (raw === "") return PUBLIC_API_BASE;
  if (raw.length > 2048 || /[\s\\]/.test(raw)) invalid("API_BASE_INVALID");
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return invalid("API_BASE_INVALID");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    raw.includes("?") ||
    raw.includes("#")
  ) {
    invalid("API_BASE_INVALID");
  }
  const host = parsed.hostname.toLowerCase();
  if (!HOST_PATTERN.test(host)) invalid("API_BASE_INVALID");
  const path = parsed.pathname.replace(/\/+$/, "");
  if (path.includes("//") || path.includes("..")) invalid("API_BASE_INVALID");
  const authority = parsed.port === "" ? host : `${host}:${parsed.port}`;
  return `https://${authority}${path}`;
}

/** 一个 base 解析到的 authority，用来核对 remote 属不属于这个服务。 */
export function apiHost(base: string): string {
  try {
    return new URL(base).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * 这个 remote 的 web 主机归不归这个 API base 管。
 *
 * 只有公有 API 这一种情况两个主机名合法地不一样；任何企业版 base 都必须相等，
 * 这正是企业版仓库不会被解析到公有服务上去的原因。
 */
export function belongsTo(base: string, webHost: string): boolean {
  const host = webHost.toLowerCase().replace(/\.$/, "");
  if (host === "") return false;
  if (base === PUBLIC_API_BASE) {
    return (
      host === "github.com" ||
      host === "www.github.com" ||
      host === "ssh.github.com"
    );
  }
  return host === apiHost(base);
}

/** 一个 API base 服务的 web 主机，解析出来的仓库要报自己住在哪儿时用。 */
export function webHostFor(base: string): string {
  return base === PUBLIC_API_BASE ? "github.com" : apiHost(base);
}

/**
 * 读一个 git remote URL。接受 https / ssh / git 以及 scp 形式的
 * `git@host:owner/name`，**从不做查询**：返回的主机名就是 URL 写的那个。
 */
export function parseRemote(value: string): ParsedRemote {
  const raw = (value ?? "").trim();
  if (raw === "" || raw.length > 2048 || /\s/.test(raw)) {
    invalid("REMOTE_INVALID");
  }
  let host: string;
  let path: string;
  if (raw.includes("://")) {
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      return invalid("REMOTE_INVALID");
    }
    if (!["https:", "http:", "ssh:", "git:"].includes(parsed.protocol)) {
      invalid("REMOTE_SCHEME_UNSUPPORTED");
    }
    host = parsed.hostname;
    path = parsed.pathname;
  } else {
    // scp 形式：`[user@]host:path`。路径里的冒号不是分隔符，所以只有第一个分。
    const at = raw.lastIndexOf("@");
    const rest = at >= 0 ? raw.slice(at + 1) : raw;
    const colon = rest.indexOf(":");
    if (colon <= 0) invalid("REMOTE_INVALID");
    host = rest.slice(0, colon);
    path = rest.slice(colon + 1);
  }
  host = host.toLowerCase().replace(/\.$/, "");
  if (!HOST_PATTERN.test(host)) invalid("REMOTE_INVALID");
  const segments = path.split("/").filter((segment) => segment !== "");
  if (segments.length < 2) invalid("REMOTE_INVALID");
  // 企业版 remote 常常直接挂在 `/<owner>/<name>`，但有些部署会加路径前缀。
  // 仓库永远是最后两段，`.git` 是名字的后缀而不是名字的一部分。
  const owner = segments[segments.length - 2] as string;
  const name = (segments[segments.length - 1] as string).replace(/\.git$/, "");
  if (!NAME_PATTERN.test(owner) || !NAME_PATTERN.test(name)) {
    invalid("REMOTE_INVALID");
  }
  return { owner, name, webHost: host };
}

/** 这个值能不能不经转义地用作请求路径里的 owner 或仓库名。 */
export function validName(value: string): boolean {
  return NAME_PATTERN.test(value);
}
