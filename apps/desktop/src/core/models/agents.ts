/**
 * 节点头部「模型」菜单里可以有什么，按 CLI 分（用户实测反馈 F7）。
 *
 * 移植自 合并前的实现。这份列表曾经是 `packages/shared`
 * 里的常量，发版当天就过时：用户的 CLI 已经在跑一个更新的模型，菜单里既没有它
 * 也没有任何别的写法。一张出厂即过期的列表比没有列表更糟，因为它看起来很权威。
 *
 * 所以列表是**拼**出来的，按这个权威顺序：
 *
 *   1. **CLI 自己。** 一个 CLI 关于自己模型的说法压过我们知道的一切：只有它反映
 *      这个账号的额度和这台机器的配置。`claude --help` 在 `--model` 的说明里写
 *      着别名；Codex 把答案放在 `config.toml` 里（`codex --help` 一个模型都不
 *      列）。
 *   2. **models.dev 目录**（{@link import("./catalog")}），过滤到这个 CLI 说话
 *      的那家 provider，按发布日期倒序。
 *   3. **内置兜底**，给一个从没联过网、CLI 又什么都不说的 core。只是为了首次离
 *      线启动时菜单不是空的。
 *
 * 每条都注明自己是三者中的哪一个，因为「CLI 告诉我们的」和「目录里最新的那
 * 个」是两种不同的说法，菜单不该把它们摆成同一种。
 *
 * 什么都不选在哪儿都合法：那保留 CLI 自己的默认值，而那仍然是唯一一个肯定正确
 * 的设置。
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { resolveCommand } from "../agent/registry";
import { type Catalog, providerModels } from "./catalog";

/** 一个 CLI 到这会儿还没打印出帮助，就不会打印了。 */
const HELP_TIMEOUT_MS = 8_000;
/** 帮助是一页纸。超过这个的不是帮助。 */
const MAX_OUTPUT_BYTES = 256 * 1024;
/**
 * 拼好的列表复用多久。短到装一个 CLI 升级能在这次会话里看见，长到反复开菜单不
 * 会反复起进程。
 */
export const MENU_CACHE_TTL_MS = 10 * 60_000;

/** 菜单里一条的来源。 */
export type ModelSource = "cli" | "catalog" | "builtin";

export interface AgentModel {
  /** 原样放到启动行 `--model` 后面的值。 */
  readonly id: string;
  /** 菜单显示的字。目录有显示名就用它，否则就是 id 本身——不做美化的猜测。 */
  readonly label: string;
  readonly source: ModelSource;
  /** `YYYY-MM-DD`，目录公布了才有。 */
  readonly releaseDate?: string;
}

/**
 * 这个适配器可以被提供哪一家目录条目。
 *
 * 可以指向任意 provider 的 CLI（opencode、pi、omp）是 `undefined`：替它列出某一
 * 家的模型，是在猜一个我们看不见的账号，而在 CLI 自己开口之前，空菜单才是诚实
 * 的答案。
 */
export function catalogProvider(baseAgent: string): string | undefined {
  switch (baseAgent) {
    case "claude":
      return "anthropic";
    case "codex":
      return "openai";
    case "copilot":
      return "github-copilot";
    default:
      return undefined;
  }
}

/**
 * 离线兜底：以前 `packages/shared` 那张表是什么，这里就是什么，一个不多。
 * 和 `AGENT_MODEL_SUGGESTIONS` 逐行一致——页面取不到 core 时退回的就是它。
 */
export function builtinModels(baseAgent: string): readonly string[] {
  switch (baseAgent) {
    case "claude":
      return ["opus", "sonnet", "haiku"];
    case "codex":
      return ["gpt-5-codex", "gpt-5"];
    default:
      return [];
  }
}

/**
 * 一个这个 CLI 真的能被叫去跑的目录 id。
 *
 * Anthropic 和 OpenAI 把图像、音频、嵌入模型和对话模型放在同一家 provider 下；
 * 在一个写代码的 Agent 菜单里提供 `text-embedding-3-large` 只是噪音。
 */
export function isSelectable(modelId: string): boolean {
  const id = modelId.toLowerCase();
  return ![
    "embedding",
    "image",
    "video",
    "audio",
    "tts",
    "whisper",
    "moderation",
    "realtime",
    "search",
  ].some((needle) => id.includes(needle));
}

/** 去重用的键。大小写与首尾空白不算区别，别的都算。 */
function normalizeModelId(id: string): string {
  return id.trim().toLowerCase();
}

/**
 * 合并本身，两个输入都是传进来的：不起进程、不读缓存、不看钟。上面每一条顺序与
 * 优先级规则都在这里裁决。
 */
export function assemble(
  baseAgent: string,
  fromCli: readonly string[],
  catalog: Catalog,
): AgentModel[] {
  const models: AgentModel[] = [];
  const seen = new Set<string>();
  const push = (model: AgentModel): void => {
    const key = normalizeModelId(model.id);
    if (key === "" || seen.has(key)) return;
    seen.add(key);
    models.push(model);
  };

  for (const id of fromCli) push({ id, label: id, source: "cli" });
  const provider = catalogProvider(baseAgent);
  if (provider !== undefined) {
    for (const model of providerModels(catalog, provider)) {
      if (!isSelectable(model.modelId)) continue;
      push({
        id: model.modelId,
        label: model.name,
        source: "catalog",
        ...(model.releaseDate === undefined
          ? {}
          : { releaseDate: model.releaseDate }),
      });
    }
  }
  for (const id of builtinModels(baseAgent)) {
    push({ id, label: id, source: "builtin" });
  }

  // 最新的在前，分三档。
  //
  // CLI 说出来的排最前，哪怕它没有日期：一个别名指向该系列最新的模型，而用户配
  // 好的那个就是他正在跑的，两者都不可能比后面任何一条更旧。然后是所有带日期
  // 的，新的在前。离线兜底排最后：这个构建碰巧带了某个 id，不构成关于任何事情
  // 的证据，更不该压过厂商后来发布的模型。
  const band = (model: AgentModel): number => {
    if (model.source === "cli" && model.releaseDate === undefined) return 0;
    return model.releaseDate === undefined ? 2 : 1;
  };
  return models.sort(
    (left, right) =>
      band(left) - band(right) ||
      (right.releaseDate ?? "").localeCompare(left.releaseDate ?? ""),
  );
}

/* ------------------------------ CLI 自己的说法 ----------------------------- */

/** `claude --help` 里 `--model` 说明中被引号括起来的那些名字。 */
export function parseClaudeModelAliases(help: string): string[] {
  let block = "";
  let inside = false;
  for (const line of help.split("\n")) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("--model")) {
      inside = true;
    } else if (inside) {
      // 续行比选项那一列缩得更深；下一个选项开启新的一段。
      if (trimmed === "" || trimmed.startsWith("-")) break;
    }
    if (inside) block += ` ${trimmed}`;
  }
  const models: string[] = [];
  let index = 0;
  while (index < block.length) {
    if (block[index] !== "'") {
      index += 1;
      continue;
    }
    // 紧跟在字母数字后面的引号是撇号——说明里写着 "a model's full name"——它不
    // 开启任何东西。
    const previous = block[index - 1];
    if (previous !== undefined && /[A-Za-z0-9]/.test(previous)) {
      index += 1;
      continue;
    }
    const close = block.indexOf("'", index + 1);
    if (close < 0) break;
    const candidate = block.slice(index + 1, close);
    if (isModelName(candidate)) {
      if (!models.includes(candidate)) models.push(candidate);
      index = close + 1;
    } else {
      index += 1;
    }
  }
  return models;
}

/** `--model` 后面可以打什么：没有空格，不是散文。 */
function isModelName(candidate: string): boolean {
  return (
    candidate.length > 0 &&
    candidate.length <= 64 &&
    /^[A-Za-z0-9\-._[\]]+$/.test(candidate)
  );
}

/**
 * `${CODEX_HOME:-~/.codex}/config.toml` 里写着的模型：顶层的 `model`，以及每个
 * `[profiles.*]` 的 `model`，按文件顺序。
 *
 * Codex 的 `--model` 接受配置好的 provider 认的任何东西，它的帮助一个都不列，所
 * 以用户的配置是关于「这套安装跑哪些模型」唯一一句本地的话。**只读**：这个函数
 * 从不写用户的配置目录。
 */
export function parseCodexConfigModels(contents: string): string[] {
  const models: string[] = [];
  let section = "";
  const push = (value: string | undefined): void => {
    if (value === undefined || value === "") return;
    if (!models.includes(value)) models.push(value);
  };
  for (const raw of contents.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const header = /^\[\s*([^\]]+?)\s*\]$/.exec(line);
    if (header) {
      section = (header[1] ?? "").trim();
      continue;
    }
    // 只认顶层和 profile 表里的 `model`；`model_providers` 命名的是 provider 而
    // 不是模型，从一个 provider 条目里编出模型 id 是猜。
    const inProfiles =
      section === "" ||
      section.startsWith("profiles.") ||
      section.startsWith("profile.");
    if (!inProfiles) continue;
    const assignment = /^model\s*=\s*(.+)$/.exec(line);
    if (!assignment) continue;
    push(unquote(assignment[1] ?? ""));
  }
  return models;
}

function unquote(value: string): string | undefined {
  const text = value
    .trim()
    .replace(/\s*#.*$/, "")
    .trim();
  const quoted = /^(["'])(.*)\1$/.exec(text);
  const inner = (quoted ? (quoted[2] ?? "") : text).trim();
  return inner === "" ? undefined : inner;
}

function codexConfigModels(env: NodeJS.ProcessEnv): string[] {
  const home = env.CODEX_HOME;
  const directory =
    home !== undefined && home !== "" ? home : join(homedir(), ".codex");
  try {
    return parseCodexConfigModels(
      readFileSync(join(directory, "config.toml"), "utf8"),
    );
  } catch {
    // 没有配置文件的 Codex 就是什么都没说。
    return [];
  }
}

/**
 * 跑 `<program> --help`，stdin 关掉、有截止时间、读取有上限。和版本探测同一套规
 * 矩：不过 shell、不带用户的 argv。
 */
export function runHelp(program: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(program, ["--help"], {
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      resolve(undefined);
      return;
    }
    let output = "";
    let settled = false;
    const finish = (value: string | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      try {
        child.kill();
      } catch {
        // 已经退了。
      }
      resolve(value);
    };
    const deadline = setTimeout(() => finish(undefined), HELP_TIMEOUT_MS);
    deadline.unref?.();
    child.stdout?.on("data", (chunk: Buffer) => {
      if (output.length < MAX_OUTPUT_BYTES) output += chunk.toString("utf8");
    });
    child.on("error", () => finish(undefined));
    child.on("close", () => finish(output));
    child.unref?.();
  });
}

/** CLI 关于自己模型的说法。它什么都不说就是空的。 */
async function cliModels(
  baseAgent: string,
  launchCmd: string | undefined,
  env: NodeJS.ProcessEnv,
): Promise<string[]> {
  switch (baseAgent) {
    case "claude": {
      const program =
        launchCmd === undefined ? undefined : resolveCommand(launchCmd, env);
      if (program === undefined) return [];
      return parseClaudeModelAliases((await runHelp(program)) ?? "");
    }
    case "codex":
      // Codex 把答案放在文件里而不是帮助里。
      return codexConfigModels(env);
    default:
      return [];
  }
}

/* ---------------------------------- 缓存 ---------------------------------- */

interface CachedMenu {
  readonly at: number;
  readonly models: readonly AgentModel[];
}

const CACHE = new Map<string, CachedMenu>();

/**
 * 丢掉记着的那些列表。目录刷新之后调，这样菜单不必等满 TTL 就反映新目录。
 */
export function forgetMenus(): void {
  CACHE.clear();
}

export interface MenuOptions {
  readonly baseAgent: string;
  readonly launchCmd?: string;
  readonly catalog: Catalog;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => number;
}

/**
 * 拼出一个适配器的列表。
 *
 * `baseAgent` 是内置适配器——一个 `custom:` 条目借基础适配器的模型，就像它借
 * hooks 那样；但探的是**它自己**那个启动程序，因为那才是它的终端会跑的二进制。
 */
export async function menuFor(options: MenuOptions): Promise<AgentModel[]> {
  const now = options.now ?? (() => Date.now());
  // 两个自定义条目可以共用一个基础适配器却指向不同的程序，所以程序是被记住的
  // 那件事的一部分。
  const key = `${options.baseAgent} ${options.launchCmd ?? ""}`;
  const cached = CACHE.get(key);
  if (cached !== undefined && now() - cached.at < MENU_CACHE_TTL_MS) {
    return [...cached.models];
  }
  const models = assemble(
    options.baseAgent,
    await cliModels(
      options.baseAgent,
      options.launchCmd,
      options.env ?? process.env,
    ),
    options.catalog,
  );
  CACHE.set(key, { at: now(), models });
  return models;
}
