/**
 * The status channel of one real Agent CLI, end to end.
 *
 * Unit tests cover both halves apart: installers write the bytes they should,
 * normalizers turn a recorded payload into an `AgentEvent`. Neither answers the
 * question that decides whether the channel works — does *this* CLI, on *this*
 * machine, fire the events we subscribed, through the transport we generated,
 * with the node token and terminal binding of a session the runtime created?
 * (设计 docs/design/agent-collaboration-channels.md §5.2, 真实 CLI row.)
 *
 * For one provider it asserts: installing writes an adapter the CLI reads and
 * touches nothing else; a turn moves the node `working → done`; `stateSource`
 * names the channel that adapter really uses, on the event *and* on the
 * sessions list a reloaded client rebuilds from; Pi and Oh My Pi report a
 * measured context window rather than an estimate; and uninstalling removes
 * every file of ours and leaves every file that is not ours byte for byte.
 *
 * ## The user's own configuration is never touched
 *
 * The runtime resolves each CLI's config home from its own environment, but a
 * terminal child only inherits an allow-list of variables — `HOME` is on it,
 * `COPILOT_HOME` / `PI_CODING_AGENT_DIR` / `OMP_PROFILE` are not (see
 * `terminal/backend.rs::INHERITED_ENV`). Pointing the installer at a directory
 * the CLI would not read is worse than useless, so the redirection has to be
 * one both sides agree on: the runtime gets a **temporary `HOME`** and every
 * per-CLI override is cleared out of its environment. That home has no
 * credentials, so the files carrying them are **copied** out of the real config
 * home first (`seed`, read only, never written back), and on macOS
 * `~/Library/Keychains` is symlinked because `security` finds the login
 * keychain through `$HOME`. The real config home is never opened for writing,
 * so there is no backup/restore step to get wrong.
 *
 * ## Known result, 2026-09-06
 *
 * `pi`, `omp` and `copilot` pass; `opencode` cannot start on this machine.
 * Copilot passes with one caveat recorded in 协作通道 §6: its `sessionStart`
 * arrives *after* the first turn's `userPromptSubmitted`, and a session event
 * resets the node by design, so the `working` this script sees on the event
 * socket lives about 20 ms in the row a reloading client would read.
 *
 * Usage: node tools/agent-channel-smoke.mjs <armadra-runtime> <armadra-hook> <pi|omp|copilot|opencode>
 */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { request as httpRequest } from "node:http";
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
 * `seed` are home-relative paths carrying credentials and model selection —
 * enough for one turn, nothing about sessions, history or caches. A path that
 * does not exist is skipped, and the failure that follows names what happened.
 *
 * `deliver` is how the turn starts. `argv` puts the prompt on the command line,
 * which means the CLI exits when it is done — a dead terminal has no live
 * session, so those run through a wrapper that blocks on stdin afterwards.
 * `paste` runs the CLI's own interactive session and types into it through the
 * runtime's paste endpoint, which is what a canvas node does.
 *
 * `stateSource` lists the values correct for this provider. It is a list
 * because opencode is mid-migration: its plugin forks the client today (`hook`)
 * and moves in-process (`extension`) with B3, and this script has no business
 * deciding which the runtime it drives implements. It prints what it saw.
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
    // Interactive, because with `-p` Copilot's `sessionEnd` follows `agentStop`
    // by ~10 ms and the run ends with no state at all rather than the `done` a
    // user would see. A canvas node runs the CLI's own session and types into
    // it, which is what this does.
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
    // and a modal waiting for a keypress swallows the pasted prompt.
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

/** Cheap, and specific enough that a wrong answer would be obvious. */
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

// Absolute: these go into a config file the CLI runs from its own working
// directory, where a `target/debug/…` entry resolves elsewhere and never fires.
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
  const lines = (text ?? "").split("\n").map((line) => line.trim());
  return lines.find((line) => line !== "") ?? "";
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

// See `deliver` on the provider table for why only one of the two is wrapped.
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

  // Everything the seeding put there, before the installer touches it.
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
  // Installing adds our own files and touches nothing else. Checked here,
  // before the CLI runs, because afterwards the CLI has rewritten its own.
  unchanged(before, configHome, "install");
  console.log(`installed ${install.configPath}`);

  const { workspaceId, nodeId } = await createBoard(base);
  // Opened before the terminal, so no frame can be missed.
  const stream = await watchStatus(base, workspaceId, nodeId);
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
    // Bracketed paste plus Enter, through the endpoint the canvas uses.
    await call(base, "POST", `/api/terminals/${session.id}/paste`, {
      text: PROMPT,
      enter: true,
    });
  }

  // Written by the CLI's own adapter, over the runtime's socket, with the node
  // token that terminal was issued.
  const done = await stream.await("done", { base, session });
  assert.deepEqual(
    stream.states,
    ["working", "done"],
    `the node did not go working → done; it went ${stream.states.join(" → ") || "nowhere"}`,
  );
  assert.ok(
    definition.stateSource.includes(done.stateSource),
    `stateSource was ${done.stateSource ?? "(none)"}, expected one of ${definition.stateSource.join(" / ")}`,
  );
  console.log(`working → done — stateSource=${done.stateSource}`);

  // The same source on the sessions list, which is what a reloaded client
  // rebuilds the node header from.
  const summary = (
    await call(base, "GET", `/api/workspaces/${workspaceId}/sessions`)
  ).find((row) => row.nodeId === nodeId);
  assert.equal(
    summary?.stateSource,
    done.stateSource,
    "the sessions list disagreed with the event about the state source",
  );

  if (definition.contextUsage) {
    // A measured window, not a sum: `estimate` is how the UI tells them apart.
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

  stream.close();
  // Taken now rather than before the install: a CLI rewrites its own config as
  // it runs — Copilot records the folder it trusted, the tab it showed — and
  // the question here is only what *uninstall* changed.
  const settled = digestTree(configHome);
  const ours = new Set([
    ...markedFiles(configHome),
    relative(configHome, install.configPath),
  ]);

  const removed = await call(
    base,
    "POST",
    `/api/agents/${provider}/hooks/uninstall`,
    {},
  );
  assert.equal(removed.installed, false);
  for (const [path, digest] of settled) {
    if (ours.has(path)) {
      assert.ok(
        !existsSync(join(configHome, path)),
        `uninstall left ${path} behind`,
      );
      continue;
    }
    assert.equal(
      digestFile(join(configHome, path)),
      digest,
      `uninstall changed ${path}, which is not ours`,
    );
  }
  const leftovers = markedFiles(configHome);
  assert.deepEqual(leftovers, [], `uninstall left our own files: ${leftovers}`);
  console.log(
    `uninstalled — removed ${ours.size}, left ${settled.size - ours.size} untouched`,
  );
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

/** Copies `seed` into the temporary home. Read only; a missing file is skipped. */
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

/** `HOME` is left as the only thing deciding where the adapter goes. */
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

/** Relative path → digest for every regular file under `root`. */
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

/** Asserts every file in `snapshot` still has the bytes it had. */
function unchanged(snapshot, root, what) {
  for (const [path, digest] of snapshot) {
    assert.equal(
      digestFile(join(root, path)),
      digest,
      `${what} changed ${path}`,
    );
  }
}

/**
 * Files still carrying our marker — the installers' own recognition rule
 * (`armadra-hook` appears in the file) asked from outside. Databases, logs and
 * session directories are the CLI's own and are skipped.
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
 * Records every `agent.status` frame for one node off the workspace event
 * socket — the stream the canvas listens to. It has to be the socket: a turn
 * can be over in well under a second and a poll samples, so it would miss
 * `working` and report "the node never said it was running", the one
 * conclusion this script must not reach by accident. The handshake is
 * hand-written because the runtime requires an `Origin`
 * (`api/support.rs::validate_websocket_origin`) and the platform's `WebSocket`
 * cannot set one; only unmasked server text frames are handled.
 */
async function watchStatus(base, workspaceId, nodeId) {
  const url = new URL(`${base}/api/workspaces/${workspaceId}/events`);
  const states = [];
  const frames = [];
  const socket = await new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
        "Sec-WebSocket-Version": "13",
        Origin: `http://${url.host}`,
      },
    });
    request.on("upgrade", (_response, upgraded) => resolve(upgraded));
    request.on("response", (response) =>
      reject(new Error(`the event socket answered ${response.statusCode}`)),
    );
    request.on("error", reject);
    request.end();
  });

  let buffer = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const frame = readFrame(buffer);
      if (!frame) return;
      buffer = frame.rest;
      if (frame.opcode !== 1) continue;
      let event;
      try {
        event = JSON.parse(frame.text);
      } catch {
        continue;
      }
      if (event.type !== "agent.status" || event.status?.nodeId !== nodeId) {
        continue;
      }
      frames.push(event.status);
      if (event.status.state && event.status.state !== states.at(-1)) {
        states.push(event.status.state);
      }
    }
  });
  socket.on("error", () => undefined);

  return {
    states,
    close: () => socket.destroy(),
    /** Resolves with the frame that first reported `state`. */
    async await(state, { base: endpoint, session }) {
      const deadline = Date.now() + 240_000;
      while (Date.now() < deadline) {
        const frame = frames.find((status) => status.state === state);
        if (frame) return frame;
        await sleep(100);
      }
      throw new Error(
        `${provider} never reported ${state} (saw ${states.join(" → ") || "nothing"})\n` +
          `terminal:\n${await capture(endpoint, session)}`,
      );
    },
  };
}

/**
 * One WebSocket frame, or null when the buffer holds less than a whole one.
 * Server frames are never masked and the runtime never fragments a message.
 */
function readFrame(buffer) {
  if (buffer.length < 2) return null;
  const opcode = buffer[0] & 0x0f;
  let length = buffer[1] & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return null;
    length = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }
  if (buffer.length < offset + length) return null;
  return {
    opcode,
    text: buffer.toString("utf8", offset, offset + length),
    rest: buffer.subarray(offset + length),
  };
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
 * Waits until the pane stops changing: a TUI is ready when it has finished
 * drawing, and going quiet is the only sign of that from outside. Copilot's
 * first run in a fresh home unpacks itself, so this waits for quiet rather than
 * a fixed delay or a prompt string that changes with every release.
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
