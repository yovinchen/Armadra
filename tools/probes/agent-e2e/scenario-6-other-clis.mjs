// 场景 6：OpenCode / Pi / OMP / Copilot 的画布内注入（设计 canvas-only-integration
// §7；实测矩阵见状态文档 §51）。场景 5 对 Claude 与 Codex 做的事，对另外四个
// CLI 各做一遍：
//
//   * 画布外：临时 HOME 里直接起这个 CLI，环境里带着节点身份（ARMADRA_NODE_ID
//     与端点文件，万一有全局插件也打得到 core），但没有注入参数与注入环境。
//     模型答不出我们的技能和画布规则，这个节点的 agent_status 一条都没有。
//   * 画布内：同一个 CLI、同一份临时 HOME，由 core 在这个节点的终端里起
//     （`POST /api/terminals` 带 nodeId 与 agent：环境由 core 的 ownedEnvironment
//     给，与用户点出来的节点同一份），启动参数用 `GET /api/agents` 的
//     `launchArgs`。模型答得出技能名与 `armadra-hook canvas`，扩展或 Hook 的事件
//     经 hook.sock 回到 core，这个节点的状态行由上报写出。
//
// 用非交互模式（`run` / `-p`）：四个 TUI 各有各的首启提示，这里要验的是注入，
// 不是 TUI。提示词一行，一轮就退出。
//
// 认证：每个 CLI 用临时 HOME（XDG、COPILOT_HOME、PI_CODING_AGENT_DIR 都在里面），
// 只**复制**凭据，绝不写操作员的配置目录；认不上就记「未能认证」并跳过，不回
// 退到真实目录。本机实测（2026-09-26）：
//   * Pi：复制 ~/.pi/agent/auth.json 里的 moonshotai-cn 那一条（API key，不会
//     刷新；OAuth 那条不复制，刷新会轮换真实那份），模型 kimi-k2.6。操作员的缺省
//     提供商的 key 放在钥匙串（`!security …`），临时 HOME 下取不到。
//   * OMP：同一把 moonshotai-cn 的 key 经环境变量交给临时 models.yml 里的一个
//     提供商（OMP 自带的 moonshot 指向国际站，这把 key 在那边无效）。
//   * OpenCode：npm 包装脚本没跑 postinstall、起不来，用包里的原生二进制。操作
//     员配置里的几家提供商在本机都认证失败（令牌无效 / 不可用），所以用 OpenCode
//     自带的免费模型，不需要凭据。
//   * Copilot：登录在钥匙串里，临时 HOME 下读不到；`gh auth token` 取出的令牌
//     经 COPILOT_GITHUB_TOKEN 交给这一个进程（不写任何文件，不打印）。
import { execFile, execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { note, putDocument, scenario, sleep, waitSoft } from "./lib.mjs";

const PROMPT =
  "Do not use any tools. Answer in one line exactly: SKILLS=<names of the skills available to you, comma-separated, or none>; RULE=<the shell command your instructions say to collaborate through, or none>";

/** 包里的原生 OpenCode：`<全局 node_modules>/opencode-ai/node_modules/opencode-<平台>/bin/opencode`。 */
function opencodeBinary() {
  try {
    const wrapper = execFileSync("which", ["opencode"], {
      encoding: "utf8",
    }).trim();
    const prefix = join(wrapper, "..", "..", "lib", "node_modules");
    const native = join(
      prefix,
      "opencode-ai",
      "node_modules",
      `opencode-${process.platform}-${process.arch}`,
      "bin",
      "opencode",
    );
    return existsSync(native) ? native : undefined;
  } catch {
    return undefined;
  }
}

function which(program) {
  try {
    return execFileSync("which", [program], { encoding: "utf8" }).trim();
  } catch {
    return undefined;
  }
}

/**
 * 四个 CLI 的临时 HOME 与凭据。答 `{ program, args(launchArgs), secrets }`，或
 * `{ skip }` 说明为什么认证不上。
 */
function prepareClis(scratch) {
  const clis = {};
  const home = (id) => {
    const path = join(scratch, `home-${id}`);
    mkdirSync(path, { recursive: true });
    return path;
  };
  const piAuth = (() => {
    try {
      return JSON.parse(
        readFileSync(join(homedir(), ".pi/agent/auth.json"), "utf8"),
      )["moonshotai-cn"];
    } catch {
      return undefined;
    }
  })();

  /* OpenCode */
  {
    const program = opencodeBinary();
    clis.opencode = program
      ? {
          program,
          home: home("opencode"),
          // 免费模型的名单随 OpenCode 的在线目录变（新 HOME 里内置的那份已经
          // 过期）：跑之前先 `models` 刷一次目录，从里面挑（见 pickFreeModel）。
          model: "opencode/big-pickle",
          line(launch) {
            return [...launch, "run", "--model", this.model, PROMPT];
          },
        }
      : { skip: "没有找到 OpenCode 的原生二进制" };
  }

  /* Pi */
  if (which("pi") && piAuth?.type === "api_key") {
    const h = home("pi");
    mkdirSync(join(h, ".pi/agent"), { recursive: true });
    writeFileSync(
      join(h, ".pi/agent/auth.json"),
      JSON.stringify({ "moonshotai-cn": piAuth }),
      { mode: 0o600 },
    );
    clis.pi = {
      program: which("pi"),
      home: h,
      line: (launch) => [
        ...launch,
        "-p",
        "--no-session",
        "--thinking",
        "off",
        "--model",
        "moonshotai-cn/kimi-k2.6",
        PROMPT,
      ],
    };
  } else {
    clis.pi = {
      skip: "没有 pi，或 ~/.pi/agent/auth.json 里没有 API key 形式的凭据",
    };
  }

  /* OMP */
  if (which("omp") && piAuth?.type === "api_key") {
    const h = home("omp");
    mkdirSync(join(h, ".omp/agent"), { recursive: true });
    writeFileSync(
      join(h, ".omp/agent/models.yml"),
      [
        "providers:",
        "  moonshot-cn:",
        "    baseUrl: https://api.moonshot.cn/v1",
        "    apiKey: MOONSHOT_API_KEY",
        "    api: openai-completions",
        "    authHeader: true",
        "    models:",
        "      - id: kimi-k2.6",
        "        name: Kimi K2.6",
        "        reasoning: false",
        "        input: [text]",
        "",
      ].join("\n"),
    );
    clis.omp = {
      program: which("omp"),
      home: h,
      // OMP 也认 PI_CODING_AGENT_DIR（core 的环境里带着一个）：指到它自己的目录。
      agentDir: join(h, ".omp/agent"),
      secrets: { MOONSHOT_API_KEY: piAuth.key },
      line: (launch) => [
        ...launch,
        "-p",
        "--model=moonshot-cn/kimi-k2.6",
        PROMPT,
      ],
    };
  } else {
    clis.omp = { skip: "没有 omp，或没有可复制的 API key" };
  }

  /* Copilot */
  let token;
  try {
    token = execFileSync("gh", ["auth", "token"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {}
  if (which("copilot") && token) {
    const h = home("copilot");
    mkdirSync(join(h, ".copilot"), { recursive: true });
    // 只复制非凭据的那份（信任过的目录、上次登录的账号名）：没有它 Copilot 会
    // 在第一次启动时问这些。
    try {
      copyFileSync(
        join(homedir(), ".copilot/config.json"),
        join(h, ".copilot/config.json"),
      );
    } catch {}
    clis.copilot = {
      program: which("copilot"),
      home: h,
      secrets: { COPILOT_GITHUB_TOKEN: token },
      line: (launch) => [
        ...launch,
        "-p",
        PROMPT,
        "-s",
        "--no-auto-update",
        "--model",
        "gpt-5-mini",
      ],
    };
  } else {
    clis.copilot = { skip: "没有 copilot，或 `gh auth token` 取不到令牌" };
  }
  return clis;
}

/**
 * 包装脚本：把 HOME 与各 CLI 的配置目录换成临时的，读 0600 的凭据文件，跑 CLI，
 * 输出与退出码写进 `<prefix>.*`。画布内外用同一个脚本，差别只在调用方给的环境
 * 与参数。
 */
function writeWrapper(scratch, id, cli) {
  const secretsFile = join(scratch, `secrets-${id}.sh`);
  writeFileSync(
    secretsFile,
    Object.entries(cli.secrets ?? {})
      .map(([name, value]) => `export ${name}='${value.replaceAll("'", "")}'`)
      .join("\n") + "\n",
    { mode: 0o600 },
  );
  const wrapper = join(scratch, `run-${id}.sh`);
  const h = cli.home;
  writeFileSync(
    wrapper,
    `#!/bin/sh
prefix="$1"; shift
env | grep -E '^(ARMADRA_|OPENCODE_CONFIG|COPILOT_CUSTOM_INSTRUCTIONS)' > "$prefix.env"
export HOME='${h}'
export XDG_CONFIG_HOME='${h}/.config' XDG_DATA_HOME='${h}/.local/share' XDG_STATE_HOME='${h}/.local/state' XDG_CACHE_HOME='${h}/.cache'
export COPILOT_HOME='${h}/.copilot' PI_CODING_AGENT_DIR='${cli.agentDir ?? `${h}/.pi/agent`}'
unset CLAUDE_CONFIG_DIR CODEX_HOME CLAUDECODE
. '${secretsFile}'
'${cli.program}' "$@" > "$prefix.out" 2> "$prefix.err" < /dev/null
echo $? > "$prefix.code"
`,
  );
  chmodSync(wrapper, 0o755);
  return wrapper;
}

const read = (path) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
};

/** 刷一次 OpenCode 的在线模型目录，挑一个免费模型（名字里带 free 的优先）。 */
function pickFreeModel(cli, wrapper, prefix, env, cwd) {
  try {
    execFileSync(wrapper, [prefix, "models", "--refresh"], {
      env,
      cwd,
      timeout: 120_000,
      stdio: "ignore",
    });
  } catch {}
  const listed = read(`${prefix}.out`)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("opencode/"));
  return (
    listed.find((name) => name.endsWith("-free")) ?? listed[0] ?? cli.model
  );
}

/** OpenCode 自己说它看见了什么：`debug skill` 与 `debug config`，不经模型。 */
function opencodeDebug(cli, wrapper, prefix, env, cwd) {
  const answer = {};
  for (const what of ["skill", "config"]) {
    try {
      execFileSync(wrapper, [`${prefix}-${what}`, "debug", what], {
        env,
        cwd,
        timeout: 60_000,
        stdio: "ignore",
      });
    } catch {}
    answer[what] = read(`${prefix}-${what}.out`);
  }
  return answer;
}

export default async function run6(ctx) {
  const {
    api,
    data,
    project,
    scratch,
    workspace,
    documentPath,
    makeNode,
    status,
    liveSession,
    openPage,
  } = ctx;
  const s = scenario("6-other-clis");
  const matrix = {};
  // 页面挂着时会给带 agent 的新节点自己开会话、敲启动行（交互式 TUI），与这里
  // 由 core 起的非交互会话抢同一个节点。先关页面，结束时删掉这几个节点再开。
  if (ctx.page !== undefined) {
    await ctx.page.close();
    ctx.page = undefined;
  }
  let added = [];
  try {
    const clis = prepareClis(scratch);
    const ids = Object.keys(clis);
    for (const id of ids) {
      await api(`/api/agents/${id}/integration/install`, {
        method: "POST",
      }).catch((error) => note(`${id} 注入产物准备失败`, error.message));
    }
    const rows = await api("/api/agents");

    // 每个 CLI 一个节点：状态行按节点记，互不干扰。
    const nodes = Object.fromEntries(
      ids.map((id, index) => [
        id,
        makeNode(`${id}-probe`, 2700, index * 420, id),
      ]),
    );
    added = Object.values(nodes).map((node) => node.id);
    await putDocument(api, documentPath, (current) => ({
      nodes: [...current.nodes, ...Object.values(nodes)],
    }));

    const base = {
      PATH: process.env.PATH,
      TERM: "dumb",
      LANG: "en_US.UTF-8",
      USER: process.env.USER,
    };
    for (const id of ids) {
      const cli = clis[id];
      const entry = (matrix[id] = { skip: cli.skip });
      if (cli.skip) {
        s.check(`${id}：未能认证（跳过）`, true, cli.skip);
        continue;
      }
      const node = nodes[id];
      const wrapper = writeWrapper(scratch, id, cli);
      const launchArgs = rows.find((row) => row.id === id)?.launchArgs ?? [];
      entry.launchArgs = launchArgs;

      /* ------------------------------ 画布外 ------------------------------ */

      const outsidePrefix = join(scratch, `${id}-outside`);
      const outsideEnv = {
        ...base,
        ARMADRA_NODE_ID: node.id,
        ARMADRA_ENDPOINT_FILE: join(data, "hook-endpoint.env"),
      };
      if (id === "opencode") {
        cli.model = pickFreeModel(
          cli,
          wrapper,
          join(scratch, "opencode-models"),
          base,
          project,
        );
        entry.model = cli.model;
        note("OpenCode 用的免费模型", cli.model);
      }
      await new Promise((done) =>
        execFile(
          wrapper,
          [outsidePrefix, ...cli.line([])],
          { env: outsideEnv, cwd: project, timeout: 240_000 },
          () => done(),
        ),
      );
      const outside = {
        code: read(`${outsidePrefix}.code`).trim(),
        out: read(`${outsidePrefix}.out`).trim().slice(-400),
        err: read(`${outsidePrefix}.err`).trim().slice(-400),
      };
      entry.outside = outside;
      if (outside.code !== "0" || outside.out === "") {
        // 认证或模型不通：如实记下，不算注入失败。
        entry.skip = `未能认证或模型不可用：${outside.err.slice(-200) || outside.out.slice(-200)}`;
        s.check(`${id}：未能认证（跳过）`, true, entry.skip);
        continue;
      }
      s.check(
        `${id} 画布外：答不出我们的技能与画布规则`,
        !/armadra/i.test(outside.out),
        outside.out,
      );
      s.check(
        `${id} 画布外：这个节点没有任何上报`,
        status(node.id) === undefined,
        status(node.id),
      );
      if (id === "opencode") {
        const debug = opencodeDebug(
          cli,
          wrapper,
          `${outsidePrefix}-debug`,
          outsideEnv,
          project,
        );
        s.check(
          "opencode 画布外：debug skill 里没有 armadra，debug config 里没有画布说明",
          !debug.skill.includes("armadra") &&
            !debug.config.includes("integration/opencode"),
          { skill: debug.skill.slice(0, 300) },
        );
      }

      /* ------------------------------ 画布内 ------------------------------ */

      const insidePrefix = join(scratch, `${id}-inside`);
      const startedAt = Date.now();
      const session = await api("/api/terminals", {
        method: "POST",
        body: JSON.stringify({
          workspaceId: workspace.id,
          cwd: project,
          nodeId: node.id,
          agent: { id },
          command: wrapper,
          args: [insidePrefix, ...cli.line(launchArgs)],
        }),
      });
      await waitSoft(() => existsSync(`${insidePrefix}.code`), {
        timeout: 240_000,
        interval: 1000,
      });
      const inside = {
        code: read(`${insidePrefix}.code`).trim(),
        out: read(`${insidePrefix}.out`).trim().slice(-600),
        err: read(`${insidePrefix}.err`).trim().slice(-400),
        env: read(`${insidePrefix}.env`)
          .split("\n")
          .filter(Boolean)
          .map((line) => line.split("=")[0]),
        session: session.id,
      };
      entry.inside = inside;
      s.check(`${id} 画布内：跑完一轮`, inside.code === "0", inside.err);
      s.check(
        `${id} 画布内：答得出我们的技能（armadra）`,
        /SKILLS=[^;]*armadra/i.test(inside.out),
        inside.out,
      );
      s.check(
        `${id} 画布内：答得出画布规则里的 armadra-hook canvas`,
        /RULE=.*armadra-hook( canvas)?/i.test(inside.out),
      );
      // 上报是异步的（扩展里 fire-and-forget，CLI 退出前可能还在路上）。
      const reported = await waitSoft(
        () => {
          const row = status(node.id);
          return row &&
            ["hook", "extension"].includes(row.state_source) &&
            Date.parse(row.last_event_at ?? "") >= startedAt - 1000
            ? row
            : undefined;
        },
        { timeout: 15_000, interval: 500 },
      );
      entry.status = reported
        ? {
            state: reported.state,
            source: reported.state_source,
            at: reported.last_event_at,
          }
        : (status(node.id) ?? null);
      s.check(
        `${id} 画布内：事件回到 core，节点状态由上报写出`,
        reported !== undefined,
        entry.status,
      );
      if (id === "opencode") {
        s.check(
          "opencode 画布内：终端环境里有 OPENCODE_CONFIG_DIR 与 OPENCODE_CONFIG_CONTENT",
          inside.env.includes("OPENCODE_CONFIG_DIR") &&
            inside.env.includes("OPENCODE_CONFIG_CONTENT"),
          inside.env,
        );
        // 同一份注入环境（从这个节点的终端里抄下来的），问 OpenCode 自己。
        const injected = Object.fromEntries(
          read(`${insidePrefix}.env`)
            .split("\n")
            .filter(Boolean)
            .map((line) => [
              line.slice(0, line.indexOf("=")),
              line.slice(line.indexOf("=") + 1),
            ]),
        );
        const debug = opencodeDebug(
          cli,
          wrapper,
          `${insidePrefix}-debug`,
          { ...base, ...injected },
          project,
        );
        s.check(
          "opencode 画布内：debug skill 列出 armadra，debug config 带着画布说明文件",
          debug.skill.includes("armadra") &&
            debug.config.includes(join("integration", "opencode")),
          { skill: debug.skill.slice(0, 300) },
        );
      }
      if (id === "copilot") {
        s.check(
          "copilot 画布内：终端环境里有 COPILOT_CUSTOM_INSTRUCTIONS_DIRS",
          inside.env.includes("COPILOT_CUSTOM_INSTRUCTIONS_DIRS"),
          inside.env,
        );
      }
      // 会话随 CLI 退出而结束；留着的话收尾时 kill-server 一并带走。
      note(`${id} 结果`, {
        outside: outside.out.slice(0, 160),
        inside: inside.out.slice(0, 160),
        status: entry.status,
        session: liveSession(node.id)?.status,
      });
      await sleep(500);
    }
  } catch (error) {
    s.fail(error);
  }
  try {
    await putDocument(api, documentPath, (current) => ({
      nodes: current.nodes.filter((node) => !added.includes(node.id)),
    }));
    ctx.page = await openPage();
  } catch (error) {
    note("场景 6 收尾失败", error.message);
  }
  ctx.otherClis = matrix;
  s.finish();
}
