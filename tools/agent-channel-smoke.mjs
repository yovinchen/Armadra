/**
 * The status channel of one real Agent CLI, end to end.
 *
 * Unit tests already cover both halves in isolation: the installers write the
 * bytes they are supposed to write, and the normalizers turn a recorded payload
 * into an `AgentEvent`. Neither can answer the only question that decides
 * whether the channel works — does *this* CLI, on *this* machine, actually fire
 * the events we subscribed, through the transport we generated, with the node
 * token and terminal binding of a session the runtime created? That is what
 * this script drives (设计 docs/design/agent-collaboration-channels.md §5.2,
 * 真实 CLI row).
 *
 * It asserts, for one provider:
 *
 *   1. installing writes an adapter into a config home the CLI reads;
 *   2. a turn in a runtime-created terminal moves the node `working → done`;
 *   3. `stateSource` on that row is the channel the adapter actually uses —
 *      `hook` for a forked command hook, `extension` for an in-process one;
 *   4. Pi / Oh My Pi additionally report a *measured* context window
 *      (`provider_hook` / `reported`), not an estimate;
 *   5. uninstalling leaves every file that existed before it byte for byte as
 *      it was, and removes everything the install wrote.
 *
 * ## The user's own configuration is never touched
 *
 * The runtime resolves each CLI's config home from its own environment, but a
 * terminal child only inherits an allow-list of variables — `HOME` is on it,
 * `COPILOT_HOME` / `PI_CODING_AGENT_DIR` / `OMP_PROFILE` are not (see
 * `terminal/backend.rs::INHERITED_ENV`). Pointing the installer at a directory
 * the CLI would not read is worse than useless, so the redirection has to be
 * one both sides agree on: this script gives the runtime a **temporary `HOME`**
 * and clears every per-CLI override out of its environment, which puts the
 * installer and the CLI in the same place.
 *
 * A temporary home has no credentials in it, so the config files that carry
 * them are **copied** out of the real config home first — an explicit
 * per-provider list, read only, never written back. On macOS the login keychain
 * is reached through `$HOME/Library/Keychains`, so that one path is symlinked;
 * without it a provider whose API key comes from `security find-generic-password`
 * cannot authenticate. Nothing else is shared, and the real config home is
 * never opened for writing — there is no backup/restore step to get wrong.
 *
 * ## How the turn is started
 *
 * Two ways, per provider (`deliver`). Most take the prompt on the command line
 * and exit the moment they are done; a dead terminal has no live session, so
 * `context-usage` would answer `session_ended` and the node's last state would
 * be raced by `terminal.exit`. Those are launched through a two-line wrapper
 * that runs the CLI and then blocks on stdin — the CLI itself is unwrapped,
 * same argv, same environment, same PTY.
 *
 * Copilot instead runs its normal interactive session and is handed the prompt
 * through the runtime's own paste endpoint, which is what a canvas node does.
 *
 * ## Known result, 2026-09-06
 *
 * `pi` and `omp` pass. `copilot` fails at step 2, and the failure is real: on
 * 1.0.83 the `sessionStart` that opens a session arrives *after* that turn's
 * `userPromptSubmitted` — it carries the prompt as `initialPrompt`, so the
 * session is created *by* the first prompt — and a session event resets the
 * node by design (reduce rule 4, "a new session forgets the old turn"). So a
 * Copilot node's `working` lives about 20 ms and the user never sees RUNNING
 * on the turn that opened the session. `done` and `stateSource: hook` are
 * correct. That is an adapter question, not a script bug: a red `copilot` run
 * here is this defect until it is fixed.
 *
 * Usage: node tools/agent-channel-smoke.mjs <armadra-runtime> <armadra-hook> <pi|omp|copilot|opencode>
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

/* -------------------------------- providers ------------------------------- */

/**
 * What each CLI needs and what it must produce.
 *
 * `seed` are paths relative to the home directory. They are the files that
 * carry credentials and model selection — enough for one non-interactive turn,
 * and nothing about sessions, history or caches. A path that does not exist is
 * skipped: a CLI configured differently simply gets less, and the failure that
 * follows names what happened.
 *
 * `stateSource` lists the values that are correct for this provider. It is a
 * list because opencode is mid-migration: its plugin forks the client today
 * (`hook`) and moves in-process (`extension`) with B3, and this script has no
 * business deciding which of the two the runtime it is driving implements. It
 * prints what it saw either way.
 */
const PROVIDERS = {
  pi: {
    // `-p` is Pi's non-interactive mode; the extension loads the same way.
    deliver: "argv",
    args: (prompt) => ["-p", prompt],
    seed: [
      ".pi/agent/auth.json",
      ".pi/agent/models.json",
      ".pi/agent/models-store.json",
      ".pi/agent/settings.json",
    ],
    configHome: ".pi/agent",
    stateSource: ["extension"],
    contextUsage: { source: "provider_hook", quality: "reported" },
  },
  omp: {
    // Interactive OMP opens a setup wizard on a home it has never seen, and a
    // wizard waiting for a keypress is not a turn. `-p` skips it.
    deliver: "argv",
    args: (prompt) => ["-p", prompt],
    seed: [
      ".omp/agent/config.yml",
      ".omp/agent/models.yml",
      ".omp/agent/auth.json",
    ],
    configHome: ".omp/agent",
    stateSource: ["extension"],
    contextUsage: { source: "provider_hook", quality: "reported" },
  },
  copilot: {
    /**
     * Copilot is driven interactively because `-p` adds a second problem on
     * top of the ordering one in the module note: `sessionEnd` follows
     * `agentStop` by ~10 ms, so a non-interactive run ends with no state at
     * all rather than with the `done` a user would see. A canvas node runs the
     * CLI's normal session and types into it, which is what this does: launch,
     * wait for the pane to settle, then paste + Enter through the runtime's own
     * endpoint. What that leaves is the first-turn `working` — measured here,
     * and reported as a failure rather than accommodated.
     */
    deliver: "paste",
    args: () => ["--allow-all-tools"],
    seed: [
      ".copilot/config.json",
      ".copilot/settings.json",
      ".copilot/mcp-config.json",
      ".config/github-copilot",
    ],
    configHome: ".copilot",
    stateSource: ["hook"],
    contextUsage: null,
    // Interactive Copilot asks whether it may read the folder it opened in,
    // and a modal waiting for a keypress swallows the pasted prompt. The
    // answer belongs in the temporary home's own config, where Copilot keeps
    // it for a folder the user has already trusted.
    prepare(home, cwd) {
      const path = join(home, ".copilot", "config.json");
      let config = {};
      try {
        // Copilot writes a `//` comment banner above the JSON.
        const text = readFileSync(path, "utf8").replace(/^\s*\/\/.*$/gm, "");
        config = JSON.parse(text);
      } catch {
        // No seeded config: start from an empty one.
      }
      // Both spellings: `/tmp` is a symlink on macOS and the pane opens in the
      // resolved path, which is the one Copilot compares against.
      const trusted = new Set(config.trustedFolders ?? []);
      trusted.add(cwd);
      trusted.add(realpathSync(cwd));
      config.trustedFolders = [...trusted];
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, JSON.stringify(config, null, 2), { mode: 0o600 });
    },
  },
  opencode: {
    deliver: "argv",
    args: (prompt) => ["run", prompt],
    seed: [
      ".config/opencode/opencode.json",
      ".config/opencode/config.json",
      ".local/share/opencode/auth.json",
    ],
    configHome: ".config/opencode",
    stateSource: ["hook", "extension"],
    contextUsage: null,
  },
};

/** Small enough to be cheap, specific enough that a wrong answer is obvious. */
const PROMPT = "reply with the single word ok and do nothing else";

/* ---------------------------------- setup --------------------------------- */

const [runtimeArgument, hookArgument, provider] = process.argv.slice(2);
const definition = provider ? PROVIDERS[provider] : undefined;
if (!runtimeArgument || !hookArgument || !definition) {
  console.error(
    `usage: node tools/agent-channel-smoke.mjs <armadra-runtime> <armadra-hook> <${Object.keys(PROVIDERS).join("|")}>`,
  );
  process.exit(2);
}

// Absolute, because these paths end up in a configuration file the CLI runs
// from its *own* working directory: a hook entry spelled `target/debug/…`
// resolves against the project the terminal opened and silently never fires.
const runtimeBinary = resolve(runtimeArgument);
const hookBinary = resolve(hookArgument);
for (const binary of [runtimeBinary, hookBinary]) {
  if (!existsSync(binary)) {
    console.error(`no such binary: ${binary}`);
    process.exit(2);
  }
}

// A CLI this machine does not have is not a failure of the channel. Neither is
// one that is on PATH but cannot start — a half-finished install answers its
// own version probe with an error, and guessing at another path for it would
// only run something the user did not install.
const resolved = which(provider);
if (!resolved) {
  console.log(`skipped: ${provider} is not on PATH`);
  process.exit(0);
}
const version = spawnSync(resolved, ["--version"], {
  encoding: "utf8",
  timeout: 60_000,
});
if (version.status !== 0) {
  // `error` is the spawn itself failing — a shim with no usable interpreter
  // reads as ENOEXEC, which a shell would paper over and the runtime, which
  // execs the program directly, would not.
  const reason =
    (version.error && String(version.error)) ||
    firstLine(`${version.stdout ?? ""}\n${version.stderr ?? ""}`) ||
    "no output";
  console.log(`skipped: ${resolved} --version failed — ${reason}`);
  process.exit(0);
}
console.log(`${provider}: ${firstLine(version.stdout)} (${resolved})`);

/** The first line with anything on it; a CLI may lead with a blank one. */
function firstLine(text) {
  return (
    (text ?? "")
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line !== "") ?? ""
  );
}

// Not the platform temp directory: the runtime puts a unix socket in the data
// directory, and the usual macOS temp path is longer than a socket path may be.
const dataDir = mkdtempSync("/tmp/armadra-channel-");
const projectDir = mkdtempSync("/tmp/armadra-channel-project-");
const cliHome = mkdtempSync("/tmp/armadra-channel-home-");
const binDir = join(dataDir, "bin");
mkdirSync(binDir, { recursive: true });

seedHome();

writeFileSync(
  join(dataDir, "settings.json"),
  JSON.stringify({
    terminal: { backend: "direct" },
    usage: { enabled: false },
  }),
  { mode: 0o600 },
);

// A `paste` provider runs its own interactive session, exactly as a canvas
// node does, and needs no wrapper. An `argv` provider is handed the prompt on
// its command line and exits the moment it is done; see the module note for
// why the pane has to outlive that.
const launcher =
  definition.deliver === "paste" ? resolved : join(binDir, `${provider}-turn`);
if (definition.deliver === "argv") {
  writeFileSync(
    launcher,
    `#!/bin/sh\n${shellWords([resolved, ...definition.args(PROMPT)])}\nwhile IFS= read -r line; do :; done\n`,
    { mode: 0o700 },
  );
}

const runtime = spawn(runtimeBinary, ["--listen", "tcp:127.0.0.1:0"], {
  env: {
    ...cleanEnvironment(),
    HOME: cliHome,
    ARMADRA_DATA_DIR: dataDir,
    ARMADRA_DATABASE_URL: `sqlite://${join(dataDir, "canvas.db")}?mode=rwc`,
    ARMADRA_HOOK_BIN: hookBinary,
  },
  stdio: ["ignore", "inherit", "inherit"],
});

let failure = null;
try {
  await main();
  console.log(`agent-channel smoke passed for ${provider}`);
} catch (error) {
  failure = error;
} finally {
  runtime.kill("SIGKILL");
  if (failure) {
    // What went wrong is in these directories — the adapter as it was
    // written, the CLI's own session files, the runtime's data. Deleting them
    // is exactly what makes a channel failure impossible to diagnose.
    console.error(`kept for inspection: ${dataDir} ${projectDir} ${cliHome}`);
  } else {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
    // The keychain is a symlink; `rmSync` removes the link, never its target.
    rmSync(cliHome, { recursive: true, force: true });
  }
}
if (failure) {
  console.error(failure);
  process.exit(1);
}

/* ---------------------------------- steps --------------------------------- */

async function main() {
  const base = await awaitEndpoint();
  const configHome = join(cliHome, definition.configHome);

  // Everything the seeding put there, before the installer touches it. What
  // uninstall has to give back.
  const before = digestTree(configHome);

  const install = await call(
    base,
    "POST",
    `/api/agents/${provider}/hooks/install`,
    {},
  );
  assert.equal(install.installed, true, "the installer reported no install");
  assert.ok(
    install.configPath.startsWith(cliHome),
    `the adapter was written outside the temporary home: ${install.configPath}`,
  );
  assert.ok(existsSync(install.configPath), "the adapter file was not written");
  console.log(`installed ${install.configPath}`);

  const { workspaceId, nodeId } = await createBoard(base);
  const session = await call(base, "POST", "/api/terminals", {
    workspaceId,
    cwd: ".",
    nodeId,
    command: launcher,
    args: definition.deliver === "paste" ? definition.args() : [],
    agent: { id: provider },
  });
  if (definition.deliver === "paste") {
    await settle(base, session);
    // Bracketed paste plus Enter — the same endpoint the canvas sends a
    // prompt through, so the turn starts the way a user's would.
    await call(base, "POST", `/api/terminals/${session.id}/paste`, {
      text: PROMPT,
      enter: true,
    });
  }

  // The whole point: these rows are written by the CLI's own adapter, over the
  // runtime's socket, with the node token that terminal was issued.
  const seen = [];
  const working = await awaitState(base, workspaceId, nodeId, "working", seen, {
    session,
    // Reaching `done` without ever showing `working` is not a slow poll: it is
    // a node that never told the user it was running. Say so, and stop —
    // waiting for a `working` that already came and went would only time out
    // four minutes later with a vaguer message.
    give_up_on: "done",
  });
  console.log(`working — stateSource=${working.stateSource ?? "(none)"}`);
  const done = await awaitState(base, workspaceId, nodeId, "done", seen, {
    session,
  });

  assert.deepEqual(
    seen,
    ["working", "done"],
    `the node did not go working → done; it went ${seen.join(" → ")}`,
  );
  assert.ok(
    definition.stateSource.includes(done.stateSource),
    `stateSource was ${done.stateSource ?? "(none)"}, expected one of ${definition.stateSource.join(" / ")}`,
  );
  console.log(`done — stateSource=${done.stateSource}`);

  if (definition.contextUsage) {
    // A measured window, not a sum over a transcript: `estimate` is the field
    // the UI reads to tell the two apart, and a reported reading omits it.
    const usage = await call(
      base,
      "GET",
      `/api/workspaces/${workspaceId}/nodes/${nodeId}/context-usage` +
        `?sessionId=${encodeURIComponent(session.id)}&generation=${session.generation ?? 0}`,
    );
    assert.equal(
      usage.source,
      definition.contextUsage.source,
      `context-usage source was ${usage.source} (${usage.unknownReason ?? "no reason"})`,
    );
    assert.equal(usage.quality, definition.contextUsage.quality);
    assert.ok(
      typeof usage.usedTokens === "number" && usage.usedTokens > 0,
      "a reported reading carried no token count",
    );
    assert.equal(usage.estimate, undefined, "a reported reading was estimated");
    console.log(
      `context-usage — ${usage.source}/${usage.quality}, ${usage.usedTokens}/${usage.capacityTokens ?? "?"} tokens`,
    );
  }

  await call(base, "POST", `/api/terminals/${session.id}/terminate`, {
    mode: "session",
  });

  const removed = await call(
    base,
    "POST",
    `/api/agents/${provider}/hooks/uninstall`,
    {},
  );
  assert.equal(removed.installed, false);
  assert.ok(
    !existsSync(install.configPath),
    `uninstall left ${install.configPath} behind`,
  );
  // A file that was there before the install must be there afterwards, with
  // the same bytes. Files the CLI wrote for itself during the turn (sessions,
  // caches, databases) are its own and are not compared.
  for (const [path, digest] of before) {
    const now = digestFile(join(configHome, path));
    assert.equal(now, digest, `uninstall changed ${path}`);
  }
  const leftovers = markedFiles(configHome);
  assert.deepEqual(leftovers, [], `uninstall left our own files: ${leftovers}`);
  console.log(`uninstalled — ${before.size} pre-existing file(s) unchanged`);
}

async function createBoard(base) {
  const workspace = await call(base, "POST", "/api/workspaces", {
    name: `${provider} channel smoke`,
    rootPath: projectDir,
    permissions: { read: true, write: true, execute: true },
  });
  const boards = await call(
    base,
    "GET",
    `/api/workspaces/${workspace.id}/boards`,
  );
  const boardId = boards[0].id;
  const document = await call(
    base,
    "GET",
    `/api/workspaces/${workspace.id}/boards/${boardId}/document`,
  );
  const nodeId = crypto.randomUUID();
  const now = new Date().toISOString();
  await call(
    base,
    "PUT",
    `/api/workspaces/${workspace.id}/boards/${boardId}/document`,
    {
      expectedUpdatedAt: document.board.updatedAt,
      nodes: [
        {
          id: nodeId,
          boardId,
          type: "terminal",
          title: provider,
          color: "#0a84ff",
          position: { x: 0, y: 0 },
          size: { width: 480, height: 320 },
          labels: [],
          note: "",
          data: { kind: "terminal", cwd: ".", agent: { id: provider } },
          createdAt: now,
          updatedAt: now,
        },
      ],
      edges: [],
      viewport: document.board.viewport,
    },
  );
  return { workspaceId: workspace.id, nodeId };
}

/* --------------------------------- the home ------------------------------- */

/**
 * Copies the credential-bearing files of the real config home into the
 * temporary one. Read only: nothing is written back, and a missing file is
 * simply not copied.
 */
function seedHome() {
  const real = homedir();
  const copied = [];
  for (const entry of definition.seed) {
    const source = join(real, entry);
    if (!existsSync(source)) continue;
    const target = join(cliHome, entry);
    mkdirSync(join(target, ".."), { recursive: true });
    cpSync(source, target, { recursive: true });
    copied.push(entry);
  }
  // macOS keeps API keys in the login keychain, which `security` finds through
  // `$HOME/Library/Keychains`. A link, so the real keychain is read where it
  // is and nothing is ever copied out of it.
  if (process.platform === "darwin") {
    const keychains = join(real, "Library", "Keychains");
    if (existsSync(keychains)) {
      mkdirSync(join(cliHome, "Library"), { recursive: true });
      symlinkSync(keychains, join(cliHome, "Library", "Keychains"));
      copied.push("Library/Keychains (link)");
    }
  }
  definition.prepare?.(cliHome, projectDir);
  console.log(`seeded ${cliHome}: ${copied.join(", ") || "(nothing)"}`);
}

/**
 * The runtime's environment with every per-CLI config override removed, so
 * that `HOME` is the only thing deciding where the adapter goes — and the CLI,
 * which inherits `HOME` and not these, agrees with it.
 */
function cleanEnvironment() {
  const env = { ...process.env };
  for (const key of [
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
    "CLAUDE_CONFIG_DIR",
    "CODEX_HOME",
    "COPILOT_HOME",
    "GEMINI_CLI_HOME",
    "GEMINI_DIR",
    "OPENCODE_CONFIG_DIR",
    "PI_CODING_AGENT_DIR",
    "PI_CONFIG_DIR",
    "PI_PROFILE",
    "OMP_PROFILE",
  ]) {
    delete env[key];
  }
  return env;
}

/* --------------------------------- helpers -------------------------------- */

/** First executable named `command` on `PATH`, or null. No shell, no guessing. */
function which(command) {
  for (const directory of (process.env.PATH ?? "").split(":")) {
    if (!directory) continue;
    const path = join(directory, command);
    try {
      if (lstatSync(path).isFile() || existsSync(path)) return path;
    } catch {
      // Not here.
    }
  }
  return null;
}

/** One `/bin/sh` command line from an argv, quoted so a path with a space survives. */
function shellWords(argv) {
  return argv.map((word) => `'${word.replaceAll("'", `'\\''`)}'`).join(" ");
}

function digestFile(path) {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return null;
  }
}

/** Relative path → digest, for every regular file under `root`. */
function digestTree(root, base = root, into = new Map()) {
  let entries = [];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return into;
  }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) digestTree(path, base, into);
    else if (entry.isFile()) into.set(relative(base, path), digestFile(path));
  }
  return into;
}

/**
 * Files under the config home that still carry our marker. The installers'
 * own recognition rule is "the text `armadra-hook` appears in it", so this is
 * the same question asked from outside: is anything of ours still installed?
 * Databases, logs and session directories are the CLI's own and are skipped.
 */
function markedFiles(root, base = root, into = []) {
  let entries = [];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return into;
  }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (["sessions", "logs", "cache", "node_modules"].includes(entry.name)) {
        continue;
      }
      markedFiles(path, base, into);
      continue;
    }
    if (!entry.isFile() || lstatSync(path).size > 1_000_000) continue;
    let text = "";
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    if (text.includes("armadra-hook")) into.push(relative(base, path));
  }
  return into;
}

async function call(base, method, path, body) {
  const response = await fetch(base + path, {
    method,
    headers: {
      "content-type": "application/json",
      "x-armadra-hook-token": bearer(),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${method} ${path}: ${response.status} ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

function bearer() {
  try {
    const file = readFileSync(join(dataDir, "hook-endpoint.env"), "utf8");
    return /ARMADRA_HOOK_TOKEN='([^']*)'/.exec(file)?.[1] ?? "";
  } catch {
    return "";
  }
}

async function awaitEndpoint() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const document = JSON.parse(
        readFileSync(join(dataDir, "endpoints.json"), "utf8"),
      );
      if (document.runtime?.http) return document.runtime.http;
    } catch {
      // The runtime has not published yet.
    }
    await sleep(100);
  }
  throw new Error("the runtime never published an endpoint");
}

/**
 * Polls the sessions list — the same payload the sidebar and the node header
 * rebuild from — until this node reports `state`, appending each new state to
 * `seen` so the caller can assert the order they arrived in.
 *
 * A real turn takes seconds and this looks every 150 ms, so an intermediate
 * state cannot realistically be missed; if one ever were, the order assertion
 * fails loudly rather than passing on a shorter sequence.
 */
async function awaitState(
  base,
  workspaceId,
  nodeId,
  state,
  seen,
  { session, give_up_on },
) {
  const deadline = Date.now() + 240_000;
  let last = [];
  while (Date.now() < deadline) {
    last = await call(base, "GET", `/api/workspaces/${workspaceId}/sessions`);
    const row = last.find((entry) => entry.nodeId === nodeId);
    if (row?.state && row.state !== seen.at(-1)) seen.push(row.state);
    if (row?.state === state) return row;
    if (give_up_on && seen.includes(give_up_on)) break;
    await sleep(150);
  }
  throw new Error(
    `${provider} never reported ${state} (saw ${seen.join(" → ") || "nothing"})\n` +
      `sessions: ${JSON.stringify(last)}\n` +
      `terminal:\n${await capture(base, session)}`,
  );
}

/** The pane's own output, so a failure says what the CLI actually printed. */
async function capture(base, session, lines = 40) {
  try {
    const snapshot = await call(
      base,
      "GET",
      `/api/terminals/${session.id}/capture?lines=${lines}&escapes=false`,
    );
    return snapshot.data ?? "";
  } catch (error) {
    return `(could not capture the pane: ${error.message})`;
  }
}

/**
 * Waits until the pane has stopped changing, then a moment longer.
 *
 * A TUI is ready when it has finished drawing itself, and the only signal
 * available from outside is that its output went quiet. Copilot's first run in
 * a fresh home also unpacks itself, which takes seconds, so this waits for
 * quiet rather than for a fixed delay or a prompt string that changes with
 * every release.
 */
async function settle(base, session) {
  const deadline = Date.now() + 120_000;
  let previous = null;
  let quietSince = null;
  while (Date.now() < deadline) {
    const now = await capture(base, session, 200);
    if (now !== previous) {
      previous = now;
      quietSince = null;
    } else if (quietSince === null) {
      quietSince = Date.now();
    } else if (Date.now() - quietSince >= 2_000 && now.trim() !== "") {
      return;
    }
    await sleep(400);
  }
  throw new Error(`${provider} never finished drawing its interface`);
}
