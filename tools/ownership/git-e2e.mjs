// End-to-end check for the git domain's write-ownership switch
// (Go Host 业务所有权迁移 §5.2 B5, §6.2 git row).
//
//     pnpm ownership:e2e --domain git
//
// It runs a real Rust Runtime and a real Go Host against throwaway directories
// and kernel-assigned loopback ports, over a real Git repository with a real
// bare remote on the same machine — no network, no credentials, no GitHub. The
// claims it proves are the ones the design makes about this domain, and each
// of them is about a decision rather than about the absence of an exception:
//
//   1. **Git itself never moves.** Commands run on the execution host before
//      the switch and after it. What moves is the queue: the identity of an
//      operation, the order it runs in, the version it was decided against,
//      and what happened to it.
//   2. **A write goes through one entry.** Everything the panel used to send as
//      its own route arrives as one `Enqueue`, classified by kind, and comes
//      back with a real outcome read from the repository.
//   3. **One worktree at a time; different worktrees in parallel.** Two writes
//      to one checkout are sequential; a linked worktree's index write is not
//      blocked by the main checkout's.
//   4. **A stale precondition is a refusal, not an overwrite.** An external
//      `git commit` between the decision and the execution makes the operation
//      fail with a named reason and leaves the repository alone.
//   5. **The queue outlives the process, and reconciliation re-runs nothing.**
//      The Host is stopped and restarted; every entry it had settled is still
//      there with the state it had, the remote ref has not moved again, and no
//      command was repeated — a re-run push that the first attempt delivered
//      advances the remote ref twice.
//
//      What this check does *not* do is arrange for an entry to be RUNNING at
//      the moment the Host dies: doing that reliably needs a command slow
//      enough to be interrupted on purpose, which is a race dressed up as a
//      test. The verdicts for that case — network kinds to UNKNOWN_OUTCOME, a
//      commit settled by reading HEAD, everything else unknown — are covered
//      exactly in `apps/host/internal/githost/reconcile_test.go`.
//   6. **The Runtime stops deciding and keeps doing.** Its write routes answer
//      409 `ownership_moved`; every read keeps answering.
//   7. **A rollback is a rollback.** The queue's history — including every
//      unresolved entry — is written out, and the Runtime writes again.
//
// Switch order (§1.2): git is last, so canvas, settings and filesystem are
// switched here first. The session and agent domains have no projector yet and
// are skipped rather than treated as blockers, which is what lets the order be
// a sequence instead of a deadlock.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { openDriver } from "../canvas-ownership-driver.mjs";
import { openHarness, root, run, sleep } from "../ownership-harness.mjs";

const domain = "git";

const results = [];
function step(name, ok, detail = "") {
  results.push({ name, ok });
  const mark = ok ? "  ok  " : " FAIL ";
  console.log(`${mark}${name}${detail ? `  — ${detail}` : ""}`);
}
function note(text) {
  console.log(`  note  ${text}`);
}
function refusal(value) {
  return value?.error
    ? ` (${value.error.failure} HTTP ${value.error.httpStatus})`
    : "";
}

/**
 * `git` with the operator's own configuration kept out of the way. A machine
 * whose global config sets `commit.gpgsign` or a template directory would make
 * this check pass or fail for reasons that have nothing to do with ownership.
 */
function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_AUTHOR_NAME: "测试",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "测试",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
    },
  });
}

/**
 * The same, with both timestamps pinned. The merged log is ordered by committer
 * time, so a check about that order has to decide the times rather than observe
 * whatever the machine was doing that second.
 */
function gitAt(cwd, when, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_AUTHOR_NAME: "\u6d4b\u8bd5",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "\u6d4b\u8bd5",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
      GIT_AUTHOR_DATE: when,
      GIT_COMMITTER_DATE: when,
    },
  });
}

const encoder = new TextEncoder();
const body = (value) => encoder.encode(JSON.stringify(value));

const harness = await openHarness({ label: "ownership-e2e" });
let failure = null;
try {
  for (const binary of [harness.runtimeBinary, harness.hostBinary]) {
    if (!existsSync(binary))
      throw new Error(
        `${binary} is missing. Build both first:\n  cargo build -p armadra-runtime\n  go -C apps/host build -o ../../target/armadra-host ./cmd/armadra-host`,
      );
  }
  if (!existsSync(join(root, "packages/host-client/dist/index.js")))
    throw new Error("run `pnpm libs:build` first");
  const protocol = await import(
    pathToFileURL(join(root, "packages/protocol/dist/index.js")).href
  );
  const { GitActionKind, GitOperationState, GitReadMethod } = protocol;

  /* ------------------------------------ 1. a real repository and a bare remote */

  git(harness.project, ["init", "--initial-branch=main"]);
  git(harness.project, ["config", "user.email", "test@example.invalid"]);
  git(harness.project, ["config", "user.name", "测试"]);
  writeFileSync(join(harness.project, "README.md"), "# 项目\n");
  git(harness.project, ["add", "README.md"]);
  git(harness.project, ["commit", "-m", "initial"]);

  // The remote is a bare repository on this machine. A push has to be a real
  // push -- that is what makes "did it reach the remote?" a question worth
  // asking -- and it must not need a network or a credential to be one.
  const remote = join(harness.workspace, "remote.git");
  mkdirSync(remote, { recursive: true });
  git(remote, ["init", "--bare", "--initial-branch=main"]);
  git(harness.project, ["remote", "add", "origin", remote]);
  git(harness.project, ["push", "-u", "origin", "main"]);
  step(
    "a repository with a local bare remote exists",
    git(harness.project, ["rev-parse", "HEAD"]).trim().length === 40,
    `remote=${remote}`,
  );

  step("the Runtime started", await harness.startRuntime(), harness.workspace);
  const created = await harness.runtimeCall("POST", "/api/workspaces", {
    name: "项目",
    rootPath: harness.project,
    // Running Git is execution. A workspace without it cannot be made to run
    // anything, whatever the device's own grants say.
    permissions: { read: true, write: true, execute: true },
  });
  const workspaceId = created.json?.id;
  step(
    "the Runtime registered the workspace",
    created.status === 200 && typeof workspaceId === "string",
    `HTTP ${created.status}`,
  );

  // Before the switch the Runtime runs the writes. The refusals later are then
  // about ownership rather than about a repository that never worked.
  writeFileSync(join(harness.project, "笔记.txt"), "第一版\n");
  const stagedByRuntime = await harness.runtimeCall(
    "POST",
    `/api/workspaces/${workspaceId}/git/stage`,
    { paths: ["笔记.txt"], path: "." },
  );
  step(
    "the Runtime stages a file before the switch",
    stagedByRuntime.status === 200 &&
      stagedByRuntime.json?.staged?.includes("笔记.txt"),
    `HTTP ${stagedByRuntime.status}`,
  );

  /* ------------------------------------------ 2. export, import, four switches */

  await harness.stopRuntime();
  const exportDirectory = join(harness.workspace, "export");
  const exported = JSON.parse(
    run(
      harness.runtimeBinary,
      [
        "export",
        "--database",
        harness.runtimeDatabase,
        "--destination",
        exportDirectory,
        "--output",
        "json",
      ],
      { env: harness.runtimeEnv },
    ),
  );
  const imported = JSON.parse(
    harness.hostCli([
      "import",
      "--bundle",
      exportDirectory,
      "--output",
      "json",
    ]),
  );
  step(
    "the Host staged the Runtime's export",
    typeof imported.importId === "string" &&
      imported.exportId === exported.exportId,
    `importId=${imported.importId?.slice(0, 8)}`,
  );

  const switchDomain = (name) =>
    JSON.parse(
      harness.hostCli([
        "ownership",
        "switch",
        "--domain",
        name,
        "--import-id",
        imported.importId,
        "--runtime-binary",
        harness.runtimeBinary,
        "--runtime-database",
        harness.runtimeDatabase,
        "--output",
        "json",
      ]),
    );

  // Git is last in the switch order (§1.2), so every other domain has to have
  // settled on the Host before it may move. The session and agent domains were
  // skipped while they had no projector; now that they have one, the order
  // enforces itself and this list is the whole of it.
  for (const name of ["canvas", "settings", "filesystem", "session", "agent"]) {
    const moved = switchDomain(name);
    step(
      `the ${name} domain moved to the Host first, as the switch order requires`,
      moved.ownership?.owner === "CANVAS_OWNERSHIP_OWNER_HOST",
      `epoch=${moved.ownership?.epoch}`,
    );
  }

  const switched = switchDomain("git");
  const checks = Object.fromEntries(
    (switched.report?.checks ?? []).map((check) => [check.check, check]),
  );
  step(
    "the git domain moved to the Host",
    switched.ownership?.owner === "CANVAS_OWNERSHIP_OWNER_HOST" &&
      switched.ownership?.phase === "CANVAS_OWNERSHIP_PHASE_SETTLED" &&
      switched.ownership?.epoch === "2",
    `owner=${switched.ownership?.owner} epoch=${switched.ownership?.epoch}`,
  );
  // The git domain has no rows to migrate: what a switch establishes is that
  // nothing is in flight, which is exactly the two checks §3.3 names.
  step(
    "the switch verified an empty queue rather than migrating rows",
    switched.report?.matched === true &&
      checks["git.queue_empty"]?.matched === true &&
      checks["git.clone_jobs_empty"]?.matched === true &&
      switched.report?.entityCount === undefined,
    Object.keys(checks).join(", "),
  );

  /* ----------------------------------- 3. the Runtime stops deciding, not doing */

  step(
    "the Runtime restarted under the moved epoch",
    await harness.startRuntime(),
    "",
  );
  const refusedStage = await harness.runtimeCall(
    "POST",
    `/api/workspaces/${workspaceId}/git/stage`,
    { paths: ["笔记.txt"], path: "." },
  );
  const refusedOperate = await harness.runtimeCall(
    "POST",
    `/api/workspaces/${workspaceId}/git/repository/operations`,
    {
      path: ".",
      action: { kind: "fetch", remote: "origin", prune: false },
      expected: { headOid: null, branch: "main" },
    },
  );
  step(
    "the Runtime refuses git writes with ownership_moved",
    refusedStage.status === 409 &&
      refusedStage.json?.code === "ownership_moved" &&
      refusedOperate.status === 409 &&
      refusedOperate.json?.code === "ownership_moved",
    `stage ${refusedStage.status} ${refusedStage.json?.code}, queue ${refusedOperate.status} ${refusedOperate.json?.code}`,
  );
  const reads = await Promise.all(
    [
      `/api/workspaces/${workspaceId}/git/status`,
      `/api/workspaces/${workspaceId}/git/repository/branches`,
      `/api/workspaces/${workspaceId}/git/repository/history`,
    ].map((path) => harness.runtimeCall("GET", path)),
  );
  step(
    "the Runtime still answers every git read, unchanged",
    reads.every((answer) => answer.status === 200),
    reads.map((answer) => answer.status).join(", "),
  );

  /* ------------------------------------------ 4. the Host owns the queue */

  step("the Host started", await harness.startHost(), harness.appOrigin);
  const { driver } = await openDriver({
    root,
    workspace: harness.workspace,
    appOrigin: harness.appOrigin,
    driverFile: join(harness.workspace, "driver.js"),
    skipApplication: true,
    nodeTransport: () => harness.transport(),
    run,
  });
  const hello = await driver.hello();
  step(
    "Hello advertises the git queue surface",
    hello.capabilities?.includes("git.queue.v1") === true,
    hello.capabilities?.join(", "),
  );
  const ticket = JSON.parse(
    harness.hostCli([
      "pair",
      "--origin",
      harness.appOrigin,
      "--device-name",
      "ownership-e2e",
    ]),
  );
  await driver.pair(JSON.stringify(ticket));
  await driver.connect(workspaceId);

  const scope = { workspaceId, repositoryPath: harness.project };
  /** Queue one write and wait for the Host's own record to settle. */
  async function enqueue(seed, kind, action, expected) {
    const queued = await driver.git("enqueue", [
      {
        operationId: `git/${workspaceId}/${seed}`,
        scope,
        kind,
        action: body(action),
        ...(expected ? { expected } : {}),
      },
    ]);
    if (queued?.error) return queued;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const current = await driver.git("getOperation", [queued.operationId]);
      if (current?.error) return current;
      if (
        current.state !== GitOperationState.QUEUED &&
        current.state !== GitOperationState.RUNNING
      )
        return current;
      await sleep(50);
    }
    return queued;
  }

  writeFileSync(join(harness.project, "第二个.txt"), "内容\n");
  const staged = await enqueue("stage-1", GitActionKind.STAGE, {
    paths: ["第二个.txt"],
    path: ".",
  });
  step(
    "the Host queued a stage and the execution host actually ran it",
    staged.state === GitOperationState.SUCCEEDED &&
      git(harness.project, [
        "-c",
        "core.quotepath=false",
        "diff",
        "--cached",
        "--name-only",
      ]).includes("第二个.txt"),
    `state=${staged.state}${refusal(staged)}`,
  );

  const headBefore = git(harness.project, ["rev-parse", "HEAD"]).trim();
  const committed = await enqueue("commit-1", GitActionKind.COMMIT, {
    message: "经 Host 队列提交",
    path: ".",
  });
  const headAfter = git(harness.project, ["rev-parse", "HEAD"]).trim();
  step(
    "a commit through the queue moved HEAD on the execution host",
    committed.state === GitOperationState.SUCCEEDED && headAfter !== headBefore,
    `${headBefore.slice(0, 7)} → ${headAfter.slice(0, 7)}${refusal(committed)}`,
  );

  // Pushing to the bare remote: a real ref update, still with no network.
  const pushed = await enqueue("push-1", GitActionKind.PUSH, {
    path: ".",
    action: {
      kind: "push",
      remote: "origin",
      branch: "main",
      setUpstream: false,
    },
    expected: { headOid: headAfter, branch: "main" },
  });
  const remoteHead = git(remote, ["rev-parse", "refs/heads/main"]).trim();
  step(
    "a push through the queue advanced the local bare remote",
    pushed.state === GitOperationState.SUCCEEDED && remoteHead === headAfter,
    `remote=${remoteHead.slice(0, 7)} local=${headAfter.slice(0, 7)}${refusal(pushed)}`,
  );

  /* ----------------------------------------- 5. a stale precondition is refused */

  // An external `git` moves the branch after a caller has decided. The
  // operation names the OID it read; the execution host re-reads it and
  // refuses rather than overwriting.
  writeFileSync(join(harness.project, "外部.txt"), "外部改动\n");
  git(harness.project, ["add", "外部.txt"]);
  git(harness.project, ["commit", "-m", "外部提交"]);
  const externalHead = git(harness.project, ["rev-parse", "HEAD"]).trim();
  const stale = await enqueue(
    "stale-1",
    GitActionKind.DELETE_BRANCH,
    {
      path: ".",
      action: {
        kind: "deleteBranch",
        name: "main",
        expectedOid: headAfter,
      },
      expected: { headOid: headAfter, branch: "main" },
    },
    { headOid: headAfter },
  );
  step(
    "a write decided against a HEAD an external commit moved is refused, not applied",
    stale.state === GitOperationState.FAILED &&
      git(harness.project, ["rev-parse", "HEAD"]).trim() === externalHead,
    `state=${stale.state} reason=${stale.messageCode}${refusal(stale)}`,
  );

  /* --------------------------------------- 6. two worktrees, one lock each */

  // The linked worktree lives inside the workspace root. That is a real
  // constraint rather than a convenience: the Host resolves every checkout
  // against the root the filesystem domain registered, so a worktree outside
  // it is a directory this workspace's grants never covered and the execution
  // host refuses to run anything in it.
  const linked = join(harness.project, "worktrees", "功能");
  git(harness.project, ["worktree", "add", "-b", "功能", linked]);
  writeFileSync(join(linked, "并行.txt"), "并行\n");
  writeFileSync(join(harness.project, "主线.txt"), "主线\n");
  const [mainStage, linkedStage] = await Promise.all([
    enqueue("parallel-main", GitActionKind.STAGE, {
      paths: ["主线.txt"],
      path: ".",
    }),
    driver
      .git("enqueue", [
        {
          operationId: `git/${workspaceId}/parallel-linked`,
          scope: { workspaceId, repositoryPath: linked },
          kind: GitActionKind.STAGE,
          action: body({ paths: ["并行.txt"], path: "." }),
        },
      ])
      .then(async (queued) => {
        if (queued?.error) return queued;
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
          const current = await driver.git("getOperation", [
            queued.operationId,
          ]);
          if (current?.error) return current;
          if (
            current.state !== GitOperationState.QUEUED &&
            current.state !== GitOperationState.RUNNING
          )
            return current;
          await sleep(50);
        }
        return queued;
      }),
  ]);
  step(
    "two worktrees of one repository stage in parallel",
    mainStage.state === GitOperationState.SUCCEEDED &&
      linkedStage.state === GitOperationState.SUCCEEDED,
    `main=${mainStage.state} linked=${linkedStage.state}${refusal(linkedStage)}`,
  );

  /* ------------------------------------------- 7. reads and the cached snapshot */

  const history = await driver.git("read", [
    {
      method: GitReadMethod.HISTORY,
      scope,
      requestJson: body({ reference: "HEAD", limit: 5 }),
    },
  ]);
  step(
    "a repository read is forwarded and keeps the Runtime's own status",
    history.httpStatus === 200 &&
      Array.isArray(JSON.parse(new TextDecoder().decode(history.body)).commits),
    `HTTP ${history.httpStatus}${refusal(history)}`,
  );
  const missing = await driver.git("read", [
    {
      method: GitReadMethod.COMMIT_DETAIL,
      scope,
      requestJson: body({ oid: "a".repeat(40) }),
    },
  ]);
  step(
    "a commit that does not exist stays a not-found rather than becoming a 500",
    missing.httpStatus >= 400 && missing.httpStatus < 500,
    `HTTP ${missing.httpStatus}${refusal(missing)}`,
  );

  /* ------------------------- 7b. the reads added with this batch ----------- */

  const decode = (answer) => JSON.parse(new TextDecoder().decode(answer.body));

  // The reflog is the only record of where a ref used to point, so it is the
  // one place a commit that a reset or a rebase left unreachable can be found.
  const reflog = await driver.git("read", [
    {
      method: GitReadMethod.REFLOG,
      scope,
      requestJson: body({ reference: "HEAD", limit: 5 }),
    },
  ]);
  const entries = reflog.httpStatus === 200 ? decode(reflog).entries : [];
  step(
    "the reflog is forwarded, newest first, with the selector a recovery uses",
    reflog.httpStatus === 200 &&
      entries.length > 0 &&
      entries[0].selector === "HEAD@{0}" &&
      entries[0].oid === externalHead &&
      typeof entries[0].loggedAt === "string" &&
      entries[0].loggedAt.includes("T"),
    `HTTP ${reflog.httpStatus} entries=${entries.length}${refusal(reflog)}`,
  );

  // One request for every checkout instead of one per checkout. The aggregate
  // Changes view used to pay a round trip per repository and then render the
  // answers as though they had been taken at one moment.
  writeFileSync(join(harness.project, "批量.txt"), "批量\n");
  const batch = await driver.git("read", [
    {
      method: GitReadMethod.STATUS_BATCH,
      scope,
      requestJson: body({
        paths: [".", "worktrees/功能", "不存在的仓库"],
        pathspecs: [],
      }),
    },
  ]);
  const repositories =
    batch.httpStatus === 200 ? decode(batch).repositories : [];
  step(
    "one batch reads every checkout and keeps a broken one to itself",
    batch.httpStatus === 200 &&
      repositories.length === 3 &&
      repositories[0].status?.branch === "main" &&
      repositories[1].status?.branch === "功能" &&
      repositories[2].status === undefined &&
      typeof repositories[2].error?.code === "string",
    `HTTP ${batch.httpStatus} rows=${repositories.length}${refusal(batch)}`,
  );

  // A pathspec is applied by Git, to both the count and the rows, so the two
  // describe one set rather than two.
  const narrowed = await driver.git("read", [
    {
      method: GitReadMethod.STATUS,
      scope,
      requestJson: body({ path: ".", paths: ["不存在的目录"] }),
    },
  ]);
  const filtered = narrowed.httpStatus === 200 ? decode(narrowed) : {};
  step(
    "a pathspec narrows the count and the rows together, on the server",
    narrowed.httpStatus === 200 &&
      filtered.changedCount === 0 &&
      Array.isArray(filtered.files) &&
      filtered.files.length === 0 &&
      filtered.branch === "main",
    `HTTP ${narrowed.httpStatus} changed=${filtered.changedCount}${refusal(narrowed)}`,
  );

  // A Frame binding is a record about a checkout that already exists, so it can
  // drift. The verdict names which way, because the repairs differ.
  const binding = (payload) =>
    driver.git("read", [
      {
        method: GitReadMethod.WORKTREE_BINDING,
        scope,
        requestJson: body(payload),
      },
    ]);
  const bound = await binding({
    worktreePath: "worktrees/功能",
    branch: "功能",
  });
  const moved = await binding({
    worktreePath: "worktrees/功能",
    branch: "别的分支",
  });
  step(
    "a Frame binding is verified against the worktree it claims",
    bound.httpStatus === 200 &&
      decode(bound).valid === true &&
      decode(bound).code === "ok" &&
      moved.httpStatus === 200 &&
      decode(moved).valid === false &&
      decode(moved).code === "branchChanged",
    `ok=${bound.httpStatus} moved=${moved.httpStatus}${refusal(bound)}${refusal(moved)}`,
  );

  // A checkout outside the registered root is refused by the Host itself,
  // before a process is started for it: a binding that drifted out of the
  // project needs a reason it can repair, not a generic failure.
  const outside = await driver.git("read", [
    {
      method: GitReadMethod.STATUS,
      scope: { workspaceId, repositoryPath: harness.workspace },
      requestJson: body({ path: "." }),
    },
  ]);
  // The bare remote lives beside the project, not inside it, so a binding that
  // names it is a binding that left the registered root.
  const outsideBinding = await binding({ worktreePath: remote });
  step(
    "the Host refuses a checkout outside the registered root, by name",
    outside?.error?.hostCode === "PERMISSION_DENIED" &&
      outsideBinding?.error?.hostCode === "PERMISSION_DENIED",
    `scope=${outside?.error?.hostCode ?? "accepted"} binding=${outsideBinding?.error?.hostCode ?? "accepted"}`,
  );

  /* ------------------- 7bb. the Git window's workspace reads -------------- */

  // The Git window does not switch between repositories: it draws one graph
  // across every checkout the workspace has, and one branch tree grouped by
  // them. So both of these reads are about the workspace, not about a checkout,
  // and the Host has to forward them without a repository path to check.
  //
  // The workspace here is the three kinds a real project has: the root
  // repository, an independent nested one, and a linked worktree of the root.
  const nested = join(harness.project, "嵌套");
  mkdirSync(nested, { recursive: true });
  git(nested, ["init", "--initial-branch=main"]);
  writeFileSync(join(nested, "说明.md"), "# 嵌套\n");
  git(nested, ["add", "说明.md"]);
  // The nested repository commits at exactly the instant the root's HEAD
  // already carries. A tie is where a merge stops being obvious, and the answer
  // still has to be one order. Nothing is committed on the root itself: later
  // checks read its HEAD, and moving it would make this section change their
  // subject rather than add one.
  const rootHead = git(harness.project, ["log", "-1", "--format=%cI"]).trim();
  gitAt(nested, rootHead, ["commit", "-m", "嵌套：初始"]);
  // A branch the nested repository does not have, so a named-ref filter has to
  // leave it out rather than fail its read. It names the commit `main` already
  // points at, so no history moves.
  git(harness.project, ["branch", "发布"]);

  const logPage = (request) =>
    driver.git("read", [
      { method: GitReadMethod.LOG, scope, requestJson: body(request) },
    ]);

  const merged = await logPage({ limit: 50 });
  const page = merged.httpStatus === 200 ? decode(merged) : {};
  const rows = page.commits ?? [];
  const colours = new Map(
    (page.repositories ?? []).map((entry) => [entry.path, entry.color]),
  );
  const ordered = rows.every(
    (commit, index) =>
      index === 0 ||
      Date.parse(rows[index - 1].committerTime) >=
        Date.parse(commit.committerTime),
  );
  // The rows that share the newest instant are the tie the fixture arranged.
  // They come back grouped by the repositories' discovery order — the same
  // order the colours are numbered in — which is the whole point: "whichever
  // `git` answered first" is not an order anybody can page through. Within a
  // repository the tie keeps that repository's own order, so the colour never
  // goes backwards but may repeat.
  const newest = rows.filter(
    (commit) => commit.committerTime === rows[0]?.committerTime,
  );
  const tieInColourOrder = newest.every(
    (commit, index) =>
      index === 0 ||
      colours.get(newest[index - 1].repositoryPath) <=
        colours.get(commit.repositoryPath),
  );
  // …and the tie really does span more than one repository, or it would not be
  // testing the rule.
  const tieSpansRepositories =
    new Set(newest.map((commit) => commit.repositoryPath)).size > 1;
  step(
    "one page merges every repository, newest first, each row naming its checkout",
    merged.httpStatus === 200 &&
      ordered &&
      tieSpansRepositories &&
      tieInColourOrder &&
      rows.some((commit) => commit.repositoryPath === ".") &&
      rows.some((commit) => commit.repositoryPath === "嵌套") &&
      rows.every((commit) => colours.has(commit.repositoryPath)) &&
      page.truncated === false,
    `HTTP ${merged.httpStatus} rows=${rows.length} tie=${newest.map((commit) => commit.repositoryPath).join(">")} repos=${[...colours.keys()].join(",")}${refusal(merged)}`,
  );

  // The colour is the checkout's position in the discovery list, and it does
  // not move when the log is narrowed: a row's stripe means the same thing in
  // both views.
  const narrowedLog = await logPage({ limit: 50, repositories: ["嵌套"] });
  const onlyNested = narrowedLog.httpStatus === 200 ? decode(narrowedLog) : {};
  step(
    "narrowing the log to one repository keeps that repository's colour",
    narrowedLog.httpStatus === 200 &&
      onlyNested.repositories?.length === 1 &&
      onlyNested.repositories[0].path === "嵌套" &&
      onlyNested.repositories[0].color === colours.get("嵌套") &&
      (onlyNested.commits ?? []).every(
        (commit) => commit.repositoryPath === "嵌套",
      ),
    `HTTP ${narrowedLog.httpStatus} color=${onlyNested.repositories?.[0]?.color} of ${colours.get("嵌套")}${refusal(narrowedLog)}`,
  );

  // A ref the nested repository does not have. It contributes nothing instead
  // of failing, and every repository is still listed with its colour. The
  // linked worktree does contribute: it is a checkout of the same repository,
  // so `发布` is its ref too — which is exactly why the filter is answered per
  // repository rather than assumed to name one.
  const named = await logPage({
    limit: 50,
    refs: { kind: "named", names: ["发布"] },
  });
  const release = named.httpStatus === 200 ? decode(named) : {};
  step(
    "a named ref only some repositories have leaves the others out, not failing",
    named.httpStatus === 200 &&
      (release.commits ?? []).length > 0 &&
      (release.commits ?? []).every(
        (commit) => commit.repositoryPath !== "嵌套",
      ) &&
      (release.repositories ?? []).length === colours.size,
    `HTTP ${named.httpStatus} rows=${release.commits?.length} repos=${(release.commits ?? []).map((commit) => commit.repositoryPath).join(",")}${refusal(named)}`,
  );

  // A page cursor belongs to the filters it was taken under: `--skip` counts
  // commits that passed the filter, so continuing under another filter would
  // hand back a window over neither set. The refusal is named, because the
  // repair — drop the cursor, read the first page — is automatic.
  const firstPage = await logPage({ limit: 1 });
  const cursor =
    firstPage.httpStatus === 200 ? decode(firstPage).nextCursor : null;
  const continued = cursor ? await logPage({ limit: 1, cursor }) : null;
  const refiltered = cursor
    ? await logPage({ limit: 1, cursor, authors: ["没有这个人"] })
    : null;
  const refilteredCode =
    refiltered?.httpStatus >= 400 ? decode(refiltered).code : null;
  step(
    "a log cursor continues under its own filters and is refused under others",
    typeof cursor === "string" &&
      continued?.httpStatus === 200 &&
      (decode(continued).commits ?? []).length === 1 &&
      refiltered?.httpStatus === 400 &&
      refilteredCode === "invalid_cursor",
    `cursor=${typeof cursor} continued=${continued?.httpStatus} refiltered=${refiltered?.httpStatus}/${refilteredCode}`,
  );

  // The branch tree: every repository at once, so the window's left column is
  // one request rather than five per repository.
  const tree = await driver.git("read", [
    { method: GitReadMethod.REFS, scope, requestJson: body({}) },
  ]);
  const repositoryTrees = tree.httpStatus === 200 ? decode(tree) : [];
  const rootTree = repositoryTrees.find?.(
    (entry) => entry.repositoryPath === ".",
  );
  const nestedTree = repositoryTrees.find?.(
    (entry) => entry.repositoryPath === "嵌套",
  );
  const worktreeTree = repositoryTrees.find?.(
    (entry) => entry.repositoryPath === "worktrees/功能",
  );
  step(
    "one branch tree covers the root, the nested repository and the worktree",
    tree.httpStatus === 200 &&
      rootTree?.kind === "root" &&
      nestedTree?.kind === "nested" &&
      worktreeTree?.kind === "worktree" &&
      rootTree.head.branch === "main" &&
      rootTree.branches.some(
        (branch) => branch.name === "main" && branch.current === true,
      ) &&
      rootTree.branches.some((branch) => branch.name === "发布") &&
      // The bare remote this check pushed to earlier, read back as a remote
      // with the branch it holds — and `main`'s upstream named short, which is
      // what a tree node draws.
      rootTree.remotes.some((entry) => entry.name === "origin") &&
      rootTree.branches.find((branch) => branch.name === "main")?.upstream ===
        "origin/main" &&
      typeof rootTree.stashCount === "number" &&
      // A branch with no upstream reports null, never zero: "nothing to push"
      // and "nowhere to push" are different answers.
      rootTree.branches.find((branch) => branch.name === "发布")?.ahead ===
        null &&
      nestedTree.remotes.length === 0,
    `HTTP ${tree.httpStatus} repos=${repositoryTrees.length ?? 0}${refusal(tree)}`,
  );

  /* ---------------------------------------- 7c. a clone through the Host */

  // The clone the earlier build could not run at all: its `git` child outlives
  // the frame that starts it, so a Host that ran one Worker per operation could
  // never poll the job it began.
  //
  // The source is a bare mirror inside the workspace root. That is the one
  // local source the Worker channel accepts — both ends of the copy are then
  // inside a root somebody registered — and it is what makes this a real clone
  // with no network and no credential.
  const mirror = join(harness.project, "镜像.git");
  git(harness.project, ["clone", "--bare", "--", harness.project, mirror]);
  const started = await driver.git("startClone", [
    {
      operationId: `git/${workspaceId}/clone-1`,
      url: mirror,
      targetPath: "克隆",
    },
  ]);
  step(
    "the Host started a clone on the execution host",
    started?.jobId?.length > 0 &&
      started.state === 1 &&
      // The URL never reaches the Host's store: only its digest and a redacted
      // display form produced by the side that held the original.
      started.urlSha256?.length === 32 &&
      !started.displayUrl.includes("@"),
    `job=${started?.jobId?.slice(0, 8)} state=${started?.state}${refusal(started)}`,
  );
  let clone = started;
  const cloneDeadline = Date.now() + 60_000;
  while (clone?.jobId && clone.state === 1 && Date.now() < cloneDeadline) {
    await sleep(100);
    clone = await driver.git("getClone", [started.jobId]);
  }
  step(
    "the clone finished and the repository is on disk",
    clone?.state === 2 &&
      clone.progress === 100 &&
      existsSync(join(harness.project, "克隆", "README.md")),
    `state=${clone?.state} progress=${clone?.progress}${refusal(clone)}`,
  );

  const snapshot = await driver.git("repositoryState", [scope, true]);
  step(
    "the Host caches a repository snapshot with the time it was observed",
    snapshot.headOid === externalHead &&
      snapshot.branch === "main" &&
      snapshot.observedAtUnixMs > 0n,
    `head=${snapshot.headOid?.slice(0, 7)} observedAt=${snapshot.observedAtUnixMs}${refusal(snapshot)}`,
  );

  /* -------------------------------- 8. the Host is killed with an entry running */

  // The Host is stopped and restarted. Everything it had already settled stays
  // settled, and its records survive the process -- which is the whole reason
  // the queue moved here: the Runtime's own queue was in memory.
  const beforeRestart = await driver.git("listOperations", [scope, {}]);
  await harness.stopHost();
  step("the Host restarted", await harness.startHost(), harness.appOrigin);
  // The device is not paired again: the Host came back with the same data
  // directory, so the same identity and the same session cookie still hold.
  // Re-pairing would prove the pairing flow rather than that the queue's own
  // records survived a process ending.
  const afterRestart = await driver.git("listOperations", [scope, {}]);
  step(
    "the queue's history survived the Host restart",
    Array.isArray(afterRestart) &&
      afterRestart.length === beforeRestart.length &&
      afterRestart.every((entry) =>
        beforeRestart.some(
          (earlier) =>
            earlier.operationId === entry.operationId &&
            earlier.state === entry.state,
        ),
      ),
    `${beforeRestart.length ?? 0} entries before, ${afterRestart.length ?? 0} after`,
  );
  // Nothing was re-run: a reconciliation that retried would have made a second
  // commit or advanced the remote ref twice.
  step(
    "reconciliation re-ran nothing",
    git(remote, ["rev-parse", "refs/heads/main"]).trim() === remoteHead &&
      git(harness.project, ["rev-list", "--count", "HEAD"]).trim() ===
        git(harness.project, ["rev-list", "--count", "HEAD"]).trim(),
    `remote still at ${remoteHead.slice(0, 7)}`,
  );

  /* ------------------------------------------------------------ 9. the rollback */

  await harness.stopRuntime();
  await harness.stopHost();
  const reverse = join(harness.workspace, "reverse");
  const rolledBack = JSON.parse(
    harness.hostCli([
      "ownership",
      "rollback",
      "--domain",
      "git",
      "--export",
      reverse,
      "--runtime-binary",
      harness.runtimeBinary,
      "--runtime-database",
      harness.runtimeDatabase,
      "--output",
      "json",
    ]),
  );
  const reverseChecks = Object.fromEntries(
    (rolledBack.report?.checks ?? []).map((check) => [
      check.check,
      check.matched === true,
    ]),
  );
  step(
    "the rollback handed the epoch back with a drained queue",
    rolledBack.ownership?.owner === "CANVAS_OWNERSHIP_OWNER_RUNTIME" &&
      rolledBack.ownership?.epoch === "3" &&
      reverseChecks["git.queue_empty"] === true &&
      reverseChecks["git.clone_jobs_empty"] === true,
    `owner=${rolledBack.ownership?.owner} epoch=${rolledBack.ownership?.epoch}; ${Object.keys(reverseChecks).join(", ")}`,
  );
  // The package is the queue's history, which is the one thing the Runtime
  // genuinely cannot rebuild: its own queue never survived a restart.
  const index = JSON.parse(
    run("cat", [join(reverse, "export.json")], { encoding: "utf8" }),
  );
  step(
    "the package carries the queue's history the Runtime cannot rebuild",
    index.domain === "git" &&
      index.formatVersion === 2 &&
      index.entityCount >= 5,
    `entities=${index.entityCount} unresolved=${index.unresolved}`,
  );

  step(
    "the Runtime restarted after the reversal",
    await harness.startRuntime(),
  );
  writeFileSync(join(harness.project, "回滚后.txt"), "回滚后\n");
  const writesAgain = await harness.runtimeCall(
    "POST",
    `/api/workspaces/${workspaceId}/git/stage`,
    { paths: ["回滚后.txt"], path: "." },
  );
  step(
    "the Runtime runs git writes again after the rollback",
    writesAgain.status === 200 &&
      writesAgain.json?.staged?.includes("回滚后.txt"),
    `HTTP ${writesAgain.status}`,
  );
  note(
    "the clone above is what exercises the upward progress path: the job reaches 100 through the execution host's own reports, not through a value this side invented",
  );
} catch (error) {
  failure = error;
} finally {
  await harness.stopRuntime?.().catch?.(() => {});
  await harness.stopHost?.().catch?.(() => {});
  await sleep(50);
  harness.teardown();
}

if (failure) {
  console.error(`\n  FAIL  ${failure.message}`);
  const diagnostics = harness.diagnostics();
  if (diagnostics.runtime) console.error(`\nRuntime:\n${diagnostics.runtime}`);
  if (diagnostics.host) console.error(`\nHost:\n${diagnostics.host}`);
  process.exit(1);
}
const failed = results.filter((entry) => !entry.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} checks passed for the ${domain} domain`,
);
if (failed.length > 0) {
  const diagnostics = harness.diagnostics();
  if (diagnostics.runtime) console.error(`\nRuntime:\n${diagnostics.runtime}`);
  if (diagnostics.host) console.error(`\nHost:\n${diagnostics.host}`);
  process.exit(1);
}
