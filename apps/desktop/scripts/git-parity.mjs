/**
 * Field-level parity between the TypeScript core's Git domain and the Rust
 * Runtime's.
 *
 * Both are started against the *same* temporary repository and asked the same
 * questions in the same order; every answer is compared key for key after the
 * values that cannot be equal — ids, timestamps, absolute paths, digests over
 * any of those — are replaced by their shape.
 *
 * Run it with:
 *
 *   node apps/desktop/scripts/git-parity.mjs \
 *     --core apps/desktop/out/core/main.js \
 *     --runtime target/debug/armadra-runtime
 */
import { spawn, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index].replace(/^--/, ""), process.argv[index + 1]);
}
const CORE = args.get("core") ?? "apps/desktop/out/core/main.js";
const RUNTIME = args.get("runtime") ?? "target/debug/armadra-runtime";

/**
 * A fixed identity *and* a fixed clock.
 *
 * The clock is what makes the write half of this comparison possible: two
 * repositories built from the same script with the same dates have the same
 * object ids, so each process can be given its own copy to write to and the
 * answers still compare literally.
 */
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Parity",
  GIT_AUTHOR_EMAIL: "parity@example.invalid",
  GIT_COMMITTER_NAME: "Parity",
  GIT_COMMITTER_EMAIL: "parity@example.invalid",
  GIT_AUTHOR_DATE: "2026-01-02T03:04:05+00:00",
  GIT_COMMITTER_DATE: "2026-01-02T03:04:05+00:00",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

function git(cwd, ...rest) {
  const result = spawnSync("git", rest, {
    cwd,
    env: GIT_ENV,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`git ${rest.join(" ")}: ${result.stderr}`);
  }
  return result.stdout;
}

/** One repository both processes read, built once and never written after. */
function buildRepository() {
  // Canonicalised: on macOS `os.tmpdir()` sits under `/var`, which is a link
  // to `/private/var`, and both processes refuse a root with a link in it.
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "armadra-parity-repo-")),
  );
  git(root, "init", "-q", "-b", "main");
  writeFileSync(join(root, "README.md"), "seed\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "seed");
  writeFileSync(join(root, "one.txt"), "one\ntwo\nthree\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "add one");
  git(root, "tag", "v1");
  git(root, "tag", "-a", "-m", "annotated", "v2");
  git(root, "remote", "add", "origin", "https://example.invalid/repo.git");
  mkdirSync(join(root, "apps/inner"), { recursive: true });
  git(join(root, "apps/inner"), "init", "-q", "-b", "main");
  writeFileSync(join(root, "apps/inner/inner.txt"), "inner\n");
  git(join(root, "apps/inner"), "add", "-A");
  git(join(root, "apps/inner"), "commit", "-q", "-m", "inner seed");
  // A dirty worktree: one staged edit, one unstaged, one untracked.
  writeFileSync(join(root, "one.txt"), "one\nchanged\nthree\n");
  git(root, "add", "one.txt");
  writeFileSync(join(root, "README.md"), "seed\nmore\n");
  writeFileSync(join(root, "fresh.txt"), "fresh\n");
  git(root, "stash", "push", "--keep-index", "-m", "parity stash");
  return root;
}

/**
 * A repository each process gets its own copy of, for the write comparison.
 *
 * Deliberately simpler than the read fixture: nothing in it is a nested
 * checkout or a stash, because a write sequence has to leave two repositories
 * in states that can be compared with `git status` afterwards.
 */
function buildWriteRepository() {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "armadra-parity-write-")),
  );
  git(root, "init", "-q", "-b", "main");
  writeFileSync(join(root, "README.md"), "seed\n");
  writeFileSync(join(root, "one.txt"), "one\ntwo\nthree\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "seed");
  writeFileSync(join(root, "one.txt"), "one\nchanged\nthree\n");
  writeFileSync(join(root, "fresh.txt"), "fresh\n");
  return root;
}

async function waitForHealth(base, deadlineMs = 30_000) {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    try {
      const response = await fetch(`${base}/health`);
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) throw new Error(`${base} never became healthy`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function startCore(port, dataDir) {
  const child = spawn(
    process.execPath,
    [CORE, "--listen", `tcp:127.0.0.1:${port}`, "--data-dir", dataDir],
    {
      env: { ...process.env, ARMADRA_CORE: "ts", ARMADRA_LOG: "error" },
      stdio: "pipe",
    },
  );
  child.stdout.resume();
  child.stderr.on("data", (chunk) => process.stderr.write(`core: ${chunk}`));
  return child;
}

function startRuntime(port, dataDir) {
  // The Runtime takes its data directory from the environment rather than a
  // flag; the shell sets it the same way.
  const child = spawn(RUNTIME, ["--listen", `tcp:127.0.0.1:${port}`], {
    env: { ...process.env, ARMADRA_DATA_DIR: dataDir, ARMADRA_LOG: "error" },
    stdio: "pipe",
  });
  child.stdout.resume();
  child.stderr.on("data", (chunk) => process.stderr.write(`runtime: ${chunk}`));
  return child;
}

async function call(base, method, path, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = text === "" ? null : JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed };
}

/**
 * Replace what cannot be equal between two processes with its shape.
 *
 * Absolute paths, uuids, object ids, timestamps and any digest over one of
 * those differ by construction; what parity means here is that the *keys* and
 * the *kinds* agree, and that everything else is equal literally.
 */
function normalize(value, root) {
  if (typeof value === "string") {
    if (value.startsWith(root)) return `<root>${value.slice(root.length)}`;
    if (/^[0-9a-f]{40}$/.test(value)) return "<oid>";
    if (/^[0-9a-f]{64}$/.test(value)) return "<digest>";
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value)) return "<time>";
    if (
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
        value,
      )
    ) {
      return "<uuid>";
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((entry) => normalize(entry, root));
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = normalize(value[key], root);
    }
    return out;
  }
  return value;
}

async function main() {
  const repo = buildRepository();
  const coreData = mkdtempSync(join(tmpdir(), "armadra-parity-core-"));
  const runtimeData = mkdtempSync(join(tmpdir(), "armadra-parity-runtime-"));
  const corePort = 45231;
  const runtimePort = 45232;
  const coreBase = `http://127.0.0.1:${corePort}`;
  const runtimeBase = `http://127.0.0.1:${runtimePort}`;
  const core = startCore(corePort, coreData);
  const runtime = startRuntime(runtimePort, runtimeData);
  const failures = [];
  const checked = [];
  const writeRoots = [];
  try {
    await waitForHealth(coreBase);
    await waitForHealth(runtimeBase);

    const register = async (base, root = repo) => {
      const created = await call(
        base,
        "POST",
        "/api/workspaces/open-directory",
        {
          name: "parity",
          rootPath: root,
        },
      );
      if (created.status !== 200) {
        throw new Error(`${base} refused the workspace: ${created.status}`);
      }
      const id = created.body.id;
      await call(base, "PATCH", `/api/workspaces/${id}`, {
        permissions: { read: true, write: true, execute: true },
      });
      return id;
    };
    const coreWorkspace = await register(coreBase);
    const runtimeWorkspace = await register(runtimeBase);

    const head = git(repo, "rev-parse", "HEAD").trim();
    const parent = git(repo, "rev-parse", "HEAD~1").trim();
    const requests = [
      ["GET", (ws) => `/api/workspaces/${ws}/git/status?path=.`],
      ["GET", (ws) => `/api/workspaces/${ws}/git/diff?path=.&scope=worktree`],
      ["GET", (ws) => `/api/workspaces/${ws}/git/diff?path=.&scope=staged`],
      ["GET", (ws) => `/api/workspaces/${ws}/git/head-commit?path=.`],
      ["GET", (ws) => `/api/workspaces/${ws}/git/repositories`],
      ["GET", (ws) => `/api/workspaces/${ws}/git/refs`],
      ["GET", (ws) => `/api/workspaces/${ws}/git/identity?path=.`],
      ["GET", (ws) => `/api/workspaces/${ws}/git/repository/branches?path=.`],
      ["GET", (ws) => `/api/workspaces/${ws}/git/repository/tags?path=.`],
      ["GET", (ws) => `/api/workspaces/${ws}/git/repository/remotes?path=.`],
      ["GET", (ws) => `/api/workspaces/${ws}/git/repository/worktrees?path=.`],
      ["GET", (ws) => `/api/workspaces/${ws}/git/repository/stashes?path=.`],
      [
        "GET",
        (ws) => `/api/workspaces/${ws}/git/repository/history?path=.&limit=5`,
      ],
      [
        "GET",
        (ws) => `/api/workspaces/${ws}/git/repository/reflog?path=.&limit=5`,
      ],
      [
        "GET",
        (ws) =>
          `/api/workspaces/${ws}/git/repository/commit?path=.&oid=${head}`,
      ],
      [
        "GET",
        (ws) =>
          `/api/workspaces/${ws}/git/repository/commit-file?path=.&oid=${head}&file=one.txt`,
      ],
      [
        "GET",
        (ws) =>
          `/api/workspaces/${ws}/git/repository/cherry-pick-preview?path=.&oid=${head}`,
      ],
      [
        "GET",
        (ws) =>
          `/api/workspaces/${ws}/git/repository/rebase-todo?path=.&onto=${parent}`,
      ],
      [
        "GET",
        (ws) => `/api/workspaces/${ws}/git/repository/integration?path=.`,
      ],
      ["GET", (ws) => `/api/workspaces/${ws}/git/repository/operations?path=.`],
      [
        "GET",
        (ws) =>
          `/api/workspaces/${ws}/git/hunks?path=.&file=one.txt&scope=staged`,
      ],
      ["GET", (ws) => `/api/workspaces/${ws}/git/message/providers`],
      [
        "POST",
        (ws) => `/api/workspaces/${ws}/git/repository/status-batch`,
        { paths: [".", "apps/inner"] },
      ],
      [
        "POST",
        (ws) => `/api/workspaces/${ws}/git/repository/worktree-binding`,
        { worktreePath: ".", branch: "main" },
      ],
      [
        "POST",
        (ws) => `/api/workspaces/${ws}/git/log`,
        { refs: { kind: "all" }, limit: 20 },
      ],
      // Refusals have to match too: the panel switches on `code`.
      ["GET", (ws) => `/api/workspaces/${ws}/git/status?path=../escape`],
      [
        "GET",
        (ws) => `/api/workspaces/${ws}/git/repository/history?path=.&limit=0`,
      ],
      [
        "GET",
        (ws) =>
          `/api/workspaces/${ws}/git/repository/reflog?path=.&reference=${head}`,
      ],
      [
        "GET",
        (ws) =>
          `/api/workspaces/${ws}/git/repository/commit?path=.&oid=${"a".repeat(40)}`,
      ],
      ["GET", () => "/api/git/clone/unknown-job"],
    ];

    for (const [method, path, body] of requests) {
      const mine = await call(coreBase, method, path(coreWorkspace), body);
      const theirs = await call(
        runtimeBase,
        method,
        path(runtimeWorkspace),
        body,
      );
      const left = JSON.stringify(
        { status: mine.status, body: normalize(mine.body, repo) },
        null,
        2,
      );
      const right = JSON.stringify(
        { status: theirs.status, body: normalize(theirs.body, repo) },
        null,
        2,
      );
      const label = `${method} ${path("<ws>")}`;
      checked.push(label);
      if (left !== right) {
        failures.push({ label, core: left, runtime: right });
      }
    }

    // The write half. A write changes what the *other* process would then see,
    // so each gets its own copy of a repository built from the same script
    // with the same dates — identical down to the object ids.
    const coreWrite = buildWriteRepository();
    const runtimeWrite = buildWriteRepository();
    const coreWriteWorkspace = await register(coreBase, coreWrite);
    const runtimeWriteWorkspace = await register(runtimeBase, runtimeWrite);
    writeRoots.push(coreWrite, runtimeWrite);
    const writeHead = git(coreWrite, "rev-parse", "HEAD").trim();
    if (git(runtimeWrite, "rev-parse", "HEAD").trim() !== writeHead) {
      throw new Error("the two write repositories are not identical");
    }
    const writes = [
      [
        "POST",
        (ws) => `/api/workspaces/${ws}/git/stage`,
        { path: ".", paths: ["one.txt"] },
      ],
      ["GET", (ws) => `/api/workspaces/${ws}/git/status?path=.`],
      [
        "POST",
        (ws) => `/api/workspaces/${ws}/git/unstage`,
        { path: ".", paths: ["one.txt"] },
      ],
      [
        "POST",
        (ws) => `/api/workspaces/${ws}/git/revert`,
        { path: ".", paths: ["one.txt"], source: "index" },
      ],
      [
        "POST",
        (ws) => `/api/workspaces/${ws}/git/stage`,
        { path: ".", paths: ["fresh.txt"] },
      ],
      [
        "POST",
        (ws) => `/api/workspaces/${ws}/git/commit`,
        { path: ".", message: "parity commit" },
      ],
      ["GET", (ws) => `/api/workspaces/${ws}/git/head-commit?path=.`],
      [
        "POST",
        (ws) => `/api/workspaces/${ws}/git/repository/operations`,
        {
          path: ".",
          action: {
            kind: "createBranch",
            name: "parity-branch",
            startPoint: null,
            switch: false,
          },
          expected: { headOid: writeHead, branch: "main" },
        },
      ],
      // Refusals on the write side have to match too.
      [
        "POST",
        (ws) => `/api/workspaces/${ws}/git/stage`,
        { path: ".", paths: ["../escape.txt"] },
      ],
      [
        "POST",
        (ws) => `/api/workspaces/${ws}/git/commit`,
        { path: ".", message: "   " },
      ],
      [
        "POST",
        (ws) => `/api/workspaces/${ws}/git/repository/operations`,
        {
          path: ".",
          action: {
            kind: "createBranch",
            name: "-dashed",
            startPoint: null,
            switch: false,
          },
          expected: { headOid: writeHead, branch: "main" },
        },
      ],
    ];
    for (const [method, path, body] of writes) {
      const mine = await call(coreBase, method, path(coreWriteWorkspace), body);
      const theirs = await call(
        runtimeBase,
        method,
        path(runtimeWriteWorkspace),
        body,
      );
      const left = JSON.stringify(
        { status: mine.status, body: normalize(mine.body, coreWrite) },
        null,
        2,
      );
      const right = JSON.stringify(
        { status: theirs.status, body: normalize(theirs.body, runtimeWrite) },
        null,
        2,
      );
      const label = `${method} ${path("<ws>")} (write)`;
      checked.push(label);
      if (left !== right) failures.push({ label, core: left, runtime: right });
    }
    // The two repositories must have ended up in the same state.
    for (const read of [
      ["status", "--porcelain=v1"],
      ["log", "--format=%s"],
      ["branch", "--format=%(refname)"],
    ]) {
      const label = `worktree parity: git ${read.join(" ")}`;
      checked.push(label);
      const left = git(coreWrite, ...read);
      const right = git(runtimeWrite, ...read);
      if (left !== right) failures.push({ label, core: left, runtime: right });
    }
  } finally {
    core.kill("SIGTERM");
    runtime.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 300));
    core.kill("SIGKILL");
    runtime.kill("SIGKILL");
    rmSync(repo, { recursive: true, force: true });
    for (const root of writeRoots) {
      rmSync(root, { recursive: true, force: true });
    }
    rmSync(coreData, { recursive: true, force: true });
    rmSync(runtimeData, { recursive: true, force: true });
  }

  process.stdout.write(`compared ${checked.length} requests\n`);
  for (const failure of failures) {
    process.stdout.write(
      `\n=== ${failure.label}\n--- core\n${failure.core}\n--- runtime\n${failure.runtime}\n`,
    );
  }
  process.stdout.write(
    failures.length === 0
      ? "every answer matched field for field\n"
      : `${failures.length} answers differ\n`,
  );
  process.exitCode = failures.length === 0 ? 0 : 1;
}

await main();
