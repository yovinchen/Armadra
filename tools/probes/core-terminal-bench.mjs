#!/usr/bin/env node
/**
 * The three measurements R2's vertical slice exists to make (design
 * `docs/design/typescript-core.md` §10).
 *
 * Every one of them is a comparison, not an absolute: the question is never
 * "is Node fast enough", it is "does moving this domain from Rust to
 * TypeScript cost more than the budget the design wrote down". So both
 * implementations are started on the same machine, in the same minute, driven
 * by the same client, through the same tmux binary.
 *
 *   1. **Throughput** — 200 MB out of one pane, timed from a WebSocket client
 *      to the last byte. Budget: within 20% of the Rust Runtime.
 *   2. **Interference** — the same run, with 200 HTTP requests fired at the
 *      core throughout, against a quiet baseline of the same 200. Budget: P95
 *      no worse than 1.5x the quiet one. This is the single-event-loop
 *      question, and it is the one a language change can lose outright.
 *   3. **Packaging** — checked by `--packaging`, which only inspects a `dist`
 *      that has already been built (it does not build one): the `.node` addon
 *      has to be outside the asar, where `posix_spawn` can reach the
 *      `spawn-helper` next to it.
 *
 * Usage:
 *   node tools/probes/core-terminal-bench.mjs              # 1 and 2, both sides
 *   node tools/probes/core-terminal-bench.mjs --only ts
 *   node tools/probes/core-terminal-bench.mjs --megabytes 50
 *   node tools/probes/core-terminal-bench.mjs --packaging
 */
import { spawn } from "node:child_process";
import { Agent, request as httpRequest } from "node:http";
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readdirSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
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

const CORE_ENTRY = join(repo, "apps/desktop/out/core/main.js");
const RUST_BINARY = join(repo, "target/debug/armadra-runtime");
const WORKSPACE = "00000000-0000-0000-0000-0000000000bb";

/* --------------------------------- harness -------------------------------- */

const IMPLEMENTATIONS = {
  ts: {
    label: "TypeScript core",
    entry: () => CORE_ENTRY,
    missing: () =>
      existsSync(CORE_ENTRY)
        ? undefined
        : `${CORE_ENTRY} is not built; run \`pnpm --filter @armadra/desktop build\``,
    spawn: (dataDir, port) =>
      spawn(
        process.execPath,
        [
          CORE_ENTRY,
          "--listen",
          `tcp:127.0.0.1:${port}`,
          "--data-dir",
          dataDir,
        ],
        { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env } },
      ),
    // `Armadra core is listening {"spec":"tcp:127.0.0.1:1234"}`
    address: /Armadra core is listening .*"spec":"tcp:([^"]+)"/,
  },
  rust: {
    label: "Rust Runtime",
    entry: () => RUST_BINARY,
    missing: () =>
      existsSync(RUST_BINARY)
        ? undefined
        : `${RUST_BINARY} is not built; run \`cargo build -p armadra-runtime\``,
    spawn: (dataDir, port) =>
      spawn(RUST_BINARY, ["--listen", `tcp:127.0.0.1:${port}`], {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ARMADRA_DATA_DIR: dataDir },
      }),
    // `Armadra Runtime is listening spec=tcp:127.0.0.1:1234`, with the
    // tracing formatter's ANSI escapes in between — hence the lazy gap rather
    // than a literal `spec=`.
    address: /Armadra Runtime is listening[\s\S]{0,80}?tcp:(127\.0\.0\.1:\d+)/,
  },
};

async function start(name, dataDir) {
  const implementation = IMPLEMENTATIONS[name];
  const child = implementation.spawn(dataDir, 0);
  let log = "";
  const watch = (stream) => {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      log += chunk;
    });
  };
  watch(child.stdout);
  watch(child.stderr);
  const address = await new Promise((done, fail) => {
    const timer = setTimeout(
      () => fail(new Error(`${name} did not announce an address:\n${log}`)),
      30_000,
    );
    const poll = setInterval(() => {
      const found = implementation.address.exec(log);
      if (found) {
        clearTimeout(timer);
        clearInterval(poll);
        done(found[1] ?? found[2]);
      }
    }, 25);
    child.on("exit", (code) => {
      clearTimeout(timer);
      clearInterval(poll);
      fail(new Error(`${name} exited with ${code}:\n${log}`));
    });
  });
  return {
    child,
    base: `http://${address}`,
    ws: `ws://${address}`,
    log: () => log,
    async stop() {
      child.kill("SIGTERM");
      await Promise.race([
        new Promise((done) => child.once("exit", done)),
        delay(5_000).then(() => child.kill("SIGKILL")),
      ]);
    },
  };
}

/**
 * The one row the terminal domain cannot create for itself: `POST
 * /api/workspaces` is R1's, and `terminal_sessions.workspace_id` is a foreign
 * key. Written directly, and only by this probe.
 */
function seedWorkspace(dataDir) {
  const database = new DatabaseSync(join(dataDir, "canvas.db"));
  const columns = database
    .prepare("PRAGMA table_info(workspaces)")
    .all()
    .map((column) => column.name);
  const values = {
    id: WORKSPACE,
    name: "bench",
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

/* ------------------------------- measurement ------------------------------ */

export function percentile(samples, fraction) {
  if (samples.length === 0) return Number.NaN;
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.ceil(fraction * sorted.length) - 1,
  );
  return sorted[Math.max(0, index)];
}

/**
 * One request, timed, over `node:http`.
 *
 * **Not `fetch`.** Measured on this machine against this very core: `fetch`
 * reports a flat ~494 ms per request where `curl` and `node:http` both report
 * ~1.1 ms for the same route on the same process. Whatever undici is waiting
 * for, it is not the server, and a benchmark whose baseline is 450x the
 * quantity it is measuring cannot answer the question it was written for.
 */
const agent = new Agent({ keepAlive: true, maxSockets: 8 });

function timedRequest(base, path, { method = "GET", body } = {}) {
  const url = new URL(path, base);
  return new Promise((done, fail) => {
    const started = performance.now();
    const request = httpRequest(
      {
        agent,
        host: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        headers:
          body === undefined
            ? {}
            : {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(body),
              },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () =>
          done({
            status: response.statusCode,
            milliseconds: performance.now() - started,
            text: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    request.on("error", fail);
    if (body !== undefined) request.write(body);
    request.end();
  });
}

/**
 * Fires `count` requests and returns every latency in milliseconds.
 *
 * Two routes on purpose: `/health` is answered from memory and measures the
 * event loop alone, and an unclaimed path measures the router — so a
 * regression in either is visible separately.
 */
async function probeHttp(base, count, stopAt) {
  const samples = [];
  const paths = ["/health", "/api/terminals/backend"];
  // Warm-up, discarded: the first requests to a fresh process pay for the TCP
  // connect, and counting those would put the noise in the baseline rather
  // than out of it.
  for (let index = 0; index < 10; index += 1) {
    await timedRequest(base, "/health").catch(() => undefined);
  }
  for (let index = 0; index < count; index += 1) {
    if (stopAt !== undefined && Date.now() > stopAt) break;
    try {
      const result = await timedRequest(base, paths[index % paths.length]);
      samples.push(result.milliseconds);
    } catch {
      continue;
    }
    await delay(5);
  }
  return samples;
}

/** A file of `megabytes` MB of printable lines, made once and reused. */
function payloadFile(megabytes) {
  const path = join(tmpdir(), `armadra-bench-${megabytes}mb.txt`);
  const wanted = megabytes * 1024 * 1024;
  if (existsSync(path) && statSync(path).size >= wanted) return path;
  // 80 columns and a newline: a shape a terminal actually renders, rather
  // than one enormous line that would measure tmux's wrapping instead.
  const line = `${"armadra-benchmark-payload-".repeat(3)}`.slice(0, 79) + "\n";
  const block = Buffer.from(line.repeat(1024), "utf8");
  const handle = openSync(path, "w");
  try {
    for (let written = 0; written < wanted; written += block.byteLength) {
      writeSync(handle, block);
    }
  } finally {
    closeSync(handle);
  }
  return path;
}

async function measure(name, { megabytes, httpRequests }) {
  const implementation = IMPLEMENTATIONS[name];
  const missing = implementation.missing();
  if (missing !== undefined) return { name, skipped: missing };

  const dataDir = mkdtempSync(join(tmpdir(), `armadra-bench-${name}-`));
  const server = await start(name, dataDir);
  try {
    // Anything that throws below is nearly always the server having died, and
    // the only useful thing to say about that is what it printed.

    seedWorkspace(dataDir);

    // The quiet baseline first: the same requests, with no pane producing
    // anything, on the same process that is about to be busy.
    const idle = await probeHttp(server.base, httpRequests);

    const created = await timedRequest(server.base, "/api/terminals", {
      method: "POST",
      body: JSON.stringify({
        workspaceId: WORKSPACE,
        cwd: dataDir,
        shell: "/bin/sh",
      }),
    });
    if (created.status !== 200) {
      throw new Error(`${name} could not create a terminal: ${created.text}`);
    }
    const session = JSON.parse(created.text);

    const socket = new WebSocket(
      `${server.ws}/api/terminals/${session.id}/ws?writer=bench`,
      { origin: "http://127.0.0.1:1420" },
    );
    let bytes = 0;
    let sightings = 0;
    let started = 0;
    let finished = 0;
    const marker = `ARMADRA-BENCH-DONE-${Date.now()}`;
    const done = new Promise((resolveRun, rejectRun) => {
      const timer = setTimeout(
        () => rejectRun(new Error(`${name} did not finish within the budget`)),
        300_000,
      );
      socket.on("message", (data) => {
        const frame = JSON.parse(data.toString("utf8"));
        if (frame.type === "hello") {
          started = performance.now();
          socket.send(
            JSON.stringify({
              type: "input",
              data: `cat ${payloadFile(megabytes)}; echo ${marker}\r`,
            }),
          );
          return;
        }
        if (frame.type !== "output") return;
        bytes += Buffer.byteLength(frame.data, "utf8");
        // The marker is echoed by the shell as the command is typed, so the
        // first sighting is the prompt and the SECOND is the command having
        // finished. Counting sightings is also why the marker may not be
        // split across frames — it is short and arrives whole.
        if (frame.data.includes(marker)) {
          sightings += 1;
          if (sightings >= 2) {
            finished = performance.now();
            clearTimeout(timer);
            resolveRun();
          }
        }
      });
      socket.on("error", rejectRun);
    });

    const busy = await Promise.all([
      done.then(() => undefined),
      probeHttp(server.base, httpRequests, Date.now() + 300_000),
    ]).then(([, samples]) => samples);

    socket.close();
    await timedRequest(server.base, `/api/terminals/${session.id}/terminate`, {
      method: "POST",
      body: JSON.stringify({ mode: "session" }),
    }).catch(() => undefined);

    const seconds = (finished - started) / 1000;
    return {
      name,
      label: implementation.label,
      seconds: Number(seconds.toFixed(3)),
      // What the SOCKET received, which is not the payload: tmux renders a
      // screen rather than forwarding every byte, so a 200 MB `cat` reaches
      // the client as a few MB of screen updates. The comparable number is
      // `seconds` — the same work, the same tmux, two transports.
      socketMegabytes: Number((bytes / 1024 / 1024).toFixed(1)),
      payloadMegabytesPerSecond: Number((megabytes / seconds).toFixed(1)),
      idleP50: Number(percentile(idle, 0.5).toFixed(2)),
      idleP95: Number(percentile(idle, 0.95).toFixed(2)),
      idleMax: Number(Math.max(...idle).toFixed(2)),
      busyP50: Number(percentile(busy, 0.5).toFixed(2)),
      busyP95: Number(percentile(busy, 0.95).toFixed(2)),
      busyMax: Number(Math.max(...busy).toFixed(2)),
      idleSamples: idle.length,
      busySamples: busy.length,
    };
  } catch (failure) {
    throw new Error(
      `${name}: ${failure.message}\n--- server log ---\n${server.log()}`,
    );
  } finally {
    await server.stop();
    // tmux outlives the process that started it — that is the whole point of
    // the backend — so the server on this private socket is killed by hand.
    await killTmux(join(dataDir, "tmux.sock"));
    rmSync(dataDir, { recursive: true, force: true });
  }
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

/* -------------------------------- packaging ------------------------------- */

/**
 * Inspects an existing `release/` tree. It does not build one: a `dist` takes
 * twenty minutes and signs things, and a probe that triggered it by accident
 * would be a probe nobody runs.
 */
export function packagingReport(
  releaseDir = join(repo, "apps/desktop/release"),
) {
  if (!existsSync(releaseDir)) {
    return {
      ok: false,
      reason: `${releaseDir} does not exist; run \`pnpm --filter @armadra/desktop dist\``,
    };
  }
  const apps = readdirSync(releaseDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("mac"))
    .map((entry) => join(releaseDir, entry.name, "Armadra.app"))
    .filter(existsSync);
  if (apps.length === 0) {
    return { ok: false, reason: `no Armadra.app under ${releaseDir}` };
  }
  const findings = apps.map((app) => {
    const unpacked = join(
      app,
      "Contents/Resources/app.asar.unpacked/node_modules/node-pty",
    );
    const addon = join(unpacked, "build/Release/pty.node");
    const helper = join(unpacked, "build/Release/spawn-helper");
    return {
      app,
      unpackedDirectory: existsSync(unpacked),
      addon: existsSync(addon),
      // `posix_spawn` cannot execute a file inside the archive, so the helper
      // has to be a real executable on disk next to the addon.
      spawnHelper: existsSync(helper),
      helperExecutable: existsSync(helper)
        ? (statSync(helper).mode & 0o111) !== 0
        : false,
    };
  });
  return {
    ok: findings.every(
      (finding) =>
        finding.unpackedDirectory &&
        finding.addon &&
        finding.spawnHelper &&
        finding.helperExecutable,
    ),
    findings,
  };
}

/* ---------------------------------- main ---------------------------------- */

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

async function main() {
  if (process.argv.includes("--packaging")) {
    const report = packagingReport();
    console.log(JSON.stringify(report, null, 2));
    process.exit(report.ok ? 0 : 1);
  }

  const megabytes = Number(argument("--megabytes", "200"));
  const httpRequests = Number(argument("--requests", "200"));
  const only = argument("--only", undefined);
  const names = only ? [only] : ["rust", "ts"];

  const results = [];
  for (const name of names) {
    process.stderr.write(`measuring ${name}…\n`);
    results.push(await measure(name, { megabytes, httpRequests }));
  }

  const rust = results.find(
    (result) => result.name === "rust" && !result.skipped,
  );
  const ts = results.find((result) => result.name === "ts" && !result.skipped);
  const verdict = {};
  if (rust && ts) {
    // Signed: negative means the TypeScript core finished sooner. The budget
    // is one-sided on purpose — being faster than the implementation you are
    // replacing has never been a reason to stop.
    verdict.throughputDeltaPercent = Number(
      (((ts.seconds - rust.seconds) / rust.seconds) * 100).toFixed(1),
    );
    verdict.throughputWithinBudget = verdict.throughputDeltaPercent < 20;
  }
  for (const result of [rust, ts]) {
    if (!result) continue;
    const ratio = result.busyP95 / result.idleP95;
    verdict[`${result.name}P95Ratio`] = Number(ratio.toFixed(2));
    verdict[`${result.name}InterferenceWithinBudget`] = ratio < 1.5;
  }

  console.log(
    JSON.stringify({ megabytes, httpRequests, results, verdict }, null, 2),
  );
  const failed =
    verdict.throughputWithinBudget === false ||
    verdict.tsInterferenceWithinBudget === false;
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
