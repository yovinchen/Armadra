// 场景 6：`canvas team` 给成员各自一条 worktree（typescript-core-status §59）。
//
// 不用真 CLI：它有自己的一套 core（临时数据目录、临时 git 仓库当工作区），
// Agent 用一个假 CLI（一段 sh，把自己起在哪个目录写下来再停在 shell 里）。
// 所以 `--only 6` 单跑时不要求 Claude / Codex 的登录，也不起 Vite 与 Chrome；
// 全量跑时它在其余场景之后另起这一套。
//
// 断言：
//   * `team --member "…|worktree=名字"`：检出真的建出来、在同名分支上；两个成员
//     写同一个名字共用一个 Frame，另一个成员写路径得到第二个 Frame；没写的成员
//     不在任何 Frame 里。
//   * 画布上 Frame 的绑定、成员的 parentId 与 `cwd` 都对，终端从节点的 `cwd`
//     起——假 CLI 记下的工作目录就是那条检出。
//   * `open-agent --worktree` 按分支名找到已有的检出，放进同一个 Frame。
//   * `--dry-run` 什么都不建；Git 拒绝（分支已存在）时画布一个节点都不多。
import { execFile, execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  cleanups,
  note,
  output,
  root,
  scenario,
  sleep,
  waitFor,
} from "./lib.mjs";

function git(cwd, ...args) {
  return execFileSync(
    "git",
    ["-c", "user.name=probe", "-c", "user.email=probe@example.test", ...args],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
}

/** 自己的一套 core：假 CLI、临时 git 仓库、一个带节点令牌的调用者终端。 */
async function setupFake() {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "armadra-wt-")));
  cleanups.push(() =>
    rmSync(scratch, { recursive: true, force: true, maxRetries: 20 }),
  );
  const project = join(scratch, "project");
  mkdirSync(project);
  writeFileSync(join(project, "README.md"), "# probe\n");
  writeFileSync(join(project, ".gitignore"), ".worktrees/\n");
  git(project, "init", "-q", "-b", "main");
  git(project, "add", "-f", "README.md", ".gitignore");
  git(project, "commit", "-q", "-m", "init");

  // 假 CLI：记下自己起在哪个目录（按节点标题分文件），然后停在一个 shell 里。
  const marks = join(scratch, "marks");
  mkdirSync(marks);
  const fake = join(scratch, "fake-agent");
  writeFileSync(
    fake,
    `#!/bin/sh\npwd -P > '${marks}'/"$(basename "$(pwd -P)")".cwd\nexec /bin/sh\n`,
  );
  chmodSync(fake, 0o755);

  // 目录名短一点：tmux 的套接字路径有长度上限。
  const data = join(scratch, "rt");
  mkdirSync(data);
  const binary = join(root, "apps/desktop/out/core/main.js");
  const hook = join(root, "apps/desktop/out/cli/armadra-hook.js");
  for (const file of [binary, hook])
    if (!existsSync(file)) throw new Error(`未构建：${file}`);
  const environment = { ...process.env, ARMADRA_DATA_DIR: data };
  delete environment.TMUX;
  delete environment.TMUX_PANE;
  const log = createWriteStream(join(output, "core-worktree.log"));
  const core = spawn(
    process.execPath,
    [binary, "--listen", "tcp:127.0.0.1:0", "--data-dir", data],
    { cwd: root, stdio: ["ignore", "pipe", "pipe"], env: environment },
  );
  cleanups.push(() => core.kill("SIGKILL"));
  cleanups.push(() => {
    try {
      execFileSync("tmux", ["-S", join(data, "tmux.sock"), "kill-server"], {
        stdio: "ignore",
      });
    } catch {}
  });
  core.stdout.pipe(log);
  core.stderr.pipe(log);
  const origin = await waitFor(
    "worktree 场景的 core 就绪",
    () => {
      try {
        return JSON.parse(readFileSync(join(data, "endpoints.json"), "utf8"))
          .runtime.http;
      } catch {
        return undefined;
      }
    },
    { timeout: 30_000, interval: 100 },
  );
  const api = async (path, init = {}) => {
    const answer = await fetch(new URL(path, origin), {
      headers: { "Content-Type": "application/json" },
      ...init,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    const text = await answer.text();
    if (!answer.ok)
      throw new Error(
        `${init.method ?? "GET"} ${path} → ${answer.status} ${text}`,
      );
    return text === "" ? null : JSON.parse(text);
  };

  const workspace = await api("/api/workspaces", {
    method: "POST",
    body: {
      name: "agent-e2e-worktree",
      rootPath: project,
      permissions: { read: true, write: true, execute: true },
    },
  });
  const boards = await api(`/api/workspaces/${workspace.id}/boards`);
  const board =
    boards[0] ??
    (await api(`/api/workspaces/${workspace.id}/boards`, {
      method: "POST",
      body: { name: "e2e" },
    }));
  const documentPath = `/api/workspaces/${workspace.id}/boards/${board.id}/document`;
  const initial = await api(documentPath);
  const stamp = new Date().toISOString();
  const caller = {
    id: randomUUID(),
    boardId: board.id,
    type: "terminal",
    title: "lead",
    color: "#0a84ff",
    position: { x: 0, y: 0 },
    size: { width: 520, height: 330 },
    labels: [],
    note: "",
    data: { kind: "terminal" },
    createdAt: stamp,
    updatedAt: stamp,
  };
  await api(documentPath, {
    method: "PUT",
    body: {
      expectedUpdatedAt: initial.board.updatedAt,
      nodes: [caller],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 0.5 },
      whiteboard: "",
    },
  });
  // 节点令牌只签给有会话的终端节点。
  const session = await api("/api/terminals", {
    method: "POST",
    body: {
      workspaceId: workspace.id,
      cwd: project,
      nodeId: caller.id,
      shell: "/bin/sh",
    },
  });
  await api(`/api/terminals/${session.id}/node-token/refresh`, {
    method: "POST",
  });

  const canvas = (verb, ...args) =>
    new Promise((done) => {
      execFile(
        process.execPath,
        [hook, "canvas", verb, ...args],
        {
          env: {
            PATH: process.env.PATH,
            HOME: scratch,
            ARMADRA_NODE_ID: caller.id,
            ARMADRA_ENDPOINT_FILE: join(data, "hook-endpoint.env"),
            ARMADRA_DATA_DIR: data,
          },
          timeout: 90_000,
        },
        (error, stdout, stderr) => {
          let json;
          try {
            json = JSON.parse(stdout);
          } catch {}
          const answer = {
            code: error ? (error.code ?? 1) : 0,
            stdout: stdout.trim(),
            stderr: stderr.trim(),
            json,
          };
          note(`canvas ${verb}`, {
            args,
            code: answer.code,
            out: (answer.stdout || answer.stderr).slice(0, 300),
          });
          done(answer);
        },
      );
    });
  const document = () => api(documentPath);
  return { api, canvas, document, project, workspace, fake, marks, caller };
}

export default async function run() {
  const s = scenario("6-team-worktree");
  try {
    const { api, canvas, document, project, workspace, fake, marks } =
      await setupFake();
    note("worktree 场景就位", project);

    // 演练：什么都不建。
    const dry = await canvas(
      "team",
      "--member",
      "codex|dry|x|worktree=dry-run",
      "--dry-run",
    );
    s.check(
      "--dry-run 不建检出、不改画布",
      dry.code === 0 &&
        !existsSync(join(project, ".worktrees", "dry-run")) &&
        (await document()).nodes.length === 1,
      dry.stdout || dry.stderr,
    );

    const team = await canvas(
      "team",
      "--member",
      "codex|前端|改 web/ 的登录页|worktree=feat-login",
      "--member",
      "claude|前端审阅||worktree=feat-login",
      "--member",
      "codex|后端|改 api/ 的登录接口|worktree=services/api-login",
      "--member",
      "claude|旁观|只读",
    );
    s.check(
      "team 带 worktree 成功",
      team.code === 0,
      team.stdout || team.stderr,
    );

    const login = join(project, ".worktrees", "feat-login");
    const api2 = join(project, "services", "api-login");
    s.check(
      "按名字建出 .worktrees/feat-login，分支同名",
      existsSync(join(login, "README.md")) &&
        git(login, "branch", "--show-current") === "feat-login",
    );
    s.check(
      "按路径建出 services/api-login，分支取目录名",
      existsSync(join(api2, "README.md")) &&
        git(api2, "branch", "--show-current") === "api-login",
    );

    const doc = await document();
    const byTitle = (title) => doc.nodes.find((node) => node.title === title);
    const frames = doc.nodes.filter((node) => node.type === "group");
    const frameOf = (path) =>
      frames.find((node) => node.data?.binding?.worktreePath === path);
    const loginFrame = frameOf(".worktrees/feat-login");
    const apiFrame = frameOf("services/api-login");
    s.check(
      "两条检出各一个绑定的 Frame",
      frames.length === 2 && loginFrame && apiFrame,
      frames.map((node) => node.data?.binding),
    );
    s.check(
      "写同一个名字的两个成员在同一个 Frame 里，cwd 是那条检出",
      byTitle("前端")?.parentId === loginFrame?.id &&
        byTitle("前端审阅")?.parentId === loginFrame?.id &&
        byTitle("前端")?.data?.cwd === login &&
        byTitle("前端审阅")?.data?.cwd === login,
      {
        parent: byTitle("前端")?.parentId,
        cwd: byTitle("前端")?.data?.cwd,
      },
    );
    s.check(
      "按路径的成员在第二个 Frame 里",
      byTitle("后端")?.parentId === apiFrame?.id &&
        byTitle("后端")?.data?.cwd === api2,
    );
    s.check(
      "没写 worktree 的成员不在任何 Frame 里",
      byTitle("旁观") !== undefined && byTitle("旁观").parentId === undefined,
    );

    // 终端从节点的 cwd 起（页面挂载节点时也是这样起）：假 CLI 记下的目录。
    for (const title of ["前端", "后端"]) {
      const node = byTitle(title);
      await api("/api/terminals", {
        method: "POST",
        body: {
          workspaceId: workspace.id,
          cwd: node.data.cwd,
          nodeId: node.id,
          shell: fake,
        },
      });
    }
    const loginMark = join(marks, "feat-login.cwd");
    const apiMark = join(marks, "api-login.cwd");
    await waitFor(
      "假 CLI 起来并记下目录",
      () => existsSync(loginMark) && existsSync(apiMark),
      { timeout: 20_000, interval: 100 },
    ).catch(() => undefined);
    s.check(
      "假 CLI 起在各自的 worktree 里",
      existsSync(loginMark) &&
        readFileSync(loginMark, "utf8").trim() === login &&
        existsSync(apiMark) &&
        readFileSync(apiMark, "utf8").trim() === api2,
      {
        login: existsSync(loginMark) ? readFileSync(loginMark, "utf8") : null,
        api: existsSync(apiMark) ? readFileSync(apiMark, "utf8") : null,
      },
    );

    // open-agent --worktree：按分支名找到已有的检出，进同一个 Frame。
    const again = await canvas(
      "open-agent",
      "--agent",
      "claude",
      "--title",
      "补测试",
      "--worktree",
      "feat-login",
    );
    const after = await document();
    const added = after.nodes.find((node) => node.title === "补测试");
    s.check(
      "open-agent --worktree 用已有的检出、进同一个 Frame",
      again.code === 0 &&
        added?.parentId === loginFrame?.id &&
        after.nodes.filter((node) => node.type === "group").length === 2 &&
        again.stdout.includes("feat-login"),
      again.stdout || again.stderr,
    );

    // Git 拒绝：main 分支已存在，画布一个节点都不多。
    const before = after.nodes.length;
    const refused = await canvas(
      "team",
      "--member",
      "codex|撞名|x|worktree=main",
    );
    await sleep(200);
    s.check(
      "Git 拒绝时整队不建",
      refused.code !== 0 && (await document()).nodes.length === before,
      refused.stderr || refused.stdout,
    );
    s.check(
      "git worktree list 里正好多出这两条",
      git(project, "worktree", "list", "--porcelain")
        .split("\n")
        .filter((line) => line.startsWith("worktree ")).length === 3,
    );
  } catch (error) {
    s.fail(error);
  }
  s.finish();
}
