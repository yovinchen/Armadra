// End-to-end check for a business domain's write-ownership switch, one domain
// at a time (Go Host 业务所有权迁移 §5.2, §6.2).
//
// `--domain settings` is the only scenario implemented so far. The canvas
// domain keeps its own, older and much wider script (`pnpm canvas:e2e`), which
// also drives a real browser; this one is Node-only and proves the parts a
// second domain adds: the dependency order between domains, a document that
// never travelled in a migration bundle, and a rollback whose reverse import
// goes over the Worker's own settings frame instead of a package the Runtime
// reads from disk.
//
// Everything it talks to is local and temporary: a self-signed certificate, a
// real Rust Runtime on a kernel-assigned loopback port with its own data
// directory, a real Go Host on an ephemeral TLS port with a throwaway data
// directory, and an HTTPS origin that proxies /rpc and /ws to the Host so the
// browser session transport sees one origin. Nothing reaches the operator's own
// data directory or the ports the application reserves (1420, 1421, 43120,
// 43121).
//
// What it covers, in order:
//
//   - settings written through the Runtime, digested from the file on disk;
//   - a settings switch attempted before the canvas has settled on the Host,
//     which must be refused by dependency order rather than half-performed;
//   - the offline CLI switch, whose consistency checks compare the Host's
//     projection against the document the Worker exported;
//   - the Runtime refusing settings writes afterwards while still answering
//     reads, which is what makes the switch reversible;
//   - the Host serving the same document, digest for digest, over HTTPS;
//   - a save through the Host, its receipt, its revision, and the event a
//     second client receives on the shared stream within a second;
//   - a stale-revision save refused as a conflict;
//   - the HTTPS rollback: the reverse export, the Runtime applying it over the
//     Worker frame, the Runtime's own re-read compared with the package, and
//     the Host-era change showing up in the Runtime's settings afterwards.
//
// Every step is proved by a digest, a revision or a sequence rather than by the
// absence of an exception.
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  createServer as createHttpServer,
  request as httpRequest,
} from "node:http";
import { createServer, request as httpsRequest } from "node:https";
import { connect as tlsConnect } from "node:tls";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { openDriver } from "./canvas-ownership-driver.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

const domain = (() => {
  const index = process.argv.indexOf("--domain");
  const named = index >= 0 ? process.argv[index + 1] : "settings";
  if (named === "settings") return named;
  if (named === "canvas") {
    console.error(
      "The canvas domain has its own end-to-end check: pnpm canvas:e2e",
    );
    process.exit(2);
  }
  console.error(
    `No end-to-end scenario exists for --domain ${named} yet; only settings is implemented.`,
  );
  process.exit(2);
})();

const workspace = mkdtempSync(join(tmpdir(), "armadra-ownership-e2e-"));
const cleanups = [];
const results = [];
let failures = 0;

function step(name, ok, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures += 1;
  const mark = ok ? "  ok  " : " FAIL ";
  console.log(`${mark}${name}${detail ? `  — ${detail}` : ""}`);
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 << 20,
    ...options,
  });
}

/** Runs a command that is expected to fail, so the refusal can be asserted. */
function tryRun(command, args, options = {}) {
  try {
    return { ok: true, output: run(command, args, options) };
  } catch (error) {
    return {
      ok: false,
      output: `${error.stdout ?? ""}${error.stderr ?? ""}`,
      status: error.status,
    };
  }
}

function pnpm(args) {
  if (/\.(?:c|m)?js$/i.test(process.env.npm_execpath ?? "")) {
    return run(process.execPath, [process.env.npm_execpath, ...args], {
      stdio: "inherit",
    });
  }
  return run(process.platform === "win32" ? "pnpm.exe" : "pnpm", args, {
    stdio: "inherit",
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

let cleaned = false;
function teardown() {
  if (!cleaned) {
    cleaned = true;
    for (const cleanup of cleanups.reverse()) {
      try {
        cleanup();
      } catch {}
    }
  }
  try {
    rmSync(workspace, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 100,
    });
  } catch {
    console.error(`  note  temporary directory left behind: ${workspace}`);
  }
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
  process.on(signal, () => {
    teardown();
    process.exit(130);
  });

/** A port nothing is listening on right now, never one the app reserves. */
async function freePort() {
  const probe = createHttpServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  if ([1420, 1421, 43120, 43121].includes(port)) return freePort();
  return port;
}

/* ------------------------------------------------------------- certificate */

const tlsDirectory = join(workspace, "tls");
mkdirSync(tlsDirectory, { recursive: true });
const certFile = join(tlsDirectory, "cert.pem");
const keyFile = join(tlsDirectory, "key.pem");
run("openssl", [
  "req",
  "-x509",
  "-newkey",
  "rsa:2048",
  "-nodes",
  "-keyout",
  keyFile,
  "-out",
  certFile,
  "-days",
  "1",
  "-subj",
  "/CN=localhost",
  "-addext",
  "subjectAltName=DNS:localhost,IP:127.0.0.1",
]);
const credentials = {
  cert: readFileSync(certFile),
  key: readFileSync(keyFile),
};

/* ---------------------------------------------------- app origin and proxy */

const appPort = await freePort();
const hostPort = await freePort();
const appOrigin = `https://localhost:${appPort}`;

// The proxy exists because the browser session transport requires the page and
// the Host to share an origin: cookies scoped to one origin are the point. The
// Host header is forwarded unchanged so the Host still sees its own public
// origin; rewriting it would defeat the check being exercised.
const appServer = createServer(credentials, (req, res) => {
  const url = new URL(req.url, appOrigin);
  const proxied = httpsRequest(
    {
      host: "127.0.0.1",
      port: hostPort,
      method: req.method,
      path: url.pathname + url.search,
      headers: req.headers,
      rejectUnauthorized: false,
      servername: "localhost",
    },
    (upstream) => {
      res.writeHead(upstream.statusCode ?? 502, upstream.headers);
      upstream.pipe(res);
    },
  );
  proxied.on("error", () => res.writeHead(502).end());
  req.pipe(proxied);
});

/* ------------------------------------------------------------- the Runtime */

const runtimeBinary = join(
  root,
  "target",
  "debug",
  process.platform === "win32" ? "armadra-runtime.exe" : "armadra-runtime",
);
const runtimeData = join(workspace, "runtime");
const runtimeRoot = join(workspace, "project");
const runtimeDatabase = join(runtimeData, "canvas.db");
const runtimeSettings = join(runtimeData, "settings.json");
mkdirSync(runtimeData, { recursive: true });
mkdirSync(runtimeRoot, { recursive: true });
const runtimeEnv = {
  ...process.env,
  ARMADRA_DATA_DIR: runtimeData,
  ARMADRA_DATABASE_URL: `sqlite://${runtimeDatabase}?mode=rwc`,
  RUST_LOG: process.env.RUST_LOG ?? "warn",
};
const endpointsFile = join(runtimeData, "endpoints.json");

let runtime = null;
let runtimeOrigin = "";
let runtimeDiagnostics = "";

async function startRuntime() {
  rmSync(endpointsFile, { force: true });
  const child = spawn(runtimeBinary, ["--listen", "tcp:127.0.0.1:0"], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: runtimeEnv,
  });
  runtime = child;
  child.stdout.on("data", () => {});
  child.stderr.on("data", (chunk) => {
    runtimeDiagnostics = (runtimeDiagnostics + chunk).slice(-4096);
  });
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (child.exitCode !== null) return false;
    let published = "";
    try {
      published = JSON.parse(readFileSync(endpointsFile, "utf8"))?.runtime
        ?.http;
    } catch {}
    if (published) {
      runtimeOrigin = published;
      const health = await runtimeCall("GET", "/api/health").catch(() => null);
      if (health?.status === 200) return true;
    }
    await sleep(100);
  }
  return false;
}

async function stopRuntime() {
  const child = runtime;
  runtime = null;
  runtimeOrigin = "";
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), sleep(15_000)]);
  if (child.exitCode === null) {
    child.kill("SIGKILL");
    await Promise.race([once(child, "exit"), sleep(2_000)]);
  }
}
cleanups.push(() => runtime?.kill("SIGKILL"));

function runtimeCall(method, path, body) {
  const url = new URL(path, runtimeOrigin);
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: url.hostname,
        port: url.port,
        method,
        path: url.pathname + url.search,
        headers: payload ? { "Content-Type": "application/json" } : {},
        timeout: 30_000,
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json;
          try {
            json = JSON.parse(text);
          } catch {}
          resolve({ status: response.statusCode ?? 0, json, text });
        });
      },
    );
    request.on("error", reject);
    request.on("timeout", () => request.destroy(new Error("timed out")));
    if (payload) request.write(payload);
    request.end();
  });
}

/* ---------------------------------------------------------------- the Host */

const hostBinary = join(
  root,
  "target",
  process.platform === "win32" ? "armadra-host.exe" : "armadra-host",
);
const hostData = join(workspace, "host");
const hostEnv = { ...process.env, ARMADRA_GITHUB_SECRET_STORE: "file" };
let host = null;
let hostDiagnostics = "";

async function startHost() {
  const child = spawn(
    hostBinary,
    [
      "serve",
      "--listen",
      `127.0.0.1:${hostPort}`,
      "--data-dir",
      hostData,
      "--tls-cert",
      certFile,
      "--tls-key",
      keyFile,
      "--public-origin",
      appOrigin,
      // Naming the Runtime executable, its database and its settings file is
      // what makes a switch over HTTPS possible at all: without them the Host
      // answers the record and refuses to move it, because it has no way to
      // tell the Runtime.
      "--runtime-binary",
      runtimeBinary,
      "--runtime-database",
      runtimeDatabase,
      "--runtime-settings",
      runtimeSettings,
    ],
    { cwd: root, stdio: ["ignore", "pipe", "pipe"], env: hostEnv },
  );
  host = child;
  child.stdout.on("data", () => {});
  child.stderr.on("data", (chunk) => {
    hostDiagnostics = (hostDiagnostics + chunk).slice(-4096);
  });
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (child.exitCode !== null) return false;
    const reachable = await new Promise((resolve) => {
      const probe = httpsRequest(
        {
          host: "127.0.0.1",
          port: hostPort,
          path: "/health",
          method: "GET",
          rejectUnauthorized: false,
          servername: "localhost",
          headers: { Host: `localhost:${appPort}` },
        },
        (response) => {
          response.resume();
          resolve(response.statusCode === 200);
        },
      );
      probe.on("error", () => resolve(false));
      probe.end();
    });
    if (reachable) return true;
    await sleep(100);
  }
  return false;
}

/**
 * Stops the Host completely. The offline ownership commands take the same data
 * directory lock a serving Host holds, so "stopped" has to mean the process is
 * gone, not merely signalled.
 */
async function stopHost() {
  const child = host;
  host = null;
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), sleep(15_000)]);
  if (child.exitCode === null) {
    try {
      run(hostBinary, ["stop", "--data-dir", hostData], { env: hostEnv });
    } catch {}
    await Promise.race([once(child, "exit"), sleep(5_000)]);
  }
  if (child.exitCode === null) {
    child.kill("SIGKILL");
    await Promise.race([once(child, "exit"), sleep(2_000)]);
  }
}
cleanups.push(() => host?.kill("SIGKILL"));

function ownershipCli(action, extra = []) {
  return run(
    hostBinary,
    ["ownership", action, "--data-dir", hostData, "--output", "json", ...extra],
    { env: hostEnv },
  );
}

/** The Runtime binary and database every non-read ownership command needs. */
const runtimeTarget = [
  "--runtime-binary",
  runtimeBinary,
  "--runtime-database",
  runtimeDatabase,
  "--runtime-settings",
  runtimeSettings,
];

/* ------------------------------------------------------- browser transport */

/**
 * A cookie jar and an HTTPS transport that behave like the browser's own: the
 * Host still sees its public origin, still enforces the exact Origin, and still
 * hands out `__Host-` cookies that only travel back to that origin.
 */
function nodeTransport(jar) {
  return async (url, init = {}) => {
    const target = new URL(url);
    const headers = { ...(init.headers ?? {}), Origin: appOrigin };
    if (jar.size)
      headers.Cookie = [...jar]
        .map(([name, value]) => `${name}=${value}`)
        .join("; ");
    return new Promise((resolve, reject) => {
      const request = httpsRequest(
        {
          host: target.hostname,
          port: target.port,
          method: init.method ?? "GET",
          path: target.pathname + target.search,
          headers,
          ca: credentials.cert,
          servername: "localhost",
        },
        (response) => {
          const chunks = [];
          response.on("data", (chunk) => chunks.push(chunk));
          response.on("end", () => {
            for (const raw of response.headers["set-cookie"] ?? []) {
              const pair = raw.split(";", 1)[0];
              const split = pair.indexOf("=");
              jar.set(
                pair.slice(0, split).trim(),
                pair.slice(split + 1).trim(),
              );
            }
            resolve(
              new Response(Buffer.concat(chunks), {
                status: response.statusCode ?? 502,
                headers: {
                  "content-type":
                    response.headers["content-type"] ??
                    "application/octet-stream",
                },
              }),
            );
          });
        },
      );
      request.on("error", reject);
      if (init.body) request.write(Buffer.from(init.body));
      request.end();
    });
  };
}

/* ------------------------------------------------------------- the stream */

const streamGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** One masked client frame. Server frames are never masked; client ones must be. */
function writeStreamFrame(socket, opcode, payload) {
  const mask = randomBytes(4);
  const header =
    payload.length < 126
      ? Buffer.from([0x80 | opcode, 0x80 | payload.length])
      : Buffer.from([0x80 | opcode, 0x80 | 126, 0, 0]);
  if (payload.length >= 126) header.writeUInt16BE(payload.length, 2);
  const body = Buffer.from(payload);
  for (let index = 0; index < body.length; index += 1)
    body[index] ^= mask[index % 4];
  socket.write(Buffer.concat([header, mask, body]));
}

/**
 * The smallest RFC 6455 client that can prove the Host's stream carries a
 * settings change.
 *
 * It talks to the Host's own TLS port while presenting the public origin's Host
 * header, exactly as the app proxy does, because a WebSocket handshake carries
 * no CSRF header: what authorizes it is the exact Origin plus the
 * SameSite=Strict session cookie, and both have to be real here.
 */
async function openHostStream(protocol, jar) {
  const socket = tlsConnect({
    host: "127.0.0.1",
    port: hostPort,
    ca: credentials.cert,
    servername: "localhost",
  });
  await once(socket, "secureConnect");
  socket.on("error", () => {});
  const key = randomBytes(16).toString("base64");
  const accept = createHash("sha1")
    .update(key + streamGUID)
    .digest("base64");
  let buffer = Buffer.alloc(0);
  let handshake = null;
  const frames = [];
  let waiter = null;
  const wake = () => {
    if (!waiter) return;
    const resolve = waiter;
    waiter = null;
    resolve();
  };
  const pump = () => {
    if (handshake === null) {
      const end = buffer.indexOf("\r\n\r\n");
      if (end < 0) return;
      handshake = buffer.subarray(0, end).toString();
      buffer = buffer.subarray(end + 4);
      wake();
    }
    for (;;) {
      if (buffer.length < 2) return;
      const opcode = buffer[0] & 0x0f;
      let length = buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        length = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }
      if (buffer.length < offset + length) return;
      const payload = buffer.subarray(offset, offset + length);
      buffer = buffer.subarray(offset + length);
      if (opcode === 0x9) {
        writeStreamFrame(socket, 0xa, payload);
        continue;
      }
      if (opcode === 0x2)
        frames.push({
          frame: protocol.fromBinary(
            protocol.EventStreamFrameSchema,
            new Uint8Array(payload),
          ),
          at: Date.now(),
        });
      wake();
    }
  };
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    pump();
  });
  socket.write(
    [
      "GET /ws/armadra.v1.EventStream HTTP/1.1",
      `Host: localhost:${appPort}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      "Sec-WebSocket-Version: 13",
      `Sec-WebSocket-Key: ${key}`,
      `Origin: ${appOrigin}`,
      "Sec-Fetch-Site: same-origin",
      `Cookie: ${[...jar].map(([name, value]) => `${name}=${value}`).join("; ")}`,
      "",
      "",
    ].join("\r\n"),
  );
  // The handshake is proved, never assumed: a proxy answering 200 with a body
  // would otherwise look like a stream that simply never says anything.
  for (let attempt = 0; attempt < 200 && handshake === null; attempt += 1)
    await sleep(25);
  const client = {
    upgraded:
      handshake !== null &&
      handshake.startsWith("HTTP/1.1 101") &&
      handshake.includes(accept),
    handshake: (handshake ?? "").split("\r\n", 1)[0],
    send(payload) {
      writeStreamFrame(
        socket,
        0x2,
        Buffer.from(
          protocol.toBinary(
            protocol.EventStreamFrameSchema,
            protocol.create(protocol.EventStreamFrameSchema, payload),
          ),
        ),
      );
    },
    async next(timeoutMs = 5_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const entry = frames.shift();
        if (entry) return entry;
        if (Date.now() >= deadline) return null;
        await new Promise((resolve) => {
          waiter = resolve;
          setTimeout(() => {
            if (waiter === resolve) {
              waiter = null;
              resolve();
            }
          }, 20);
        });
      }
    },
    /** Envelopes of one domain that arrive inside the deadline. */
    async envelopes(domainValue, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      const collected = [];
      for (;;) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return collected;
        const entry = await client.next(remaining);
        if (!entry) return collected;
        if (entry.frame?.payload?.case !== "page") continue;
        for (const envelope of entry.frame.payload.value.events ?? [])
          if (envelope.domain === domainValue)
            collected.push({ envelope, at: entry.at });
      }
    },
    close() {
      socket.destroy();
    },
  };
  return client;
}

/* --------------------------------------------------- the settings document */

/**
 * The document the Runtime writes, reduced to what both sides must agree on.
 *
 * Timestamps and revisions are deliberately absent: they are the two things the
 * design says legitimately differ between a Runtime that stamps `updatedAt` and
 * a Host that counts revisions (§6.3). Everything else has to survive a switch
 * and a rollback unchanged, so it is all in the digest.
 */
function settingsShape(document) {
  const copy = JSON.parse(JSON.stringify(document ?? {}));
  return stable(copy);
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = stable(value[key]);
    return out;
  }
  return value;
}

const digestOf = (value) => sha256(JSON.stringify(value));

/** The bytes on disk, which is what every digest across the switch is over. */
function settingsFileDigest() {
  return existsSync(runtimeSettings)
    ? sha256(readFileSync(runtimeSettings))
    : "";
}

/* --------------------------------------------------------------- the check */

let driver;
try {
  console.log(`Building the Host binary, the Runtime and the client…`);
  mkdirSync(join(root, "target"), { recursive: true });
  run(
    "go",
    [
      "-C",
      "apps/host",
      "build",
      "-o",
      "../../target/armadra-host",
      "./cmd/armadra-host",
    ],
    { stdio: "inherit" },
  );
  run("cargo", ["build", "-p", "armadra-runtime"], {
    stdio: "inherit",
    env: {
      ...process.env,
      CARGO_TARGET_DIR: process.env.CARGO_TARGET_DIR ?? join(root, "target"),
    },
  });
  pnpm(["--filter", "@armadra/shared", "build"]);
  pnpm(["--filter", "@armadra/protocol", "build"]);
  pnpm(["--filter", "@armadra/host-client", "build"]);

  const { driver: nodeDriver } = await openDriver({
    root,
    workspace,
    appOrigin,
    driverFile: join(workspace, "driver.js"),
    skipApplication: true,
    nodeTransport,
    run,
  });
  driver = nodeDriver;

  appServer.listen(appPort, "127.0.0.1");
  await once(appServer, "listening");
  cleanups.push(() => appServer.close());

  /* ------------------------------ 1. settings the Runtime owns and writes */

  step(
    "the Runtime started on a kernel-assigned loopback port",
    await startRuntime(),
    `${runtimeOrigin} ${runtimeDiagnostics}`.trim(),
  );

  const domains = await runtimeCall("GET", "/api/ownership/domains");
  step(
    "a fresh database starts with the Runtime owning all six domains",
    domains.status === 200 &&
      domains.json?.length === 6 &&
      domains.json.every(
        (record) => record.owner === "runtime" && record.epoch === "1",
      ),
    (domains.json ?? []).map((record) => record.domain).join(", "),
  );

  const created = await runtimeCall("POST", "/api/workspaces", {
    name: "设置所有权端到端",
    rootPath: runtimeRoot,
  });
  step(
    "the Runtime created a workspace for the canvas the settings switch depends on",
    created.status === 200 && typeof created.json?.id === "string",
    created.json?.id ?? created.text,
  );
  const workspaceId = created.json.id;

  // A document with something from every layer the settings page writes: a
  // terminal choice, a per-platform keybinding, an execution host, and a key
  // nothing in this build knows about, which must survive untouched.
  const written = await runtimeCall("PATCH", "/api/settings", {
    terminal: { backend: "tmux", detachedGraceMinutes: 60 },
    keymap: { mac: { "canvas.tidy": "Mod+Shift+K" } },
    ssh: {
      hosts: [
        {
          id: "build_box",
          name: "构建机",
          host: "example.com",
          user: "ada",
          port: 2222,
          worker: { path: "/opt/armadra/armadra-runtime" },
        },
      ],
    },
    未知的键: { 保留: true },
  });
  step(
    "the Runtime stored a settings document with every layer the page writes",
    written.status === 200 &&
      written.json?.terminal?.backend === "tmux" &&
      written.json?.ssh?.hosts?.length === 1 &&
      written.json?.未知的键?.保留 === true,
    `HTTP ${written.status}`,
  );
  const runtimeDocument = settingsShape(written.json);
  const runtimeDigest = digestOf(runtimeDocument);
  const fileDigest = settingsFileDigest();
  step(
    "the document on disk is the one the Runtime answered with",
    fileDigest.length === 64 &&
      digestOf(
        settingsShape(JSON.parse(readFileSync(runtimeSettings, "utf8"))),
      ) === runtimeDigest,
    `file sha256=${fileDigest.slice(0, 16)}`,
  );

  /* -------------------------- 2. the dependency order refuses to be skipped */

  await stopRuntime();
  const tooEarly = tryRun(
    hostBinary,
    [
      "ownership",
      "switch",
      "--domain",
      "settings",
      "--import-id",
      "settings-too-early",
      "--data-dir",
      hostData,
      "--output",
      "json",
      ...runtimeTarget,
    ],
    { env: hostEnv },
  );
  step(
    "switching settings before the canvas has settled on the Host is refused",
    !tooEarly.ok &&
      /a domain this one depends on has not settled/i.test(tooEarly.output),
    tooEarly.ok ? "accepted" : tooEarly.output.trim().split("\n").pop(),
  );
  const stillRuntime = JSON.parse(
    ownershipCli("status", ["--domain", "settings"]),
  );
  step(
    "the refused switch left the settings record exactly where it was",
    stillRuntime.ownership?.owner === "CANVAS_OWNERSHIP_OWNER_RUNTIME" &&
      stillRuntime.ownership?.epoch === "1" &&
      stillRuntime.ownership?.phase === "CANVAS_OWNERSHIP_PHASE_SETTLED",
    `owner=${stillRuntime.ownership?.owner} epoch=${stillRuntime.ownership?.epoch}`,
  );

  /* ----------------------------- 3. the canvas moves first, then settings */

  const exportDirectory = join(workspace, "export");
  const exported = JSON.parse(
    run(
      runtimeBinary,
      [
        "export",
        "--database",
        runtimeDatabase,
        "--destination",
        exportDirectory,
        "--output",
        "json",
      ],
      { env: runtimeEnv },
    ),
  );
  const imported = JSON.parse(
    run(
      hostBinary,
      [
        "import",
        "--bundle",
        exportDirectory,
        "--data-dir",
        hostData,
        "--output",
        "json",
      ],
      { env: hostEnv },
    ),
  );
  step(
    "the canvas domain was exported and staged so settings has its prerequisite",
    imported.exportId === exported.exportId && imported.state === "staged",
    `importId=${imported.importId?.slice(0, 8)} entities=${imported.entityCount}`,
  );
  const canvasSwitched = JSON.parse(
    ownershipCli("switch", [
      "--domain",
      "canvas",
      "--import-id",
      imported.importId,
      ...runtimeTarget,
    ]),
  );
  step(
    "the canvas domain settled on the Host",
    canvasSwitched.ownership?.owner === "CANVAS_OWNERSHIP_OWNER_HOST" &&
      canvasSwitched.ownership?.phase === "CANVAS_OWNERSHIP_PHASE_SETTLED",
    `epoch=${canvasSwitched.ownership?.epoch}`,
  );

  const settingsImportId = `settings-${randomUUID().replaceAll("-", "")}`;
  const switched = JSON.parse(
    ownershipCli("switch", [
      "--domain",
      "settings",
      "--import-id",
      settingsImportId,
      ...runtimeTarget,
    ]),
  );
  const switchChecks = switched.report?.checks ?? [];
  const named = switchChecks.map((check) => check.check);
  step(
    "the settings switch moved the epoch to the Host",
    switched.ownership?.owner === "CANVAS_OWNERSHIP_OWNER_HOST" &&
      switched.ownership?.phase === "CANVAS_OWNERSHIP_PHASE_SETTLED" &&
      switched.ownership?.epoch === "2",
    `owner=${switched.ownership?.owner} epoch=${switched.ownership?.epoch}`,
  );
  step(
    "the switch compared the document, its keys and its execution hosts",
    switched.report?.matched === true &&
      named.includes("settings.document_sha256") &&
      named.includes("settings.keys") &&
      named.includes("settings.execution_hosts") &&
      switchChecks.every((check) => !check.differences?.length),
    named.join(", "),
  );

  /* ------------------ 4. the Runtime refuses settings writes, still reads */

  step(
    "the Runtime restarted after the maintenance window",
    await startRuntime(),
    runtimeOrigin,
  );
  const refused = await runtimeCall("PATCH", "/api/settings", {
    terminal: { backend: "direct" },
  });
  step(
    "the Runtime refuses settings writes with ownership_moved",
    refused.status === 409 && refused.json?.code === "ownership_moved",
    `HTTP ${refused.status} ${refused.json?.code}`,
  );
  const readBack = await runtimeCall("GET", "/api/settings");
  step(
    "the Runtime still answers settings reads, unchanged by the refusal",
    readBack.status === 200 &&
      digestOf(settingsShape(readBack.json)) === runtimeDigest,
    `sha256=${digestOf(settingsShape(readBack.json ?? {})).slice(0, 16)}`,
  );
  const canvasStillWritable = await runtimeCall(
    "GET",
    "/api/ownership/domains",
  );
  step(
    "only the two switched domains moved; the other four still name the Runtime",
    (canvasStillWritable.json ?? []).filter((record) => record.owner === "host")
      .length === 2,
    (canvasStillWritable.json ?? [])
      .map((record) => `${record.domain}=${record.owner}`)
      .join(" "),
  );

  /* ------------------------------- 5. the Host serves and writes settings */

  step(
    "the Host started on a temporary TLS port",
    await startHost(),
    hostDiagnostics,
  );
  const ticket = JSON.parse(
    run(
      hostBinary,
      [
        "pair",
        "--origin",
        appOrigin,
        "--device-name",
        "settings-e2e",
        "--data-dir",
        hostData,
      ],
      { env: hostEnv },
    ),
  );
  const hello = await driver.hello();
  step(
    "Hello advertises the settings surface through the proxied origin",
    hello.capabilities?.includes("settings.documents.v1") === true,
    hello.capabilities?.join(", "),
  );
  const session = await driver.pair(JSON.stringify(ticket));
  const scopes = (session.scopes ?? []).map((scope) => scope.permission);
  step(
    "pairing produced a session holding the settings scopes",
    scopes.includes("settings:read") && scopes.includes("settings:write"),
    scopes.filter((scope) => scope.startsWith("settings")).join(", "),
  );
  await driver.connect(workspaceId);

  const hostRead = await driver.settings("get", []);
  step(
    "the Host serves the document the Runtime handed over, digest for digest",
    digestOf(settingsShape(hostRead.value)) === runtimeDigest,
    `host=${digestOf(settingsShape(hostRead.value ?? {})).slice(0, 16)} runtime=${runtimeDigest.slice(0, 16)}${refusal(hostRead)}`,
  );
  step(
    "the Host projected the execution host out of the document it stored",
    (hostRead.executionHosts ?? []).some(
      (entry) => entry.executionHostId === "build_box",
    ),
    (hostRead.executionHosts ?? [])
      .map((entry) => entry.executionHostId || "(local)")
      .join(", "),
  );

  /* -------------------------------- 6. a save through the Host, and its event */

  const protocol = await import(
    pathToFileURL(join(root, "packages/protocol/dist/index.js")).href
  );
  const jar = new Map();
  // The stream needs the same session the client holds. Pairing a second device
  // keeps the two independent, which is what "a second client" means here.
  const streamTicket = JSON.parse(
    run(
      hostBinary,
      [
        "pair",
        "--origin",
        appOrigin,
        "--device-name",
        "settings-e2e-stream",
        "--data-dir",
        hostData,
      ],
      { env: hostEnv },
    ),
  );
  const clients = await import(
    pathToFileURL(join(root, "packages/host-client/dist/index.js")).href
  );
  const streamIdentity = new clients.HostIdentityClient({
    baseUrl: appOrigin,
    hostId: hello.hostId,
    hostInstanceId: hello.hostInstanceId,
    pageOrigin: appOrigin,
    fetch: nodeTransport(jar),
  });
  await streamIdentity.pair(JSON.stringify(streamTicket));
  const stream = await openHostStream(protocol, jar);
  step(
    "a second client upgraded to the Host event stream",
    stream.upgraded,
    stream.handshake,
  );
  cleanups.push(() => stream.close());
  stream.send({
    payload: {
      case: "subscribe",
      value: {
        afterSequence: hostRead.eventSequence,
        workspaceIds: [workspaceId],
        domains: [protocol.EventDomain.SETTINGS],
      },
    },
  });

  const nextDocument = {
    ...JSON.parse(JSON.stringify(hostRead.value)),
    theme: "深色",
  };
  nextDocument.ssh.hosts.push({
    id: "second-box",
    name: "第二台",
    host: "second.example.com",
    user: "ada",
  });
  const savedAt = Date.now();
  const saved = await driver.settings("put", [
    {
      document: new TextEncoder().encode(JSON.stringify(nextDocument)),
      expectedRevision: hostRead.revision,
      operationId: `settings/global/${hostRead.revision}`,
    },
  ]);
  step(
    "the Host stored the change and moved the document's revision",
    saved.revision === hostRead.revision + 1n &&
      JSON.parse(new TextDecoder().decode(saved.document)).theme === "深色",
    `revision ${hostRead.revision} → ${saved.revision}${refusal(saved)}`,
  );
  const stale = await driver.settings("put", [
    {
      document: new TextEncoder().encode(JSON.stringify(nextDocument)),
      expectedRevision: hostRead.revision,
      operationId: `settings/global/${hostRead.revision}/again`,
    },
  ]);
  step(
    "a save against the revision that was just superseded is a conflict",
    stale.error?.failure === "conflict",
    `${stale.error?.failure ?? "accepted"} HTTP ${stale.error?.httpStatus ?? 200}`,
  );

  const streamed = await stream.envelopes(protocol.EventDomain.SETTINGS, 3_000);
  const documentEvent = streamed.find(
    (entry) => entry.envelope.kind === "document",
  );
  step(
    "the second client received the settings change on the stream within a second",
    documentEvent !== undefined && documentEvent.at - savedAt < 1_000,
    documentEvent
      ? `${documentEvent.at - savedAt} ms, revision ${documentEvent.envelope.revision}`
      : `nothing arrived (${streamed.length} envelopes)`,
  );
  step(
    "the added execution host arrived as its own envelope, not only as a changed document",
    streamed.some(
      (entry) =>
        entry.envelope.kind === "executionHost" &&
        entry.envelope.entityId === "second-box",
    ),
    streamed
      .map((entry) => `${entry.envelope.kind}:${entry.envelope.entityId}`)
      .join(" "),
  );
  step(
    "the settings envelope names no workspace, because the document is host-wide",
    documentEvent?.envelope.workspaceId === "",
    `workspaceId=${JSON.stringify(documentEvent?.envelope.workspaceId ?? null)}`,
  );

  /* ----------------------------------------- 7. the rollback over HTTPS */

  const window = JSON.parse(ownershipCli("window", ["--domain", "settings"]));
  step(
    "the control channel issued a maintenance window for the settings domain",
    typeof window.token === "string" &&
      window.token.length === 64 &&
      window.domain === "settings",
    `expires in ${Math.round((Number(window.expiresAtUnixMs) - Date.now()) / 1000)}s`,
  );
  const rolledBack = await driver.ownership("switchDomain", [
    {
      domain: "settings",
      target: "runtime",
      expectedEpoch: 2n,
      maintenanceToken: window.token,
    },
  ]);
  const reverseChecks = Object.fromEntries(
    (rolledBack.report?.checks ?? []).map((check) => [
      check.check,
      check.matched,
    ]),
  );
  step(
    "the HTTPS rollback handed the settings epoch back to the Runtime",
    rolledBack.ownership?.owner === 1 &&
      rolledBack.ownership?.epoch === 3n &&
      rolledBack.report?.matched === true,
    `owner=${rolledBack.ownership?.owner} epoch=${rolledBack.ownership?.epoch}${refusal(rolledBack)}`,
  );
  step(
    "the Runtime's own re-read was compared with the package the Host wrote",
    reverseChecks["settings.export"] === true &&
      reverseChecks["reverse.settings.document_sha256"] === true &&
      reverseChecks["reverse.settings.keys"] === true &&
      reverseChecks["reverse.settings.execution_hosts"] === true &&
      reverseChecks["reverse.event_sequence"] === true,
    Object.keys(reverseChecks).join(", "),
  );

  /* --------------------- 8. what the Host wrote is what the Runtime now has */

  await stopRuntime();
  step(
    "the Runtime restarted after the rollback",
    await startRuntime(),
    runtimeOrigin,
  );
  const afterRollback = await runtimeCall("GET", "/api/settings");
  step(
    "the Runtime reads the change the Host made while it owned the domain",
    afterRollback.status === 200 &&
      afterRollback.json?.theme === "深色" &&
      afterRollback.json?.ssh?.hosts?.some(
        (entry) => entry.id === "second-box",
      ) &&
      afterRollback.json?.未知的键?.保留 === true,
    `theme=${afterRollback.json?.theme} hosts=${afterRollback.json?.ssh?.hosts?.length}`,
  );
  const writable = await runtimeCall("PATCH", "/api/settings", {
    terminal: { backend: "direct" },
  });
  step(
    "the Runtime writes settings again once the epoch is back",
    writable.status === 200 && writable.json?.terminal?.backend === "direct",
    `HTTP ${writable.status}`,
  );
  const settledAgain = await runtimeCall("GET", "/api/ownership/domains");
  step(
    "the settings record names the Runtime at the epoch it was handed",
    (settledAgain.json ?? []).some(
      (record) =>
        record.domain === "settings" &&
        record.owner === "runtime" &&
        record.epoch === "3",
    ),
    (settledAgain.json ?? [])
      .map((record) => `${record.domain}=${record.owner}@${record.epoch}`)
      .join(" "),
  );
} catch (error) {
  failures += 1;
  console.error(error);
  if (hostDiagnostics) console.error(`host: ${hostDiagnostics}`);
  if (runtimeDiagnostics) console.error(`runtime: ${runtimeDiagnostics}`);
} finally {
  await stopHost().catch(() => {});
  await stopRuntime().catch(() => {});
  teardown();
}

/** The Host's own refusal, appended to a step's detail when there was one. */
function refusal(answer) {
  return answer?.error
    ? ` (${answer.error.failure} HTTP ${answer.error.httpStatus} ${answer.error.hostCode})`
    : "";
}

console.log(
  `\n${results.length - failures}/${results.length} checks passed for --domain ${domain}.`,
);
process.exit(failures === 0 ? 0 : 1);
