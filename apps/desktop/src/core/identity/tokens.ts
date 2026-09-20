import { randomBytes, timingSafeEqual } from "node:crypto";
import { createHash } from "node:crypto";

/**
 * 身份域的原语：标识、密钥、哈希域、以及「这串东西长得像不像凭据」。
 *
 * 逐条对着 合并前的实现移植。三件事一个字都不能
 * 改，否则旧 `host.db` 搬进统一库之后，已有的会话全部认证不上：
 *
 *   * 标识是 16 字节随机的小写十六进制（32 字符）；
 *   * 密钥是 32 字节随机的 base64url，不带填充（43 字符）；
 *   * 哈希是 `sha256("armadra/identity/v1/<用途>\0<值>")`。**用途**（access /
 *     refresh / csrf / bootstrap）是域分隔：没有它，一张刷新票就能当访问令牌用。
 */

export const ID_PATTERN = /^[0-9a-f]{32}$/;

export function newId(): string {
  return randomBytes(16).toString("hex");
}

export function newSecret(): string {
  return randomBytes(32).toString("base64url");
}

export type TokenKind = "bootstrap" | "access" | "refresh" | "csrf";

export function digest(kind: TokenKind, value: string): Buffer {
  return createHash("sha256")
    .update(`armadra/identity/v1/${kind}\u0000${value}`, "utf8")
    .digest();
}

/** 定时安全比较。长度不等直接假——长度本身不是秘密。 */
export function matches(
  kind: TokenKind,
  value: string,
  want: Uint8Array,
): boolean {
  const got = digest(kind, value);
  const expected = Buffer.from(want);
  if (got.length !== expected.length) return false;
  return timingSafeEqual(got, expected);
}

/** `<32 位十六进制>.<43 位 base64url>` 里的那个标识，认不出就是 `undefined`。 */
export function parseToken(value: string): string | undefined {
  if (typeof value !== "string") return undefined;
  if (value.length !== 32 + 1 + 43 || value[32] !== ".") return undefined;
  const id = value.slice(0, 32);
  if (!ID_PATTERN.test(id)) return undefined;
  return validSecret(value.slice(33)) ? id : undefined;
}

/** 严格 base64url：43 字符、解出来正好 32 字节、再编码回去一模一样。 */
export function validSecret(value: string): boolean {
  if (typeof value !== "string" || value.length !== 43) return false;
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) return false;
  const bytes = Buffer.from(value, "base64url");
  return bytes.length === 32 && bytes.toString("base64url") === value;
}

/** 设备名：1–256 字节、无控制字符、首尾无空白。 */
export function validName(value: string): boolean {
  if (typeof value !== "string") return false;
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes === 0 || bytes > 256) return false;
  if (value.trim() !== value) return false;
  for (const character of value) {
    const code = character.codePointAt(0) as number;
    if (code < 32 || code === 127) return false;
  }
  return true;
}

/**
 * 授权里的工作空间 / 执行主机标识：可以为空（空 = 显式批准的全局授权），但不能
 * 含空白、控制字符或 `*`——通配符在这里没有语义，写进来只会被当字面量比较，
 * 那是一个看着像放权、其实什么都不匹配的陷阱。
 */
export function validIdentifier(value: string): boolean {
  if (typeof value !== "string") return false;
  if (Buffer.byteLength(value, "utf8") > 256) return false;
  if (value.trim() !== value) return false;
  for (const character of value) {
    const code = character.codePointAt(0) as number;
    if (code < 33 || code === 127 || character === "*") return false;
  }
  return true;
}
