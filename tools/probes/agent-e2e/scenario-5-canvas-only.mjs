// 场景 5：画布内注入只在画布里生效（设计 canvas-only-integration §7）。
//
// 同一台机器、同一份环境（节点身份 ARMADRA_NODE_ID 也带着），唯一的差别是
// 启动行上有没有 core 给的注入参数（`GET /api/agents` 的 `launchArgs`）：
//
//   * 画布外：Codex 在临时 CODEX_HOME 里跑一轮，会话记录里没有画布说明，Hook
//     一次都没打到 core；Claude 的 init 里没有我们的插件，也没有插件技能
//     `armadra:armadra`，Hook 同样一次没打到。
//   * 画布内：同样的命令加上注入参数，Codex 的会话记录里出现画布规则与完整
//     技能的路径、Hook 打到 core；Claude 的 init 里出现插件与插件技能、Hook
//     打到 core。
//
// 「Hook 打到 core」看的是源节点那一行 `agent_status` 的 last_event_at 有没有
// 前进：外面那次跑完它必须原地不动，里面那次跑完它必须变。Claude 只能用真实
// 配置目录，而我们对 Claude 只做逐次注入，不写它的全局文件；那里若还留着旧版
// 装的 `skills/armadra`（升级后真实应用第一次启动才会清），照实记下来。
import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { note, scenario } from "./lib.mjs";

function run(program, args, options) {
  return new Promise((done) => {
    const child = execFile(
      program,
      args,
      { timeout: 180_000, maxBuffer: 32 * 1024 * 1024, ...options },
      (error, stdout, stderr) =>
        done({
          code: error ? (error.code ?? 1) : 0,
          stdout: String(stdout),
          stderr: String(stderr),
        }),
    );
    // 两个 CLI 都会等 stdin 上的附加输入：立刻给 EOF。
    child.stdin?.end();
  });
}

/** 临时 CODEX_HOME 里最新的一份会话记录。 */
function newestRollout(codexHome) {
  const files = [];
  const walk = (directory) => {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (entry.endsWith(".jsonl"))
        files.push({ path, at: statSync(path).mtimeMs });
    }
  };
  walk(join(codexHome, "sessions"));
  files.sort((a, b) => b.at - a.at);
  return files[0]?.path;
}

function claudeInit(stdout) {
  for (const line of stdout.split("\n")) {
    try {
      const message = JSON.parse(line);
      if (message.type === "system" && message.subtype === "init")
        return message;
    } catch {}
  }
  return undefined;
}

export default async function run5(ctx) {
  const { api, codexHome, data, project, source, status } = ctx;
  const s = scenario("5-canvas-only");
  try {
    const rows = await api("/api/agents");
    const claudeArgs = rows.find((row) => row.id === "claude")?.launchArgs;
    const codexArgs = rows.find((row) => row.id === "codex")?.launchArgs;
    s.check(
      "core 给 Claude 的注入：--settings / --plugin-dir / --append-system-prompt-file",
      ["--settings", "--plugin-dir", "--append-system-prompt-file"].every(
        (flag) => claudeArgs?.includes(flag),
      ),
      claudeArgs,
    );
    s.check(
      "core 给 Codex 的注入：-c 的 Hook、developer_instructions、关升级检查",
      codexArgs?.includes("check_for_update_on_startup=false") &&
        codexArgs.some((arg) => arg.startsWith("hooks.SessionStart=")) &&
        codexArgs.some((arg) => arg.startsWith("developer_instructions=")),
      codexArgs?.filter((arg) => !arg.startsWith("developer_instructions=")),
    );
    const trust = readFileSync(join(codexHome, "config.toml"), "utf8");
    s.check(
      "Codex 的信任记录只写进了临时 CODEX_HOME",
      trust.includes('"/<session-flags>/config.toml:session_start:0:0"'),
    );

    // 两边共用的环境：带着源节点的身份，只差启动行。
    const base = { ...process.env };
    for (const name of ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "TMUX"])
      delete base[name];
    base.ARMADRA_NODE_ID = source.id;
    base.ARMADRA_ENDPOINT_FILE = join(data, "hook-endpoint.env");
    const lastEvent = () => status(source.id)?.last_event_at ?? null;

    /* ------------------------------- Codex -------------------------------- */

    const codexEnv = { ...base, CODEX_HOME: codexHome };
    delete codexEnv.CLAUDE_CONFIG_DIR;
    const prompt = "Reply with just OK.";
    let before = lastEvent();
    const outside = await run(
      "codex",
      [
        "exec",
        "--skip-git-repo-check",
        "-c",
        "check_for_update_on_startup=false",
        prompt,
      ],
      { cwd: project, env: codexEnv },
    );
    const outsideRollout = newestRollout(codexHome);
    const outsideText = outsideRollout
      ? readFileSync(outsideRollout, "utf8")
      : "";
    s.check(
      "画布外：Codex 跑完一轮",
      outside.code === 0,
      outside.stderr.slice(-300),
    );
    s.check(
      "画布外：Codex 的会话里没有画布说明，也没有 armadra 技能",
      outsideText !== "" &&
        !outsideText.includes("画布规则") &&
        !outsideText.includes("skills/armadra"),
      outsideRollout,
    );
    s.check("画布外：Codex 的 Hook 没有打到 core", lastEvent() === before, {
      before,
      after: lastEvent(),
    });

    before = lastEvent();
    const inside = await run(
      "codex",
      ["exec", "--skip-git-repo-check", ...(codexArgs ?? []), prompt],
      { cwd: project, env: codexEnv },
    );
    const insideRollout = newestRollout(codexHome);
    const insideText = insideRollout ? readFileSync(insideRollout, "utf8") : "";
    s.check(
      "画布内：Codex 跑完一轮",
      inside.code === 0,
      inside.stderr.slice(-300),
    );
    s.check(
      "画布内：Codex 的会话里有画布规则与完整技能的路径",
      insideRollout !== outsideRollout &&
        insideText.includes("画布规则") &&
        insideText.includes(join("integration", "codex", "skills", "armadra")),
      insideRollout,
    );
    s.check("画布内：Codex 的 Hook 打到了 core", lastEvent() !== before, {
      before,
      after: lastEvent(),
    });

    /* ------------------------------- Claude ------------------------------- */

    // 真实配置目录：钥匙串里的登录只认它。
    const claudeEnv = { ...base };
    delete claudeEnv.CLAUDE_CONFIG_DIR;
    const legacySkill = existsSync(
      join(homedir(), ".claude/skills/armadra/SKILL.md"),
    );
    if (legacySkill)
      note(
        "真实 ~/.claude/skills/armadra 仍在：旧版的全局安装，升级后真实应用第一次启动会备份并清掉；探针不碰它",
      );
    const claudeLine = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--max-turns",
      "1",
    ];
    before = lastEvent();
    const claudeOutside = await run("claude", [...claudeLine, prompt], {
      cwd: project,
      env: claudeEnv,
    });
    const outsideInit = claudeInit(claudeOutside.stdout);
    s.check(
      "画布外：Claude 起来了",
      outsideInit !== undefined,
      claudeOutside.stderr.slice(-300),
    );
    s.check(
      "画布外：Claude 没有我们的插件与插件技能",
      outsideInit !== undefined &&
        !(outsideInit.plugins ?? []).some((plugin) =>
          String(plugin.name ?? plugin).includes("armadra"),
        ) &&
        !(outsideInit.skills ?? []).includes("armadra:armadra"),
      {
        plugins: outsideInit?.plugins,
        skills: outsideInit?.skills?.filter((name) => name.includes("armadra")),
        legacyGlobalSkill: legacySkill,
      },
    );
    s.check("画布外：Claude 的 Hook 没有打到 core", lastEvent() === before, {
      before,
      after: lastEvent(),
    });

    before = lastEvent();
    const claudeInside = await run(
      "claude",
      [...claudeLine, ...(claudeArgs ?? []), prompt],
      { cwd: project, env: claudeEnv },
    );
    const insideInit = claudeInit(claudeInside.stdout);
    s.check(
      "画布内：Claude 加载了我们的插件与插件技能",
      insideInit !== undefined &&
        (insideInit.plugins ?? []).some((plugin) =>
          String(plugin.name ?? plugin).includes("armadra"),
        ) &&
        (insideInit.skills ?? []).includes("armadra:armadra"),
      {
        plugins: insideInit?.plugins,
        skills: insideInit?.skills?.filter((name) => name.includes("armadra")),
      },
    );
    s.check("画布内：Claude 的 Hook 打到了 core", lastEvent() !== before, {
      before,
      after: lastEvent(),
    });
  } catch (error) {
    s.fail(error);
  }
  s.finish();
}
