import { describe, expect, it } from "vitest";

import {
  LOCALES,
  MESSAGE_MODULES,
  messages,
  translate,
  type MessageModule,
} from "./index";

/**
 * i18n 的两条守卫（计划书 §13.6 / §14）。
 *
 * 1. 每个消息模块的 `zh-CN` 与 `en` 必须键集合一致——少一个键就意味着
 *    切到英文时界面上蹦出一个键名。
 * 2. 功能代码里不许写死中文。扫描的是**去掉注释后**的源码：本项目的注释
 *    通篇中文（这是有意的房规），要管的是字符串字面量与 JSX 文本。
 */

const MODULES: Record<string, MessageModule> = MESSAGE_MODULES;

describe("消息模块", () => {
  it("每个模块的两种语言键集合一致", () => {
    for (const [name, module] of Object.entries(MODULES)) {
      const zh = Object.keys(module["zh-CN"]).sort();
      const en = Object.keys(module.en).sort();
      expect(en, `${name}: en 的键与 zh-CN 不一致`).toEqual(zh);
    }
  });

  it("没有空串，也没有把键名当文案用", () => {
    for (const [name, module] of Object.entries(MODULES)) {
      for (const locale of LOCALES) {
        for (const [key, value] of Object.entries(module[locale])) {
          expect(value.trim(), `${name}.${locale}.${key} 是空的`).not.toBe("");
          expect(value, `${name}.${locale}.${key} 没写文案`).not.toBe(key);
        }
      }
    }
  });

  it("模块之间不撞键（合并表是扁平的）", () => {
    const seen = new Map<string, string>();
    for (const [name, module] of Object.entries(MODULES)) {
      for (const key of Object.keys(module["zh-CN"])) {
        const owner = seen.get(key);
        expect(owner, `${key} 同时来自 ${owner} 与 ${name}`).toBeUndefined();
        seen.set(key, name);
      }
    }
    expect(seen.size).toBe(Object.keys(messages["zh-CN"]).length);
  });

  it("插值占位符两种语言一一对应", () => {
    const placeholders = (value: string) =>
      [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
    for (const [name, module] of Object.entries(MODULES)) {
      for (const [key, zhValue] of Object.entries(module["zh-CN"])) {
        expect(
          placeholders(module.en[key] ?? ""),
          `${name}.${key} 的占位符对不上`,
        ).toEqual(placeholders(zhValue));
      }
    }
  });

  it("i18n 目录下的每个模块都挂进了 MESSAGE_MODULES", () => {
    const files = Object.keys(
      import.meta.glob("/src/i18n/*.ts", { eager: false }),
    )
      .map((path) => path.replace("/src/i18n/", "").replace(/\.ts$/, ""))
      .filter((name) => name !== "index" && !name.endsWith(".test"))
      .sort();
    expect(Object.keys(MODULES).sort()).toEqual(files);
  });

  it("缺键时退回 zh-CN 再退回键名", () => {
    expect(translate("en", "canvas.label")).toBe("Canvas");
    expect(translate("en", "no.such.key")).toBe("no.such.key");
  });
});

/* -------------------------------------------------------------------------- */
/* 功能代码里不许写死中文                                                       */
/* -------------------------------------------------------------------------- */

/**
 * 去掉 `//` / `/* *\/` 注释，保留字符串与 JSX 文本。
 *
 * 这是一个够用的扫描器而不是解析器：正则字面量里的引号可能被误判成字符串，
 * 但那只会让扫描更严格（多留一点内容），不会漏报。
 */
function stripComments(source: string): string {
  let out = "";
  let mode: "code" | "line" | "block" | "string" = "code";
  let quote = "";
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i] as string;
    const pair = source.slice(i, i + 2);
    if (mode === "code") {
      if (pair === "//") {
        mode = "line";
        i += 1;
      } else if (pair === "/*") {
        mode = "block";
        i += 1;
      } else if (char === '"' || char === "'" || char === "`") {
        mode = "string";
        quote = char;
        out += char;
      } else {
        out += char;
      }
    } else if (mode === "line") {
      if (char === "\n") {
        mode = "code";
        out += "\n";
      }
    } else if (mode === "block") {
      if (pair === "*/") {
        mode = "code";
        i += 1;
      } else if (char === "\n") {
        out += "\n";
      }
    } else {
      if (char === "\\") {
        out += char + (source[i + 1] ?? "");
        i += 1;
        continue;
      }
      if (char === quote) mode = "code";
      out += char;
    }
  }
  return out;
}

/** CJK 汉字、假名与全角标点。 */
const CJK = /[　-〿぀-ヿ㐀-䶿一-鿿＀-￯]/;

/** 品牌名之类确实要保留原文的行，加这个标记单独放行。 */
const EXEMPT = "i18n-exempt";

const sources = import.meta.glob("/src/**/*.{ts,tsx}", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

describe("界面文案", () => {
  it("功能代码里没有写死的中文（注释除外）", () => {
    const offenders: string[] = [];
    for (const [path, source] of Object.entries(sources)) {
      if (path.startsWith("/src/i18n/")) continue;
      if (/\.test\.tsx?$/.test(path)) continue;
      if (path.endsWith("test-harness.tsx")) continue;
      stripComments(source)
        .split("\n")
        .forEach((line, index) => {
          if (!CJK.test(line)) return;
          if (line.includes(EXEMPT)) return;
          offenders.push(`${path}:${index + 1}: ${line.trim()}`);
        });
    }
    expect(
      offenders,
      "这些串要搬进 src/i18n/*.ts 并经 useT()/t() 取用",
    ).toEqual([]);
  });
});
