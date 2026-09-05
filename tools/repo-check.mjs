// 仓库完整性校验：读取 repo.rules.json，对 git 跟踪的文件做静态检查。
// 规则的自然语言版本见 docs/design/repository-structure.md §3。
//
//   node tools/repo-check.mjs [--root <目录>] [--rules <文件>] [--only <规则,规则>]
//
// 只读文件系统与 `git ls-files`，不编译、不联网，秒级完成。
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const RULES = [
  "docs-index",
  "links",
  "blacklist",
  "naming",
  "root-allowlist",
  "file-size",
  "migrations",
  "proto-coverage",
];

// ------------------------------------------------------------------ helpers

/** git 跟踪的文件，路径统一用 `/` 分隔，便于规则里直接写字面量。 */
export function trackedFiles(root) {
  const output = execFileSync("git", ["-C", root, "ls-files", "-z"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return output.split("\0").filter(Boolean);
}

function readIfPresent(root, relativePath) {
  const absolute = join(root, relativePath);
  return existsSync(absolute) ? readFileSync(absolute, "utf8") : null;
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

/** `output/`、`*.db*` 这类简写模式：`/` 结尾匹配整个子树，`*` 不跨目录分隔符。 */
function patternToRegExp(pattern) {
  if (pattern.endsWith("/")) {
    const head = pattern.slice(0, -1).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|/)${head}/`);
  }
  const body = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^/]*");
  return new RegExp(`(^|/)${body}$`);
}

/** Markdown 与内嵌 HTML 中指向仓库内文件的链接。 */
function localLinks(markdown) {
  const targets = [];
  const inline = /\[[^\]]*\]\(\s*<?([^)<>\s]+)>?(?:\s+"[^"]*")?\s*\)/g;
  const html = /\b(?:src|href)\s*=\s*"([^"]+)"/g;
  for (const source of [inline, html]) {
    let match;
    while ((match = source.exec(markdown)) !== null) targets.push(match[1]);
  }
  return targets.filter(
    (target) =>
      !/^[a-z][a-z0-9+.-]*:/i.test(target) &&
      !target.startsWith("#") &&
      !target.startsWith("//"),
  );
}

/** 索引里出现过的路径：链接目标与行内代码都算登记。 */
function registeredPaths(markdown) {
  const registered = new Set(localLinks(markdown).map(stripAnchor));
  const code = /`([^`\n]+)`/g;
  let match;
  while ((match = code.exec(markdown)) !== null) registered.add(match[1]);
  return registered;
}

function stripAnchor(target) {
  const withoutAnchor = target.split("#")[0].split("?")[0];
  return withoutAnchor.replace(/^\.\//, "");
}

function tomlPackageName(text) {
  const section = text
    .split(/^\[/m)
    .find((part) => part.startsWith("package]"));
  return section?.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1] ?? null;
}

function countLines(absolute) {
  const text = readFileSync(absolute, "utf8");
  if (text.length === 0) return 0;
  const lines = text.split("\n").length;
  return text.endsWith("\n") ? lines - 1 : lines;
}

// ------------------------------------------------------------------- checks

function checkDocsIndex(context, problems) {
  const rule = context.rules.docs;
  if (!rule) return;
  const index = readIfPresent(context.root, rule.index);
  if (index === null) {
    problems.push(`文档索引缺失：${rule.index}`);
    return;
  }
  const registered = registeredPaths(index);
  const directoryOnly = rule.directoryOnly ?? [];
  const pending = new Set(directoryOnly);
  for (const path of context.files) {
    if (!path.startsWith(`${rule.root}/`) || !path.endsWith(".md")) continue;
    const inDocs = path.slice(rule.root.length + 1);
    if (path === rule.index) continue;
    const directory = directoryOnly.find(
      (name) => inDocs === name || inDocs.startsWith(`${name}/`),
    );
    if (directory) {
      const covered = [...registered].some(
        (entry) => entry === directory || entry.startsWith(`${directory}/`),
      );
      if (covered) pending.delete(directory);
      continue;
    }
    if (!registered.has(inDocs)) {
      problems.push(`文档未在 ${rule.index} 登记：${path}`);
    }
  }
  for (const directory of pending) {
    if (
      context.files.some((path) =>
        path.startsWith(`${rule.root}/${directory}/`),
      )
    ) {
      problems.push(`目录未在 ${rule.index} 登记：${rule.root}/${directory}/`);
    }
  }
}

function checkLinks(context, problems) {
  const rule = context.rules.links;
  if (!rule) return;
  const matchers = (rule.include ?? []).map(patternToRegExp);
  const excluded = (rule.exclude ?? []).map(patternToRegExp);
  const skip = new Set(rule.ignoreTargets ?? []);
  for (const path of context.files) {
    if (!path.endsWith(".md")) continue;
    if (
      matchers.length > 0 &&
      !matchers.some((matcher) => matcher.test(path))
    ) {
      continue;
    }
    if (excluded.some((matcher) => matcher.test(path))) continue;
    const text = readFileSync(join(context.root, path), "utf8");
    for (const target of localLinks(text)) {
      const cleaned = stripAnchor(target);
      if (cleaned === "" || skip.has(cleaned)) continue;
      const resolved = normalize(join(dirname(path), cleaned));
      if (resolved.startsWith("..")) {
        problems.push(`链接越出仓库：${path} → ${target}`);
        continue;
      }
      if (!existsSync(join(context.root, resolved))) {
        problems.push(`链接无法解析：${path} → ${target}`);
      }
    }
  }
}

function checkBlacklist(context, problems) {
  const patterns = context.rules.blacklist ?? [];
  const matchers = patterns.map((pattern) => [
    pattern,
    patternToRegExp(pattern),
  ]);
  for (const path of context.files) {
    for (const [pattern, matcher] of matchers) {
      if (matcher.test(path))
        problems.push(`禁止跟踪的文件：${path}（${pattern}）`);
    }
  }
}

function checkNaming(context, problems) {
  for (const rule of context.rules.naming ?? []) {
    const base = join(context.root, rule.directory);
    if (!existsSync(base)) continue;
    // 待改名目录登记在这里，改名落地后必须删除条目，否则本检查报告过期豁免。
    const exempt = new Map(
      (rule.exemptions ?? []).map((item) => [item.directory, item]),
    );
    const usedExemptions = new Set();
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifest = join(base, entry.name, rule.manifest);
      if (!existsSync(manifest)) continue;
      const text = readFileSync(manifest, "utf8");
      const name = rule.manifest.endsWith(".json")
        ? JSON.parse(text).name
        : tomlPackageName(text);
      if (!name) {
        problems.push(
          `无法读取包名：${rule.directory}/${entry.name}/${rule.manifest}`,
        );
        continue;
      }
      const expected = name.startsWith(rule.prefix)
        ? name.slice(rule.prefix.length)
        : name;
      if (expected === entry.name) continue;
      const directory = `${rule.directory}/${entry.name}`;
      if (exempt.has(directory)) {
        usedExemptions.add(directory);
        continue;
      }
      problems.push(
        `目录名与包名不一致：${directory} 应为 ${rule.directory}/${expected}（${name}）`,
      );
    }
    for (const directory of exempt.keys()) {
      if (!usedExemptions.has(directory)) {
        problems.push(
          `改名豁免已过期，可从 repo.rules.json 移除：${directory}`,
        );
      }
    }
  }
}

function checkRootAllowlist(context, problems) {
  const allow = new Set(context.rules.root ?? []);
  if (allow.size === 0) return;
  const seen = new Set(context.files.map((path) => path.split("/")[0]));
  for (const entry of [...seen].sort()) {
    if (!allow.has(entry)) problems.push(`根目录不在白名单：${entry}`);
  }
}

function checkFileSize(context, problems) {
  const rule = context.rules.fileSize;
  if (!rule) return;
  const exemptions = new Map(
    (rule.exemptions ?? []).map((entry) => [entry.path, entry]),
  );
  const used = new Set();
  for (const path of context.files) {
    if (!(rule.roots ?? []).some((root) => path.startsWith(`${root}/`)))
      continue;
    if (!(rule.extensions ?? []).some((suffix) => path.endsWith(suffix)))
      continue;
    if (
      (rule.excludeSegments ?? []).some((segment) => path.includes(segment))
    ) {
      continue;
    }
    const absolute = join(context.root, path);
    if (!existsSync(absolute)) continue;
    const lines = countLines(absolute);
    const exemption = exemptions.get(path);
    if (lines <= rule.max) {
      if (exemption) {
        used.add(path);
        problems.push(
          `豁免已过期，可从 repo.rules.json 移除：${path}（${lines} 行）`,
        );
      }
      continue;
    }
    if (!exemption) {
      problems.push(`源码单文件超过 ${rule.max} 行：${path}（${lines} 行）`);
      continue;
    }
    used.add(path);
    if (lines > exemption.lines) {
      problems.push(
        `豁免文件继续增长：${path}（${lines} 行 > 登记的 ${exemption.lines} 行）`,
      );
    }
  }
  for (const path of exemptions.keys()) {
    if (!used.has(path)) problems.push(`豁免登记的文件不存在：${path}`);
  }
}

/**
 * 迁移编号必须从 1 起连续。并行批次会提前分配编号，尚未合入的那一个登记在
 * `reserved` 里：它只占位参与连续性检查，对应文件必须还不存在——否则占位就
 * 成了「谁都可以跳号」的口子。
 */
function checkMigrationNumbers(label, numbers, reserved, problems) {
  const present = new Set(numbers);
  for (const number of reserved) {
    if (present.has(number)) {
      problems.push(`预留的迁移编号已经被占用：${label} ${number}`);
    }
  }
  [...numbers, ...reserved]
    .sort((left, right) => left - right)
    .forEach((value, index) => {
      if (value !== index + 1) {
        problems.push(`迁移编号不连续：${label} 第 ${index + 1} 个为 ${value}`);
      }
    });
}

/** Host 的 schema 是 Go 里的字符串常量，按常量名当作编号迁移读取。 */
function goSchemaConstants(text, pattern) {
  const source = new RegExp(`${pattern}\\s*=\\s*\`([\\s\\S]*?)\``, "g");
  const found = new Map();
  let match;
  while ((match = source.exec(text)) !== null) found.set(match[1], match[2]);
  return found;
}

function checkMigrations(context, problems) {
  const rule = context.rules.migrations;
  if (!rule) return;
  const lockText = readIfPresent(context.root, rule.lock);
  if (lockText === null) {
    problems.push(`迁移校验表缺失：${rule.lock}`);
    return;
  }
  const lock = JSON.parse(lockText);
  for (const source of rule.sources ?? []) {
    const recorded = lock[source.path] ?? {};
    const actual = new Map();
    if (source.kind === "directory") {
      const base = join(context.root, source.path);
      if (!existsSync(base)) {
        problems.push(`迁移目录缺失：${source.path}`);
        continue;
      }
      for (const name of readdirSync(base).sort()) {
        if (!name.endsWith(".sql")) continue;
        actual.set(name, sha256(readFileSync(join(base, name))));
      }
      checkMigrationNumbers(
        source.path,
        [...actual.keys()].map((name) => Number.parseInt(name.slice(0, 4), 10)),
        source.reserved ?? [],
        problems,
      );
    } else {
      const text = readIfPresent(context.root, source.path);
      if (text === null) {
        problems.push(`迁移来源缺失：${source.path}`);
        continue;
      }
      const constants = goSchemaConstants(text, source.pattern);
      for (const [key, body] of constants)
        actual.set(key, sha256(Buffer.from(body)));
      checkMigrationNumbers(
        source.path,
        [...constants.keys()].map((key) =>
          Number.parseInt(key.replace(/\D+/g, ""), 10),
        ),
        source.reserved ?? [],
        problems,
      );
    }
    for (const [name, digest] of actual) {
      const expected = recorded[name];
      if (expected === undefined) {
        problems.push(
          `新迁移未登记到 ${rule.lock}：${source.path}/${name}（sha256 ${digest}）`,
        );
      } else if (expected !== digest) {
        problems.push(`已发布迁移被改动：${source.path}/${name}`);
      }
    }
    for (const name of Object.keys(recorded)) {
      if (!actual.has(name)) {
        problems.push(`已登记的迁移消失：${source.path}/${name}`);
      }
    }
  }
}

function readAll(root, directory, suffix) {
  const base = join(root, directory);
  if (!existsSync(base)) return "";
  return readdirSync(base)
    .filter((name) => name.endsWith(suffix))
    .sort()
    .map((name) => readFileSync(join(base, name), "utf8"))
    .join("\n");
}

function checkProtoCoverage(context, problems) {
  const rule = context.rules.proto;
  if (!rule) return;
  const schemaDir = join(context.root, rule.schemas);
  if (!existsSync(schemaDir)) {
    problems.push(`协议目录缺失：${rule.schemas}`);
    return;
  }
  const go = readAll(context.root, rule.goTests, "_test.go");
  const rust = readAll(context.root, rule.rustTests, ".rs");
  const typescript = readAll(context.root, rule.tsTests, ".ts");
  // Go 契约测试把 fixture 名映射到消息，是三端 fixture 的唯一产地。
  const fixtures = new Map();
  const pair = /"([a-z0-9_]+)"\s*:\s*&pb\.(\w+)\{/g;
  let match;
  while ((match = pair.exec(go)) !== null) fixtures.set(match[1], match[2]);
  for (const name of readdirSync(schemaDir).sort()) {
    if (!name.endsWith(".proto")) continue;
    const path = `${rule.schemas}/${name}`;
    const text = readFileSync(join(schemaDir, name), "utf8");
    const messages = [...text.matchAll(/^message\s+(\w+)/gm)].map(
      (hit) => hit[1],
    );
    if (messages.length === 0) {
      problems.push(`协议文件没有顶层消息：${path}`);
      continue;
    }
    const owned = messages.filter((message) =>
      [...fixtures.values()].includes(message),
    );
    const withFixture = [...fixtures.entries()].filter(
      ([fixture, message]) =>
        owned.includes(message) &&
        existsSync(join(context.root, rule.fixtures, `${fixture}.hex`)),
    );
    if (withFixture.length === 0) {
      problems.push(`协议文件缺少 ${rule.fixtures} 样例：${path}`);
    }
    const inRust = messages.some((message) =>
      new RegExp(`\\b${message}\\b`).test(rust),
    );
    const inTypescript = messages.some((message) =>
      new RegExp(`\\b${message}Schema\\b`).test(typescript),
    );
    if (owned.length === 0)
      problems.push(`协议文件未被 Go 契约测试引用：${path}`);
    if (!inRust) problems.push(`协议文件未被 Rust 契约测试引用：${path}`);
    if (!inTypescript) problems.push(`协议文件未被 TS 契约测试引用：${path}`);
  }
}

const CHECKS = {
  "docs-index": checkDocsIndex,
  links: checkLinks,
  blacklist: checkBlacklist,
  naming: checkNaming,
  "root-allowlist": checkRootAllowlist,
  "file-size": checkFileSize,
  migrations: checkMigrations,
  "proto-coverage": checkProtoCoverage,
};

/** 对一个仓库根跑规则，返回问题列表；空列表表示通过。 */
export function checkRepository({ root, rules, files, only }) {
  const context = {
    root,
    rules,
    files: files ?? trackedFiles(root),
  };
  const problems = [];
  for (const name of only ?? RULES) {
    const check = CHECKS[name];
    if (!check) throw new Error(`未知规则：${name}`);
    check(context, problems);
  }
  return problems;
}

// ---------------------------------------------------------------------- cli

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--root") options.root = argv[(index += 1)];
    else if (flag === "--rules") options.rules = argv[(index += 1)];
    else if (flag === "--only") options.only = argv[(index += 1)].split(",");
    else throw new Error(`未知参数：${flag}`);
  }
  return options;
}

const invokedDirectly =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const options = parseArguments(process.argv.slice(2));
  const root = resolve(
    options.root ?? fileURLToPath(new URL("../", import.meta.url)),
  );
  const rulesPath = resolve(root, options.rules ?? "repo.rules.json");
  const rules = JSON.parse(readFileSync(rulesPath, "utf8"));
  const started = Date.now();
  const problems = checkRepository({ root, rules, only: options.only });
  if (problems.length > 0) {
    for (const problem of problems) console.error(`✗ ${problem}`);
    console.error(`\n仓库校验失败：${problems.length} 处问题`);
    process.exit(1);
  }
  console.log(
    `仓库校验通过（${(options.only ?? RULES).length} 条规则，${Date.now() - started}ms）`,
  );
}
