/**
 * Web 侧只认识两种 uri（语言服务设计 §2.2 `uri`）。
 *
 *  * `armadra:///<rel>` —— 这个工作空间里的一个文件；`<rel>` 是相对路径，
 *    百分号编码规则与 Runtime 的 `language/uri.rs::encode_path` 完全一致
 *    （保留 `A-Za-z0-9-._~/:`，其余按字节转 `%XX`）。
 *  * `armadra-external:///<不透明 id>` —— 工作空间之外的真实文件。它不带
 *    路径，也解不回路径：浏览器不该知道执行主机的目录结构，首版也不打开它。
 *
 * 绝对路径永远不会到这一层。Runtime 在会话两端各改写一次，所以这里既不
 * 拼 `file://`，也不解析它。
 */

export const WORKSPACE_SCHEME = "armadra";
export const EXTERNAL_SCHEME = "armadra-external";

const WORKSPACE_PREFIX = `${WORKSPACE_SCHEME}:///`;
const EXTERNAL_PREFIX = `${EXTERNAL_SCHEME}:///`;

/** 与 Runtime 相同的保留字符集；别的字节一律 `%XX`。 */
const UNRESERVED = /^[A-Za-z0-9\-._~/:]$/;

function encodePath(path: string): string {
  let encoded = "";
  for (const byte of new TextEncoder().encode(path)) {
    const character = String.fromCharCode(byte);
    encoded += UNRESERVED.test(character)
      ? character
      : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return encoded;
}

function decodePath(path: string): string {
  const bytes: number[] = [];
  for (let index = 0; index < path.length; index += 1) {
    if (path[index] === "%" && index + 2 < path.length) {
      const byte = Number.parseInt(path.slice(index + 1, index + 3), 16);
      if (!Number.isNaN(byte)) {
        bytes.push(byte);
        index += 2;
        continue;
      }
    }
    for (const byte of new TextEncoder().encode(path[index])) bytes.push(byte);
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/** 工作空间相对路径 → `armadra:///<rel>`。 */
export function workspaceUri(path: string): string {
  return WORKSPACE_PREFIX + encodePath(path.replace(/^\/+/, ""));
}

/**
 * `armadra:///<rel>` → 相对路径；不是我们的 uri 时返回 `null`。
 *
 * `..` 一律拒绝：一条能走出工作空间的相对路径不该有机会进到打开文件、
 * 应用编辑这些调用里。
 */
export function pathOfUri(uri: string): string | null {
  if (!uri.startsWith(WORKSPACE_PREFIX)) return null;
  const path = decodePath(uri.slice(WORKSPACE_PREFIX.length));
  if (!path || path.split("/").includes("..")) return null;
  return path;
}

/** 工作空间之外的位置。首版只是「不打开」，不是「出错」。 */
export function isExternalUri(uri: string): boolean {
  return uri.startsWith(EXTERNAL_PREFIX);
}

/** 面板里显示 uri 时用的短名：相对路径，或者一句「工作空间之外」。 */
export function displayPath(uri: string): string | null {
  return pathOfUri(uri);
}
