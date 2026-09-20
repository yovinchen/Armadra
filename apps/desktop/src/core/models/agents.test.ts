import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { emptyCatalog, parse, type Catalog } from "./catalog";
import {
  MENU_CACHE_TTL_MS,
  assemble,
  builtinModels,
  catalogProvider,
  forgetMenus,
  isSelectable,
  menuFor,
  parseClaudeModelAliases,
  parseCodexConfigModels,
} from "./agents";

const CATALOG: Catalog = parse(
  JSON.stringify({
    anthropic: {
      models: {
        "claude-opus-5": {
          name: "Claude Opus 5",
          release_date: "2026-05-01",
          cost: { input: 5, output: 25 },
        },
        "claude-sonnet-4-6": {
          name: "Claude Sonnet 4.6",
          release_date: "2026-02-17",
          cost: { input: 3, output: 15 },
        },
        "claude-embedding-1": {
          name: "Claude Embedding",
          release_date: "2026-06-01",
          cost: { input: 1, output: 1 },
        },
      },
    },
    openai: {
      models: {
        "gpt-6": {
          name: "GPT-6",
          release_date: "2026-08-01",
          cost: { input: 2, output: 8 },
        },
      },
    },
  }),
  "2026-09-20T00:00:00.000Z",
);

describe("哪一家目录属于哪个适配器", () => {
  it("三个适配器各对一家，可以指向任意 provider 的没有", () => {
    expect(catalogProvider("claude")).toBe("anthropic");
    expect(catalogProvider("codex")).toBe("openai");
    expect(catalogProvider("copilot")).toBe("github-copilot");
    for (const agent of ["opencode", "pi", "omp", "custom:x"]) {
      expect(catalogProvider(agent)).toBeUndefined();
    }
  });

  it("离线兜底和页面那张表逐行一致", () => {
    expect(builtinModels("claude")).toEqual(["opus", "sonnet", "haiku"]);
    expect(builtinModels("codex")).toEqual(["gpt-5-codex", "gpt-5"]);
    expect(builtinModels("opencode")).toEqual([]);
  });

  it("写代码的 Agent 菜单里没有嵌入、图像、音频模型", () => {
    expect(isSelectable("claude-opus-5")).toBe(true);
    expect(isSelectable("text-embedding-3-large")).toBe(false);
    expect(isSelectable("gpt-image-1")).toBe(false);
    expect(isSelectable("whisper-1")).toBe(false);
  });
});

describe("三种来源的合并", () => {
  it("CLI 说的排最前，然后按日期倒序，兜底排最后", () => {
    const models = assemble("claude", ["opus", "my-alias"], CATALOG);
    expect(models.map((model) => `${model.id}:${model.source}`)).toEqual([
      // CLI 自己的两条，文件顺序。
      "opus:cli",
      "my-alias:cli",
      // 目录，新的在前；嵌入模型被滤掉了。
      "claude-opus-5:catalog",
      "claude-sonnet-4-6:catalog",
      // 兜底里 `opus` 已经出现过，剩下两条排最后。
      "sonnet:builtin",
      "haiku:builtin",
    ]);
  });

  it("一个 id 只出现一次，第一个说它的来源赢", () => {
    const models = assemble("claude", ["claude-opus-5"], CATALOG);
    const opus = models.filter((model) => model.id === "claude-opus-5");
    expect(opus).toHaveLength(1);
    expect(opus[0]?.source).toBe("cli");
  });

  it("目录条目带显示名和发布日期，别的不带", () => {
    const models = assemble("claude", [], CATALOG);
    const opus = models.find((model) => model.id === "claude-opus-5");
    expect(opus?.label).toBe("Claude Opus 5");
    expect(opus?.releaseDate).toBe("2026-05-01");
    const builtin = models.find((model) => model.id === "sonnet");
    expect(builtin?.label).toBe("sonnet");
    expect(builtin?.releaseDate).toBeUndefined();
  });

  it("可以指向任意 provider 的 CLI 只有它自己说的那些", () => {
    expect(assemble("opencode", [], CATALOG)).toEqual([]);
    expect(assemble("opencode", ["anthropic/claude-opus-5"], CATALOG)).toEqual([
      {
        id: "anthropic/claude-opus-5",
        label: "anthropic/claude-opus-5",
        source: "cli",
      },
    ]);
  });

  it("没有目录时菜单退回兜底而不是空", () => {
    expect(assemble("codex", [], emptyCatalog()).map((m) => m.id)).toEqual([
      "gpt-5-codex",
      "gpt-5",
    ]);
  });
});

describe("`claude --help` 里的别名", () => {
  const HELP = [
    "Usage: claude [options] [command] [prompt]",
    "",
    "Options:",
    "  --model <model>        Model for the current session. Provide an alias",
    "                         for the latest model (e.g. 'fable', 'opus', or",
    "                         'sonnet') or a model's full name (e.g.",
    "                         'claude-fable-5').",
    "  --fallback-model <m>   Enable automatic fallback to 'haiku'.",
    "",
  ].join("\n");

  it("读的是跨行的那一段，而且只读 `--model` 自己那一段", () => {
    expect(parseClaudeModelAliases(HELP)).toEqual([
      "fable",
      "opus",
      "sonnet",
      "claude-fable-5",
    ]);
  });

  it("撇号不开启任何东西", () => {
    expect(parseClaudeModelAliases(HELP)).not.toContain("s full name (e.g.");
  });

  it("没有 `--model` 的帮助一条都读不出来", () => {
    expect(parseClaudeModelAliases("Usage: codex\n  -h, --help\n")).toEqual([]);
    expect(parseClaudeModelAliases("")).toEqual([]);
  });
});

describe("`config.toml` 里配好的 Codex 模型", () => {
  it("顶层的 model 和每个 profile 的 model，按文件顺序", () => {
    const models = parseCodexConfigModels(
      [
        "# 注释",
        'model = "gpt-6-astra-high"',
        "",
        "[model_providers.openai]",
        'name = "OpenAI"',
        'model = "不该被读到"',
        "",
        "[profiles.fast]",
        "model = 'gpt-6-mini'   # 行尾注释",
        "",
        "[profiles.slow]",
        'model = "gpt-6-astra-high"',
      ].join("\n"),
    );
    expect(models).toEqual(["gpt-6-astra-high", "gpt-6-mini"]);
  });

  it("读不懂或者没有 model 的配置就是什么都没说", () => {
    expect(parseCodexConfigModels("")).toEqual([]);
    expect(
      parseCodexConfigModels('[profiles.x]\napproval = "never"\n'),
    ).toEqual([]);
    expect(parseCodexConfigModels('model = ""')).toEqual([]);
  });
});

describe("拼出来的菜单", () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "armadra-codex-home-"));
    forgetMenus();
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
    forgetMenus();
  });

  it("Codex 读的是 `CODEX_HOME` 指的那份配置，而且只读", async () => {
    writeFileSync(
      join(directory, "config.toml"),
      'model = "gpt-6-astra-high"\n',
    );
    const models = await menuFor({
      baseAgent: "codex",
      launchCmd: "codex",
      catalog: CATALOG,
      env: { CODEX_HOME: directory },
    });
    expect(models[0]).toEqual({
      id: "gpt-6-astra-high",
      label: "gpt-6-astra-high",
      source: "cli",
    });
    // 目录那一档跟在后面。
    expect(models.map((model) => model.id)).toContain("gpt-6");
  });

  it("装不上的 CLI 不起进程，答案只来自目录和兜底", async () => {
    const models = await menuFor({
      baseAgent: "claude",
      launchCmd: "armadra-definitely-not-a-real-binary",
      catalog: CATALOG,
      env: { PATH: directory },
    });
    expect(models.every((model) => model.source !== "cli")).toBe(true);
    expect(models[0]?.id).toBe("claude-opus-5");
  });

  it("同一个 (适配器, 启动程序) 在 TTL 内复用，过了就重拼", async () => {
    const config = join(directory, "config.toml");
    writeFileSync(config, 'model = "first"\n');
    let clock = 1_000;
    const ask = () =>
      menuFor({
        baseAgent: "codex",
        launchCmd: "codex",
        catalog: CATALOG,
        env: { CODEX_HOME: directory },
        now: () => clock,
      });
    expect((await ask())[0]?.id).toBe("first");
    writeFileSync(config, 'model = "second"\n');
    // 还在 TTL 里：记着的那份原样返回。
    clock += MENU_CACHE_TTL_MS - 1;
    expect((await ask())[0]?.id).toBe("first");
    clock += 1;
    expect((await ask())[0]?.id).toBe("second");
  });

  it("换一个启动程序就是换一个问题", async () => {
    writeFileSync(join(directory, "config.toml"), 'model = "shared"\n');
    const first = await menuFor({
      baseAgent: "codex",
      launchCmd: "codex",
      catalog: CATALOG,
      env: { CODEX_HOME: directory },
    });
    const second = await menuFor({
      baseAgent: "codex",
      launchCmd: "/opt/bin/codex-nightly",
      catalog: CATALOG,
      env: { CODEX_HOME: directory },
    });
    expect(first[0]?.id).toBe("shared");
    expect(second[0]?.id).toBe("shared");
  });
});
