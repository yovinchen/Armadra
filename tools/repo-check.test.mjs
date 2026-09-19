// node --test tools/repo-check.test.mjs
//
// 每条规则各验证一次「通过」与一次「被拦下」；文件树写在临时目录里，
// 跟踪列表直接传入，避免测试依赖 git 仓库状态。
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

import { RULES, checkRepository, trackedFiles } from "./repo-check.mjs";

const roots = [];

function repo(tree) {
  const root = mkdtempSync(join(tmpdir(), "repo-check-"));
  roots.push(root);
  for (const [path, content] of Object.entries(tree)) {
    const absolute = join(root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  }
  return root;
}

function run(root, rules, only, files) {
  return checkRepository({
    root,
    rules,
    only,
    files: files ?? Object.keys(rules.$files ?? {}),
  });
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

test("导出的规则名与实现一一对应", () => {
  assert.deepEqual([...RULES].sort(), [
    "blacklist",
    "docs-index",
    "file-size",
    "links",
    "migrations",
    "naming",
    "root-allowlist",
  ]);
  assert.throws(
    () => checkRepository({ root: ".", rules: {}, files: [], only: ["nope"] }),
    /未知规则/,
  );
});

test("docs-index：未登记的文档被拦下，history/ 只需登记目录", () => {
  const index =
    "# 索引\n\n[指南](guides/development.md)\n\n`history/` 保存旧文档。\n";
  const root = repo({ "docs/README.md": index });
  const rules = {
    docs: { root: "docs", index: "docs/README.md", directoryOnly: ["history"] },
  };
  const files = [
    "docs/README.md",
    "docs/guides/development.md",
    "docs/history/old.md",
  ];
  assert.deepEqual(run(root, rules, ["docs-index"], files), []);
  assert.deepEqual(
    run(root, rules, ["docs-index"], [...files, "docs/design/new.md"]),
    ["文档未在 docs/README.md 登记：docs/design/new.md"],
  );
});

test("docs-index：有 history/ 文件但索引没提到目录时报告", () => {
  const root = repo({ "docs/README.md": "# 索引\n" });
  const problems = run(
    root,
    {
      docs: {
        root: "docs",
        index: "docs/README.md",
        directoryOnly: ["history"],
      },
    },
    ["docs-index"],
    ["docs/README.md", "docs/history/old.md"],
  );
  assert.deepEqual(problems, ["目录未在 docs/README.md 登记：docs/history/"]);
});

test("links：相对链接必须可解析，外链与锚点跳过", () => {
  const root = repo({
    "docs/a.md":
      '# A\n\n[近邻](./b.md#锚)、[上级](../README.md)、[外链](https://example.com)\n<img src="img.png" />\n',
    "docs/b.md": "# B\n",
    "docs/img.png": "",
    "README.md": "# 根\n",
    "docs/c.md": "[断链](missing.md)\n",
  });
  const rules = { links: { include: ["docs/", "*.md"] } };
  const files = ["docs/a.md", "docs/b.md", "README.md"];
  assert.deepEqual(run(root, rules, ["links"], files), []);
  assert.deepEqual(run(root, rules, ["links"], [...files, "docs/c.md"]), [
    "链接无法解析：docs/c.md → missing.md",
  ]);
  assert.deepEqual(
    run(
      root,
      { links: { include: ["docs/"], exclude: ["docs/"] } },
      ["links"],
      [...files, "docs/c.md"],
    ),
    [],
  );
});

test("blacklist：黑名单文件一旦被跟踪就报告", () => {
  const root = repo({ "README.md": "" });
  const rules = { blacklist: ["output/", "*.db", "target/"] };
  assert.deepEqual(
    run(root, rules, ["blacklist"], ["README.md", "apps/x.rs"]),
    [],
  );
  assert.deepEqual(
    run(
      root,
      rules,
      ["blacklist"],
      ["output/report.json", "apps/canvas.db", "apps/desktop/target/x"],
    ),
    [
      "禁止跟踪的文件：output/report.json（output/）",
      "禁止跟踪的文件：apps/canvas.db（*.db）",
      "禁止跟踪的文件：apps/desktop/target/x（target/）",
    ],
  );
});

test("naming：目录名必须等于包名去掉前缀，豁免到期后报告", () => {
  const root = repo({
    "packages/shared/package.json": '{ "name": "@armadra/shared" }',
    "packages/shared-ts/package.json": '{ "name": "@armadra/extras" }',
    "apps/shell/package.json": '{ "name": "@armadra/desktop" }',
  });
  const base = [
    { directory: "packages", manifest: "package.json", prefix: "@armadra/" },
    { directory: "apps", manifest: "package.json", prefix: "@armadra/" },
  ];
  assert.deepEqual(run(root, { naming: base }, ["naming"], []), [
    "目录名与包名不一致：packages/shared-ts 应为 packages/extras（@armadra/extras）",
    "目录名与包名不一致：apps/shell 应为 apps/desktop（@armadra/desktop）",
  ]);
  const exempted = structuredClone(base);
  exempted[0].exemptions = [
    { directory: "packages/shared-ts", note: "待改名" },
  ];
  exempted[1].exemptions = [{ directory: "apps/shell", note: "待改名" }];
  assert.deepEqual(run(root, { naming: exempted }, ["naming"], []), []);
  const stale = structuredClone(exempted);
  stale[1].exemptions = [{ directory: "apps/desktop", note: "已改完" }];
  assert.deepEqual(run(root, { naming: stale }, ["naming"], []), [
    "目录名与包名不一致：apps/shell 应为 apps/desktop（@armadra/desktop）",
    "改名豁免已过期，可从 repo.rules.json 移除：apps/desktop",
  ]);
});

test("root-allowlist：根目录条目必须在白名单里", () => {
  const root = repo({ "README.md": "" });
  const rules = { root: ["README.md", "apps", "docs"] };
  assert.deepEqual(
    run(root, rules, ["root-allowlist"], ["README.md", "apps/web/main.ts"]),
    [],
  );
  assert.deepEqual(
    run(
      root,
      rules,
      ["root-allowlist"],
      ["README.md", "output/x", "notes.txt"],
    ),
    ["根目录不在白名单：notes.txt", "根目录不在白名单：output"],
  );
});

test("file-size：超限文件必须登记豁免，且只允许变小", () => {
  const root = repo({
    "apps/small.rs": "a\n".repeat(3),
    "apps/big.rs": "a\n".repeat(10),
    "apps/gen/huge.rs": "a\n".repeat(99),
  });
  const rule = {
    max: 5,
    roots: ["apps"],
    extensions: [".rs"],
    excludeSegments: ["/gen/"],
  };
  const files = ["apps/small.rs", "apps/big.rs", "apps/gen/huge.rs"];
  assert.deepEqual(run(root, { fileSize: rule }, ["file-size"], files), [
    "源码单文件超过 5 行：apps/big.rs（10 行）",
  ]);
  assert.deepEqual(
    run(
      root,
      {
        fileSize: { ...rule, exemptions: [{ path: "apps/big.rs", lines: 10 }] },
      },
      ["file-size"],
      files,
    ),
    [],
  );
  assert.deepEqual(
    run(
      root,
      {
        fileSize: { ...rule, exemptions: [{ path: "apps/big.rs", lines: 8 }] },
      },
      ["file-size"],
      files,
    ),
    ["豁免文件继续增长：apps/big.rs（10 行 > 登记的 8 行）"],
  );
  assert.deepEqual(
    run(
      root,
      {
        fileSize: {
          ...rule,
          exemptions: [
            { path: "apps/big.rs", lines: 10 },
            { path: "apps/small.rs", lines: 3 },
            { path: "apps/gone.rs", lines: 9 },
          ],
        },
      },
      ["file-size"],
      files,
    ),
    [
      "豁免已过期，可从 repo.rules.json 移除：apps/small.rs（3 行）",
      "豁免登记的文件不存在：apps/gone.rs",
    ],
  );
});

test("migrations：编号连续、已发布文件 sha256 不变", () => {
  const first = "create table a(id);\n";
  const second = "create table b(id);\n";
  const root = repo({
    "db/0001_a.sql": first,
    "db/0002_b.sql": second,
    "migrations.lock": JSON.stringify({
      db: { "0001_a.sql": sha256(first), "0002_b.sql": sha256(second) },
    }),
  });
  const rules = {
    migrations: {
      lock: "migrations.lock",
      sources: [{ path: "db", kind: "directory" }],
    },
  };
  assert.deepEqual(run(root, rules, ["migrations"], []), []);

  const drifted = repo({
    "db/0001_a.sql": first,
    "db/0003_c.sql": second,
    "migrations.lock": JSON.stringify({
      db: { "0001_a.sql": sha256("已改动\n") },
    }),
  });
  const problems = run(drifted, rules, ["migrations"], []);
  assert.deepEqual(problems, [
    "迁移编号不连续：db 第 2 个为 3",
    "已发布迁移被改动：db/0001_a.sql",
    `新迁移未登记到 migrations.lock：db/0003_c.sql（sha256 ${sha256(second)}）`,
  ]);
});

test("trackedFiles：读得到本仓库自己的跟踪列表", () => {
  const files = trackedFiles(fileURLToPath(new URL("../", import.meta.url)));
  assert.ok(files.includes("package.json"));
  assert.ok(files.every((path) => !path.startsWith("/")));
});
