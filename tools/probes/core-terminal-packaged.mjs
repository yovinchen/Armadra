#!/usr/bin/env node
/**
 * Opens a terminal from inside the **packaged** application.
 *
 * This is the only one of R2's checks that cannot be done with `node
 * out/core/main.js`: what it proves is that `node-pty` loads from
 * `app.asar.unpacked` and that its `spawn-helper` — which `posix_spawn`
 * executes, and which therefore cannot live inside the archive — is reachable
 * from a signed bundle. A packaging mistake here is invisible in development
 * and total in a release.
 *
 * It drives the real renderer over CDP rather than talking to the core
 * directly, because the renderer is the caller whose origin the core's gate
 * actually judges. `window.armadra.transport.endpointsSync()` is how the page
 * itself learns the address, so the probe asks the same question the page
 * asks.
 *
 * The app is started the way Finder starts it: with launchd's PATH, which
 * has no Homebrew. A core that probes for tmux with the inherited PATH finds
 * nothing there and quietly falls back to `direct` — terminals then stop
 * surviving a restart, and nothing else looks wrong. So when tmux is installed
 * in one of the usual places, the session must come back as `tmux`.
 *
 * Chromium's profile goes to a temporary `--user-data-dir` too: without it the
 * second Electron writes into the operator's `~/Library/Application
 * Support/Armadra` next to the copy they have open.
 *
 * Usage (after `pnpm --filter @armadra/desktop dist`):
 *   node tools/probes/core-terminal-packaged.mjs
 *   node tools/probes/core-terminal-packaged.mjs --app <path to Armadra.app>
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");
const require = createRequire(join(repo, "apps/desktop/package.json"));
const { WebSocket } = require("ws");
const { DatabaseSync } = require("node:sqlite");

/**
 * The debugging port is chosen at run time, not fixed.
 *
 * A fixed one is a trap on a developer's machine: another Electron — a
 * development instance, another worktree's app — may already hold it, and this
 * probe would then attach to *that* renderer and report on somebody else's
 * core. It fails looking exactly like a packaging bug, which is the worst way
 * for it to look.
 */
async function freePort() {
  const { createServer } = await import("node:net");
  return await new Promise((done, fail) => {
    const server = createServer();
    server.on("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => done(port));
    });
  });
}

/** What launchd hands an app opened from Finder or the Dock. */
const LAUNCHD_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

/** tmux where a Mac usually has it — none of these is on LAUNCHD_PATH. */
function installedTmux() {
  return [
    "/opt/homebrew/bin/tmux",
    "/usr/local/bin/tmux",
    "/opt/local/bin/tmux",
  ].find((candidate) => existsSync(candidate));
}

const WORKSPACE = "00000000-0000-0000-0000-0000000000cc";

function defaultApp() {
  const release = join(repo, "apps/desktop/release");
  for (const name of ["mac-arm64", "mac"]) {
    const candidate = join(release, name, "Armadra.app");
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * The workspace row the terminal domain cannot create for itself: `POST
 * /api/workspaces` is R1's. Written before the app starts, so the core opens a
 * database that already has it.
 */
function seedWorkspace(dataDir) {
  const database = new DatabaseSync(join(dataDir, "canvas.db"));
  const columns = database
    .prepare("PRAGMA table_info(workspaces)")
    .all()
    .map((column) => column.name);
  const values = {
    id: WORKSPACE,
    name: "packaged",
    root_path: dataDir,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  const used = columns.filter((name) => name in values);
  database
    .prepare(
      `INSERT OR IGNORE INTO workspaces (${used.join(", ")}) VALUES (${used
        .map(() => "?")
        .join(", ")})`,
    )
    .run(...used.map((name) => values[name]));
  database.close();
}

/**
 * One CDP connection to the **application shell's** page.
 *
 * Not simply the first `page` target: an Armadra window can carry other pages
 * (a `<webview>`, an about:blank opener), and which one `/json/list` puts
 * first varies between runs. A `file://` page has the origin `null`, which the
 * core refuses exactly as the Rust face does — so attaching to the wrong
 * target reports a CORS refusal that reads like a product bug. The shell
 * serves its renderer over loopback HTTP, so that is what this matches.
 */
async function attachToRenderer(port) {
  let seen = [];
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      seen = targets.map((target) => `${target.type} ${target.url}`);
      const page = targets.find(
        (target) =>
          target.type === "page" &&
          target.webSocketDebuggerUrl &&
          /^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(target.url ?? ""),
      );
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      // The app is still starting.
    }
    await delay(500);
  }
  throw new Error(
    `no loopback renderer on the debugging port ${port}; saw ${JSON.stringify(seen)}`,
  );
}

function cdp(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  let nextId = 1;
  const ready = new Promise((done, fail) => {
    socket.once("open", done);
    socket.once("error", fail);
  });
  socket.on("message", (data) => {
    const message = JSON.parse(data.toString("utf8"));
    const waiter = pending.get(message.id);
    if (waiter === undefined) return;
    pending.delete(message.id);
    if (message.error) waiter.fail(new Error(JSON.stringify(message.error)));
    else waiter.done(message.result);
  });
  return {
    ready,
    send(method, params) {
      const id = nextId;
      nextId += 1;
      return new Promise((done, fail) => {
        pending.set(id, { done, fail });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close: () => socket.close(),
  };
}

/**
 * Evaluated inside the renderer: create a terminal, attach, type, wait for the
 * echo. Written as a string because it runs in the page, not here.
 */
const IN_PAGE = (workspace, cwd) => `(async () => {
  const bridge = globalThis.window?.armadra;
  if (!bridge?.transport) return { ok: false, reason: "no shell bridge on window.armadra" };
  const { httpBase, wsBase } = bridge.transport.endpointsSync();

  let created;
  try {
    created = await fetch(httpBase + "/api/terminals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: ${JSON.stringify(workspace)}, cwd: ${JSON.stringify(cwd)}, shell: "/bin/sh" }),
    });
  } catch (error) {
    return { ok: false, reason: "fetch threw: " + String(error), httpBase, wsBase, origin: location.origin };
  }
  const session = await created.json();
  if (!created.ok) return { ok: false, reason: "create failed", status: created.status, session, httpBase };

  const marker = "ARMADRA-PACKAGED-" + Date.now();
  return await new Promise((done) => {
    const socket = new WebSocket(wsBase + "/api/terminals/" + session.id + "/ws?writer=packaged");
    let hello = null;
    const timer = setTimeout(
      () => done({ ok: false, reason: "no echo within 30s", hello, httpBase }),
      30000,
    );
    socket.onmessage = (event) => {
      const frame = JSON.parse(event.data);
      if (frame.type === "hello") {
        hello = frame;
        socket.send(JSON.stringify({ type: "input", data: "echo " + marker + "\\r", inputId: 1 }));
        return;
      }
      if (frame.type === "output" && frame.data.includes(marker) && hello) {
        clearTimeout(timer);
        socket.close();
        // 资源采样另起一次 tmux list-panes，走的不是终端域那条路：打包版里它
        // 也得找得到 tmux，否则活着的会话在面板里没有进程号。
        (async () => {
          let row;
          for (let attempt = 0; attempt < 10 && !(row && row.pid); attempt += 1) {
            const sample = await (
              await fetch(httpBase + "/api/workspaces/" + ${JSON.stringify(workspace)} + "/resources")
            ).json();
            row = (sample.sessions ?? []).find((entry) => entry.sessionId === session.id);
            if (!(row && row.pid)) await new Promise((wait) => setTimeout(wait, 1000));
          }
          done({
            ok: true,
            hello,
            sessionId: session.id,
            backend: session.backend,
            httpBase,
            resourcePid: row?.pid ?? null,
            resourceReason: row?.unknownReason ?? null,
          });
        })().catch((error) => done({ ok: false, reason: "resources: " + String(error), httpBase }));
      }
    };
    socket.onerror = () => {
      clearTimeout(timer);
      done({ ok: false, reason: "socket error", httpBase });
    };
  });
})()`;

async function main() {
  const index = process.argv.indexOf("--app");
  const app = index === -1 ? defaultApp() : process.argv[index + 1];
  if (app === undefined || !existsSync(app)) {
    console.error(
      "no packaged app; run `pnpm --filter @armadra/desktop dist` first",
    );
    process.exit(1);
  }
  const binary = join(app, "Contents/MacOS/Armadra");
  const dataDir = mkdtempSync(join(tmpdir(), "armadra-packaged-"));
  const port = await freePort();

  // Started once with no window work to do, purely so the core creates and
  // migrates the database this probe then seeds. Simpler than teaching the
  // probe the migration ledger.
  const tmux = installedTmux();
  const first = spawn(
    binary,
    [
      `--remote-debugging-port=${port}`,
      "--remote-allow-origins=*",
      `--user-data-dir=${join(dataDir, "electron")}`,
    ],
    {
      env: {
        ...process.env,
        PATH: LAUNCHD_PATH,
        ARMADRA_DATA_DIR: dataDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let log = "";
  first.stdout.on("data", (chunk) => (log += chunk));
  first.stderr.on("data", (chunk) => (log += chunk));

  let outcome;
  try {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      if (existsSync(join(dataDir, "canvas.db"))) break;
      await delay(500);
    }
    if (!existsSync(join(dataDir, "canvas.db"))) {
      throw new Error(`the core never opened a database:\n${log}`);
    }
    // The page may already be up; the row has to exist before it asks.
    seedWorkspace(dataDir);

    const debuggerUrl = await attachToRenderer(port);
    const client = cdp(debuggerUrl);
    await client.ready;
    const result = await client.send("Runtime.evaluate", {
      expression: IN_PAGE(WORKSPACE, dataDir),
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    outcome =
      result.exceptionDetails === undefined
        ? result.result.value
        : {
            ok: false,
            reason: "the page threw",
            details: result.exceptionDetails,
            raw: result.result,
          };
    client.close();
    if (outcome?.ok) outcome.launchPath = LAUNCHD_PATH;
    if (outcome?.ok && outcome.backend === "tmux" && !outcome.resourcePid) {
      outcome = {
        ...outcome,
        ok: false,
        reason: `the resource sample has no pid for a live tmux session (${outcome.resourceReason})`,
      };
    }
    if (outcome?.ok && tmux !== undefined && outcome.backend !== "tmux") {
      outcome = {
        ...outcome,
        ok: false,
        reason: `tmux is installed at ${tmux} but the session came back as ${outcome.backend}`,
      };
    }
  } catch (error) {
    outcome = { ok: false, reason: String(error), log: log.slice(-4000) };
  } finally {
    first.kill("SIGTERM");
    await delay(2000);
    first.kill("SIGKILL");
    await killTmux(join(dataDir, "tmux.sock"));
    // A shell the core just killed may still hold the directory for a
    // moment (and on Windows an open handle refuses the delete outright):
    // retry, then leave it to the OS rather than turn a pass into a throw.
    try {
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 20 });
    } catch {
      // Left for the OS.
    }
  }

  console.log(JSON.stringify(outcome, null, 2));
  process.exit(outcome?.ok ? 0 : 1);
}

async function killTmux(socket) {
  if (!existsSync(socket)) return;
  await new Promise((done) => {
    const child = spawn("tmux", ["-S", socket, "kill-server"], {
      stdio: "ignore",
    });
    child.on("exit", done);
    child.on("error", done);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
