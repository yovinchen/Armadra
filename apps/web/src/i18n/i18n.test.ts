import { describe, expect, it } from "vitest";

import {
  LOCALES,
  MESSAGE_MODULES,
  messages,
  translate,
  type MessageModule,
} from "./index";

/**
 * i18n 的三条守卫（计划书 §13.6 / §14）。
 *
 * 1. 每个消息模块的 `zh-CN` 与 `en` 必须键集合一致——少一个键就意味着
 *    切到英文时界面上蹦出一个键名。
 * 2. 功能代码里不许写死中文。扫描的是**去掉注释后**的源码：本项目的注释
 *    通篇中文（这是有意的房规），要管的是字符串字面量与 JSX 文本。
 * 3. 每个键都得有人用。一组实现被删掉时，它的文案很容易留在表里没人发现
 *    ——受管 Chromium 那一批就这样留了 39 个（复查 §3.1）。
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

/* -------------------------------------------------------------------------- */
/* 键必须被引用                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * `t(`前缀.${…}`)` 这样拼出来的键，扫描器只看得见那个静态前缀。
 *
 * 自动抽出来而不是手写白名单：手写的白名单一改代码就过期，而这条正则读的
 * 就是代码本身——拼接方式变了，放行范围跟着变。
 */
function dynamicPrefixes(corpus: string): Set<string> {
  return new Set(
    [...corpus.matchAll(/`([a-zA-Z][\w.-]*\.)\$\{/g)].map(
      (match) => match[1] as string,
    ),
  );
}

/**
 * 本次清理之外的历史欠账：这些键在这条守卫加上来之前就已经没人引用。
 *
 * 断言写成**全等**而不是「不多于」：新增一个没人用的键会失败，删掉一个欠账
 * 却不从这张表里划掉也会失败。这张表只许变短。
 */
const UNREFERENCED: readonly string[] = [
  "activity.title",
  "agent.allow",
  "agent.deny",
  "agent.launchFailed",
  "agents.close",
  "agents.title",
  "app.loadFailed",
  "app.retry",
  "automation.executionHost",
  "automation.more",
  "automation.open",
  "board.new",
  "board.rename",
  "color.blue",
  "color.cyan",
  "color.green",
  "color.orange",
  "color.palette",
  "color.purple",
  "color.red",
  "color.yellow",
  "content.highlight",
  "draw.color",
  "draw.eraser",
  "draw.pen",
  "draw.undo",
  "editor.readonly",
  "frameBinding.missing",
  "gitCommit.binary",
  "gitCommit.title",
  "gitHunk.close",
  "gitIntegration.abortPick",
  "gitIntegration.abortRebase",
  "gitIntegration.abortRevert",
  "gitIntegration.absent",
  "gitIntegration.base",
  "gitIntegration.binary",
  "gitIntegration.continuePick",
  "gitIntegration.continueRebase",
  "gitIntegration.continueRevert",
  "gitIntegration.dirty",
  "gitIntegration.failed",
  "gitIntegration.markResolved",
  "gitIntegration.message",
  "gitIntegration.none",
  "gitIntegration.open",
  "gitIntegration.ours",
  "gitIntegration.rebaseOnto",
  "gitIntegration.submodule",
  "gitIntegration.target",
  "gitIntegration.theirs",
  "gitIntegration.title",
  "gitIntegration.truncated",
  "gitLog.details.title",
  "gitLog.table.repository",
  "gitStash.patch",
  "gitStash.view",
  "image.empty",
  "launch.stalled",
  "launcher.open",
  "legacyArchive.bytes",
  "lsp.executableMissing",
  "lsp.formatOnSaveHint",
  "lsp.openDocuments",
  "lsp.stderr",
  "lsp.unavailable",
  "menu.closeWindow",
  "menu.cut",
  "menu.file",
  "menu.minimize",
  "menu.paste",
  "menu.quit",
  "menu.redo",
  "menu.selectAll",
  "menu.showWindow",
  "menu.undo",
  "menu.window",
  "menu.zoom",
  "mobile.key.ctrlA",
  "mobile.key.ctrlC",
  "mobile.key.ctrlD",
  "mobile.key.ctrlE",
  "mobile.key.ctrlK",
  "mobile.key.ctrlL",
  "mobile.key.ctrlR",
  "mobile.key.ctrlU",
  "mobile.key.ctrlZ",
  "ownership.git.moved",
  "ownership.git.readonly",
  "ownership.git.unknownOutcome",
  "ownership.unknown",
  "problems.inactive",
  "rope.launched",
  "rope.subagent",
  "rope.waiting",
  "scm.ahead",
  "scm.behind",
  "scm.changes",
  "scm.clean",
  "scm.close",
  "scm.committed",
  "scm.diff",
  "scm.message",
  "scm.refresh",
  "scm.staged",
  "scm.title",
  "sessions.add",
  "sessions.collapse",
  "sessions.empty",
  "sessions.expand",
  "sessions.signal.attention",
  "sessions.signal.unread",
  "sessions.signal.working",
  "sessions.title",
  "settings.nodeColorStyle.bar",
  "settings.nodeColorStyle.dot",
  "settings.shortcuts",
  "ssh.edit",
  "ssh.pickIdentity",
  "ssh.testing",
  "subagent.transcript",
  "terminal.failed",
  "terminal.findNext",
  "terminal.findPrev",
  "tray.quit",
  "tray.showWindow",
  "tray.updateRestart",
  "tray.usage.session",
  "tray.usage.unknown",
  "tray.usage.week",
  "updates.checkedAt",
  "updates.release.notes",
  "updates.release.size",
  "usage.recoveryHint",
  "usage.source.copilot",
];

describe("消息键的引用", () => {
  // 扫全量源码语料，整套并行跑时 5 秒默认预算偏紧。
  it("每个键都至少被一个非 i18n 的源文件用到", { timeout: 60_000 }, () => {
    const corpus = Object.entries(sources)
      .filter(([path]) => !path.startsWith("/src/i18n/"))
      .map(([, source]) => source)
      .join("\n");
    const prefixes = [...dynamicPrefixes(corpus)];
    const used = (key: string) =>
      corpus.includes(key) || prefixes.some((prefix) => key.startsWith(prefix));

    const dead = Object.values(MODULES)
      .flatMap((module) => Object.keys(module["zh-CN"]))
      .filter((key) => !used(key))
      .sort();

    expect(
      dead,
      "没有任何代码引用这些键：删掉它们，或把新增的那几个从 UNREFERENCED 里划掉",
    ).toEqual([...UNREFERENCED]);
  });
});
