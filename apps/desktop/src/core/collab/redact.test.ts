import { describe, expect, it } from "vitest";
import { PATTERNS, REDACTED, redact } from "./redact";

/**
 * 表驱动：一行一种凭据，断言它被换掉、而周围的句子没被吃掉。
 *
 * 第二列不是「输出长什么样」而是「哪一串必须消失」：脱敏的判据是那串字节不再
 * 出现在输出里，不是输出等于某个我抄下来的字符串。
 */
const SECRETS: readonly {
  readonly name: string;
  readonly text: string;
  readonly secret: string;
}[] = [
  {
    name: "OpenAI 风格的 sk-",
    text: "export OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz012345",
    secret: "sk-abcdefghijklmnopqrstuvwxyz012345",
  },
  {
    name: "GitHub classic token",
    text: "用 ghp_0123456789abcdefghijklmnopqrstuvwxyz 推上去",
    secret: "ghp_0123456789abcdefghijklmnopqrstuvwxyz",
  },
  {
    name: "GitHub OAuth token",
    text: "gho_0123456789abcdefghijklmnopqrstuvwxyz",
    secret: "gho_0123456789abcdefghijklmnopqrstuvwxyz",
  },
  {
    name: "GitHub 细粒度 PAT",
    text: "github_pat_11ABCDEFG0abcdefghij_KLMNOPQRSTUVWXYZ0123456789",
    secret: "github_pat_11ABCDEFG0abcdefghij_KLMNOPQRSTUVWXYZ0123456789",
  },
  {
    name: "AWS access key id",
    text: "AKIAIOSFODNN7EXAMPLE 是那台机器的",
    secret: "AKIAIOSFODNN7EXAMPLE",
  },
  {
    name: "Slack bot token",
    text: [
      "xoxb",
      "123456789012",
      "1234567890123",
      "AbCdEfGhIjKlMnOpQrStUvWx",
    ].join("-"),
    secret: [
      "xoxb",
      "123456789012",
      "1234567890123",
      "AbCdEfGhIjKlMnOpQrStUvWx",
    ].join("-"),
  },
  {
    name: "Authorization 头里的 Bearer",
    text: "curl -H 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJhIjoxfQ.sig'",
    secret: "eyJhbGciOiJIUzI1NiJ9.eyJhIjoxfQ.sig",
  },
  {
    name: "PEM 私钥块",
    text: "-----BEGIN RSA PRIVATE KEY-----\nMIIEow=\nAQEA\n-----END RSA PRIVATE KEY-----",
    secret: "MIIEow=",
  },
  {
    name: ".env 风格的 *_SECRET",
    text: "CLIENT_SECRET=0123456789abcdefghij",
    secret: "0123456789abcdefghij",
  },
  {
    name: ".env 风格的 PASSWORD",
    text: 'PASSWORD="hunter2-hunter2-hunter2"',
    secret: "hunter2-hunter2-hunter2",
  },
];

describe("脱敏", () => {
  for (const item of SECRETS) {
    it(`换掉 ${item.name}`, () => {
      const out = redact(item.text);
      expect(out).not.toContain(item.secret);
      expect(out).toContain(REDACTED);
    });
  }

  it("留下键名与句子，只换掉值", () => {
    const out = redact("CLIENT_SECRET=0123456789abcdefghij 写在 .env 里");
    expect(out).toBe(`CLIENT_SECRET=${REDACTED} 写在 .env 里`);
  });

  it("Bearer 保留方案名，只换掉后面那串", () => {
    expect(redact("Authorization: Bearer abcdefghijklmnop")).toBe(
      `Authorization: Bearer ${REDACTED}`,
    );
  });

  /**
   * 错杀比漏掉贵：读者来读的就是对方在干什么，一份被切碎的转录读不成句子。
   */
  it("不碰正常的代码与路径", () => {
    const text = [
      "PATH=/usr/local/bin:/usr/bin:/bin",
      "const id = 'a3f1c2d4-5e6f-7a8b-9c0d-1e2f3a4b5c6d';",
      "API_KEY=short",
      "git commit -m '把 sk- 前缀的解析补上'",
      "npm install @armadra/shared",
    ].join("\n");
    expect(redact(text)).toBe(text);
  });

  it("同一段里的两串都换掉", () => {
    const out = redact(
      "A=ghp_0123456789abcdefghijklmnopqrstuvwxyz B=sk-abcdefghijklmnopqrstuv",
    );
    expect(out).not.toContain("ghp_");
    expect(out).not.toContain("sk-abcdefghijklmnopqrstuv");
  });

  it("没有凭据时一个字节都不改", () => {
    const text = "读了 src/main.ts，改了三行，跑了测试。";
    expect(redact(text)).toBe(text);
  });

  it("每条规则都有名字，且没有重名", () => {
    const names = PATTERNS.map((rule) => rule.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).not.toBe("");
  });

  /** 全局正则的 `lastIndex` 在两次调用之间不该留着。 */
  it("连着跑两次结果一样", () => {
    const text = "token=ghp_0123456789abcdefghijklmnopqrstuvwxyz";
    expect(redact(text)).toBe(redact(text));
  });
});
