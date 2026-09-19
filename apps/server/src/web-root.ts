import { createReadStream } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { dirname, extname, join, resolve, sep } from "node:path";
import { serverContentSecurityPolicy } from "./csp";

/**
 * 托管 `apps/web` 的构建产物。
 *
 * 根限定分两道，而且两道都必须在：
 *
 *   1. **字符串上的收敛**。请求路径先解码再解析成绝对路径，`%2e%2e%2f`、重复
 *      分隔符和 `..` 全都塌缩成同一个答案，落在根外就没有下一步。
 *   2. **realpath 上的复核**。第一道管不住符号链接——包内一个指向 `/etc` 的
 *      链接在字符串上完全合法。所以真正打开之前再问一次内核：解引用之后的路径
 *      仍必须在**根自己的 realpath** 之内，否则当作不存在。
 *
 * 缓存按产物的形状分档：带哈希的资产文件名一变内容就变，可以 `immutable`；
 * `index.html` 必须 `no-store`——它是那些哈希名字的唯一索引，一份活得比资产久的
 * `index.html` 是壳唯一没法向用户解释的失败。
 */

/** 只列 `apps/web` 的产物里真会出现的类型，其余按八位字节流发。 */
const CONTENT_TYPES = new Map<string, string>([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".ico", "image/x-icon"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  [".ttf", "font/ttf"],
  [".map", "application/json; charset=utf-8"],
  [".wasm", "application/wasm"],
  [".txt", "text/plain; charset=utf-8"],
]);

export function contentTypeFor(path: string): string {
  return (
    CONTENT_TYPES.get(extname(path).toLowerCase()) ?? "application/octet-stream"
  );
}

/**
 * 构建产物里「名字里带内容哈希」的那一类。Vite 写出来的是
 * `index-D3fK9x2a.js`：连字符后面一段足够长的 base64url 再接扩展名。名字一变
 * 就是另一份内容，所以它可以被永久缓存。
 */
export function hashedAsset(name: string): boolean {
  return /-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/.test(name);
}

export function cacheControlFor(relative: string): string {
  if (relative === "index.html") return "no-store";
  return hashedAsset(relative)
    ? "public, max-age=31536000, immutable"
    : "no-cache";
}

/**
 * 字符串上的第一道：解码、去掉查询与片段、塌缩成根下的绝对路径。落在根外、
 * 含 NUL 或解码失败一律 `undefined`。
 */
export function resolveWithinRoot(
  root: string,
  requestPath: string,
): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(requestPath.split(/[?#]/)[0] ?? "/");
  } catch {
    return undefined;
  }
  if (decoded.includes("\0")) return undefined;
  const base = resolve(root);
  const candidate = resolve(
    base,
    `.${decoded.startsWith("/") ? "" : "/"}${decoded}`,
  );
  if (candidate !== base && !candidate.startsWith(base + sep)) return undefined;
  return candidate;
}

export interface WebRoot {
  readonly directory: string;
  /** 解引用之后的根，realpath 复核比的是它。 */
  readonly real: string;
}

export async function openWebRoot(directory: string): Promise<WebRoot> {
  const resolved = resolve(directory);
  const real = await realpath(resolved);
  const index = await lstat(join(real, "index.html")).catch(() => undefined);
  if (index === undefined || !index.isFile()) {
    throw new Error(
      `${resolved} 里没有 index.html，这不是 apps/web 的构建产物`,
    );
  }
  return { directory: resolved, real };
}

export interface ServedFile {
  /** 打开用的绝对路径，已经过 realpath 复核。 */
  readonly path: string;
  /** 相对根的路径，缓存档次按它判。 */
  readonly relative: string;
  readonly contentType: string;
  readonly cacheControl: string;
}

/**
 * realpath 上的第二道，外加单页应用的回退。
 *
 * 回退只对**看起来在要一份文档**的路径成立：缺的资产仍然是 404，用 HTML 回答
 * 一个 `.js` 请求只会让页面去解析它然后报一个与真正原因无关的错。
 */
export async function resolveFile(
  root: WebRoot,
  requestPath: string,
): Promise<ServedFile | undefined> {
  const candidate = resolveWithinRoot(root.real, requestPath);
  if (candidate === undefined) return undefined;
  const direct = await confirm(root, candidate);
  if (direct !== undefined) return direct;
  if (extname(requestPath.split(/[?#]/)[0] ?? "") !== "") return undefined;
  return confirm(root, join(root.real, "index.html"));
}

async function confirm(
  root: WebRoot,
  candidate: string,
): Promise<ServedFile | undefined> {
  let real: string;
  try {
    real = await realpath(candidate);
  } catch {
    return undefined;
  }
  // 解引用之后仍要在根里。包内一个指向包外的符号链接在字符串上是合法的，只有
  // 这一步拦得住它。
  if (real !== root.real && !real.startsWith(root.real + sep)) return undefined;
  const found = await lstat(real).catch(() => undefined);
  if (found === undefined) return undefined;
  if (found.isDirectory()) return confirm(root, join(real, "index.html"));
  if (!found.isFile()) return undefined;
  const relative = real.slice(root.real.length + 1);
  return {
    path: real,
    relative,
    contentType: contentTypeFor(real),
    cacheControl: cacheControlFor(relative),
  };
}

/** 每个静态响应都带的那几个头，包括与桌面壳同源的 CSP。 */
export function staticHeaders(file?: ServedFile): Record<string, string> {
  return {
    "content-security-policy": serverContentSecurityPolicy(),
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    // 页面只在 TLS 上服务；一年的 HSTS 是这类部署的下限。
    "strict-transport-security": "max-age=31536000",
    "cache-control": file?.cacheControl ?? "no-store",
    ...(file === undefined ? {} : { "content-type": file.contentType }),
  };
}

/** 把一份产物写进响应。`HEAD` 只发头。 */
export function sendFile(
  response: ServerResponse,
  file: ServedFile,
  method: string,
): void {
  response.writeHead(200, staticHeaders(file));
  if (method === "HEAD") {
    response.end();
    return;
  }
  createReadStream(file.path)
    .on("error", () => response.destroy())
    .pipe(response);
}

/**
 * 没人指定 `--web-root` 时去哪里找产物：打好包的部署把它放在可执行文件旁边的
 * `web/`，开发时从本模块往上走到检出里的 `apps/web/dist`。
 */
export function defaultWebRoot(from: string): string | undefined {
  const beside = resolve(dirname(from), "web");
  if (existsSync(join(beside, "index.html"))) return beside;
  let directory = resolve(from);
  for (;;) {
    const candidate = join(directory, "apps/web/dist");
    if (existsSync(join(candidate, "index.html"))) return candidate;
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}
