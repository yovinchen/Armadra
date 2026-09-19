import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { IdentityError } from "./errors";

/**
 * 口令的派生与校验，`node:crypto` 的 scrypt，不引入依赖。
 *
 * 三条规矩：
 *
 *   * **参数存在行里**，不存在代码里。升参数是改 {@link CURRENT_KDF} 这个常量，
 *     而一份用旧参数派生的哈希必须仍然校验得了——否则一次升级会把所有人锁在
 *     门外。行里存的那组参数就是校验时要用的那组。
 *   * **每份凭据一个随机盐**。同一个口令在两个账号上派生出的哈希因此不同，
 *     一张彩虹表对上一份哈希也对不上第二份。
 *   * **比较是定时安全的**，长度不等直接假——长度本身不是秘密。
 *
 * 为什么是 scrypt 而不是 Argon2id：Argon2 要一个原生依赖，而这一批不新增依赖。
 * scrypt 在 `node:crypto` 里，成本参数由 {@link CURRENT_KDF} 决定，升到 Argon2
 * 时 `kdf` 列已经在那儿，多一个取值即可——这正是那一列存下来的理由。
 */

export interface KdfParameters {
  readonly kdf: "scrypt";
  /** scrypt 的 `N`，必须是 2 的幂。 */
  readonly cost: number;
  /** scrypt 的 `r`。 */
  readonly block: number;
  /** scrypt 的 `p`。 */
  readonly parallel: number;
  /** 派生出多少字节。 */
  readonly length: number;
}

/**
 * 今天新派生用的参数。
 *
 * N=2^15、r=8、p=1 是 `node:crypto` 默认内存上限（32 MiB）下跑得动的一档：
 * 单次派生约 60–90 ms，登录每次做一遍，值得；再往上要同时调 `maxmem`。
 */
export const CURRENT_KDF: KdfParameters = {
  kdf: "scrypt",
  cost: 1 << 15,
  block: 8,
  parallel: 1,
  length: 32,
};

export const SALT_BYTES = 16;

/** 口令本身的底线：太短的口令再好的 KDF 也挡不住，太长的会变成一次 CPU 攻击。 */
export const MIN_PASSWORD_BYTES = 8;
export const MAX_PASSWORD_BYTES = 1024;

export function validPassword(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const bytes = Buffer.byteLength(value, "utf8");
  return bytes >= MIN_PASSWORD_BYTES && bytes <= MAX_PASSWORD_BYTES;
}

export interface DerivedPassword {
  readonly hash: Buffer;
  readonly salt: Buffer;
  readonly parameters: KdfParameters;
}

export function derivePassword(
  password: string,
  parameters: KdfParameters = CURRENT_KDF,
  salt: Buffer = randomBytes(SALT_BYTES),
): DerivedPassword {
  if (!validPassword(password)) throw new IdentityError("invalid");
  return { hash: derive(password, salt, parameters), salt, parameters };
}

/**
 * 校验一份存下来的口令，并回答「它该不该按今天的参数重新派生」。
 *
 * 参数升级发生在**登录成功的那一刻**：那是唯一一次明文口令在手的时刻。调用方
 * 拿到 `upgrade` 之后自己决定要不要写库——校验本身不写库，因为它也跑在校验
 * 失败的路径上。
 */
export function verifyPassword(
  password: string,
  stored: { readonly hash: Uint8Array; readonly salt: Uint8Array } & Omit<
    KdfParameters,
    "kdf"
  > & { readonly kdf: string },
): { ok: boolean; upgrade: boolean } {
  if (!validPassword(password) || stored.kdf !== "scrypt") {
    return { ok: false, upgrade: false };
  }
  const parameters: KdfParameters = {
    kdf: "scrypt",
    cost: stored.cost,
    block: stored.block,
    parallel: stored.parallel,
    length: stored.length,
  };
  let got: Buffer;
  try {
    got = derive(password, Buffer.from(stored.salt), parameters);
  } catch {
    // 库里那组参数这台机器跑不动（比如 N 大到超过 `maxmem`）。这是一次校验
    // 失败，不是一次崩溃：调用方仍然只看到「口令不对」。
    return { ok: false, upgrade: false };
  }
  const want = Buffer.from(stored.hash);
  const ok = got.length === want.length && timingSafeEqual(got, want);
  return { ok, upgrade: ok && !sameKdf(parameters, CURRENT_KDF) };
}

export function sameKdf(left: KdfParameters, right: KdfParameters): boolean {
  return (
    left.kdf === right.kdf &&
    left.cost === right.cost &&
    left.block === right.block &&
    left.parallel === right.parallel &&
    left.length === right.length
  );
}

function derive(
  password: string,
  salt: Buffer,
  parameters: KdfParameters,
): Buffer {
  if (
    !Number.isInteger(parameters.cost) ||
    parameters.cost < 2 ||
    (parameters.cost & (parameters.cost - 1)) !== 0 ||
    !Number.isInteger(parameters.block) ||
    parameters.block < 1 ||
    !Number.isInteger(parameters.parallel) ||
    parameters.parallel < 1 ||
    !Number.isInteger(parameters.length) ||
    parameters.length < 16 ||
    parameters.length > 128 ||
    salt.byteLength === 0
  ) {
    throw new IdentityError("invalid");
  }
  return scryptSync(Buffer.from(password, "utf8"), salt, parameters.length, {
    N: parameters.cost,
    r: parameters.block,
    p: parameters.parallel,
    // 默认 32 MiB 刚好卡在 N=2^15/r=8 上；算够用的余量，不是放开。
    maxmem: 256 * parameters.cost * parameters.block,
  });
}
