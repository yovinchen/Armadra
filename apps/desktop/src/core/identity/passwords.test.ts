import { describe, expect, it } from "vitest";
import { IdentityError } from "./errors";
import {
  CURRENT_KDF,
  derivePassword,
  validPassword,
  verifyPassword,
} from "./passwords";

/** 派生一份「用旧参数存下来的」凭据，用来验证参数升级那一条。 */
const WEAK = { ...CURRENT_KDF, cost: 1 << 12 };

describe("口令的派生与校验", () => {
  it("对的口令通过，错的不通过", () => {
    const derived = derivePassword("correct horse battery");
    const stored = {
      hash: derived.hash,
      salt: derived.salt,
      kdf: derived.parameters.kdf,
      cost: derived.parameters.cost,
      block: derived.parameters.block,
      parallel: derived.parameters.parallel,
      length: derived.parameters.length,
    };
    expect(verifyPassword("correct horse battery", stored)).toEqual({
      ok: true,
      upgrade: false,
    });
    expect(verifyPassword("correct horse batterx", stored).ok).toBe(false);
  });

  it("同一个口令两次派生出的哈希不同：盐是每份凭据一个", () => {
    const first = derivePassword("correct horse battery");
    const second = derivePassword("correct horse battery");
    expect(first.salt.equals(second.salt)).toBe(false);
    expect(first.hash.equals(second.hash)).toBe(false);
  });

  it("旧参数仍然校验得了，并且报出该升级", () => {
    const derived = derivePassword("correct horse battery", WEAK);
    const result = verifyPassword("correct horse battery", {
      hash: derived.hash,
      salt: derived.salt,
      kdf: "scrypt",
      cost: WEAK.cost,
      block: WEAK.block,
      parallel: WEAK.parallel,
      length: WEAK.length,
    });
    // 升级不能发生在校验失败的路径上：那会变成一次按错口令重写凭据。
    expect(result).toEqual({ ok: true, upgrade: true });
    expect(
      verifyPassword("wrong", {
        hash: derived.hash,
        salt: derived.salt,
        kdf: "scrypt",
        cost: WEAK.cost,
        block: WEAK.block,
        parallel: WEAK.parallel,
        length: WEAK.length,
      }),
    ).toEqual({ ok: false, upgrade: false });
  });

  it("认不出的 KDF 是一次校验失败，不是一次崩溃", () => {
    expect(
      verifyPassword("correct horse battery", {
        hash: Buffer.alloc(32),
        salt: Buffer.alloc(16),
        kdf: "argon2id",
        cost: 1,
        block: 1,
        parallel: 1,
        length: 32,
      }),
    ).toEqual({ ok: false, upgrade: false });
  });

  it("太短的口令根本不派生", () => {
    expect(validPassword("short")).toBe(false);
    expect(validPassword("longenough")).toBe(true);
    expect(() => derivePassword("short")).toThrow(IdentityError);
  });
});
