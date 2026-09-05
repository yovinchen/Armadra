// End-to-end check for the canvas write-ownership switch (H01 / C02).
//
// Everything it talks to is local and temporary: a self-signed certificate, a
// real Rust Runtime on a kernel-assigned loopback port with its own data
// directory and database, a real Go Host on an ephemeral TLS port with a
// throwaway data directory, the Vite-built web bundle served from a temporary
// HTTPS origin that proxies /rpc to the Host, and a headless Chrome with a
// fresh profile. Nothing reaches the operator's own data directory, keychain or
// the ports the application reserves (1420, 1421, 43120, 43121).
//
// The proxy exists because the browser session transport requires the page and
// the Host to share an origin: cookies scoped to one origin are the point.
//
// The switch is driven twice on purpose: once through the offline CLI, whose
// maintenance window is the data directory lock, and once over HTTPS against a
// serving Host, whose window is a token issued at this machine over the
// same-user control channel. Both walk the same state machine — including the
// reversal, which imports the package back into the Runtime either way — and
// the second pass also proves a token cannot be spent twice.
//
// What this covers: a canvas that really contains the C02 shapes — a frame
// nested in a frame, a terminal and a sticky inside the inner frame, labels, a
// multi-line non-ASCII note, a context link and a whiteboard snapshot — written
// through the Runtime's HTTP API, exported, staged, verified, and then served
// by the Host under a moved epoch; the Runtime refusing writes while the Host
// holds the domain and still answering reads; a real edit through the Host with
// its receipt, its event and its replay; a second client following the Host's
// WebSocket event stream, which must see that edit within 200 ms and, after a
// disconnect, resume from its cursor without losing or repeating one event; and
// the reversal — the format version 2 package, the Runtime applying it to its
// own database, the Runtime's re-read compared against the package, and the
// edit the Host made during its tenure showing up in the Runtime's rows
// afterwards, including the refusal to hand the epoch back to a Runtime that
// cannot apply the package at all.
// Every step is proved by a digest, a revision or a sequence rather than by the
// absence of an exception: a check that only asserts "no error was thrown" would
// still pass against a migration that silently dropped half the canvas.
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { createHash, randomBytes } from "node:crypto";
import {
  createServer as createHttpServer,
  request as httpRequest,
} from "node:http";
import { createServer, request as httpsRequest } from "node:https";
import { connect as tlsConnect } from "node:tls";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
// The comparison layer: how each side's document is reduced to one shape and
// hashed. It talks to nothing, so it reads on its own.
import {
  digestOf,
  hostShape,
  refusal,
  runtimeShape,
  stable,
  text,
} from "./canvas-ownership-shapes.mjs";
// The client layer: the one @armadra/host-client both halves drive.
import { openDriver } from "./canvas-ownership-driver.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const skipApplication = process.env.CANVAS_E2E_SKIP_APP === "1";
const workspace = mkdtempSync(join(tmpdir(), "armadra-canvas-e2e-"));
const cleanups = [];
const results = [];
let failures = 0;

function step(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(
    `  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`,
  );
  if (!ok) failures += 1;
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: root,
    stdio: "pipe",
    encoding: "utf8",
    timeout: 900_000,
    ...options,
  });
}

/** Runs a command that is expected to fail, so the refusal can be asserted. */
function tryRun(command, args, options = {}) {
  try {
    return { status: 0, stdout: run(command, args, options), stderr: "" };
  } catch (error) {
    return {
      status: error.status ?? -1,
      stdout: String(error.stdout ?? ""),
      stderr: String(error.stderr ?? error.message ?? ""),
    };
  }
}

function pnpm(args) {
  const options = { stdio: "inherit" };
  if (/\.(?:c|m)?js$/i.test(process.env.npm_execpath ?? ""))
    return run(process.execPath, [process.env.npm_execpath, ...args], options);
  return run(process.platform === "win32" ? "pnpm.exe" : "pnpm", args, options);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

/**
 * Runs every registered cleanup once. Two processes, a TLS server, a browser
 * and a temporary directory outlive a crash otherwise, and an abandoned Host
 * keeps the data directory lock a later run would need.
 */
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
    // Chrome keeps writing to its profile for a moment after it is signalled,
    // so a first removal can race it; the retries are cheaper than leaving a
    // profile behind on every run.
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

const mediaTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json",
};
const distribution = join(root, "apps/web/dist");
const driverFile = join(workspace, "driver.js");

const appServer = createServer(credentials, (req, res) => {
  const url = new URL(req.url, appOrigin);
  if (url.pathname.startsWith("/rpc/") || url.pathname === "/health") {
    // The Host header is forwarded unchanged so the Host still sees its own
    // public origin; rewriting it would defeat the check being exercised.
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
    return;
  }
  if (url.pathname === "/e2e/") {
    res.writeHead(200, { "Content-Type": mediaTypes[".html"] });
    return res.end(
      `<!doctype html><meta charset="utf-8"><title>e2e</title><script type="module" src="/e2e/driver.js"></script>`,
    );
  }
  if (url.pathname === "/e2e/driver.js") {
    res.writeHead(200, { "Content-Type": mediaTypes[".js"] });
    return res.end(readFileSync(driverFile));
  }
  let file = join(
    distribution,
    url.pathname === "/" ? "index.html" : url.pathname.slice(1),
  );
  if (!file.startsWith(distribution) || !existsSync(file))
    file = join(distribution, "index.html");
  try {
    res.writeHead(200, {
      "Content-Type": mediaTypes[extname(file)] ?? "application/octet-stream",
    });
    res.end(readFileSync(file));
  } catch {
    res.writeHead(404).end();
  }
});

/* -------------------------------------------------------------- the Runtime */

const runtimeBinary = join(
  root,
  "target",
  "debug",
  process.platform === "win32" ? "armadra-runtime.exe" : "armadra-runtime",
);
const runtimeData = join(workspace, "runtime");
const runtimeRoot = join(workspace, "project");
const runtimeDatabase = join(runtimeData, "canvas.db");
mkdirSync(runtimeData, { recursive: true });
mkdirSync(runtimeRoot, { recursive: true });
const runtimeEnv = {
  ...process.env,
  // Everything the Runtime persists — database, endpoints file, hook socket,
  // node tokens — is redirected here, so a check never touches the operator's
  // own data directory or the endpoints file a running Armadra publishes to.
  ARMADRA_DATA_DIR: runtimeData,
  ARMADRA_DATABASE_URL: `sqlite://${runtimeDatabase}?mode=rwc`,
  RUST_LOG: process.env.RUST_LOG ?? "warn",
};
const endpointsFile = join(runtimeData, "endpoints.json");

let runtime = null;
let runtimeOrigin = "";
let runtimeDiagnostics = "";

/**
 * Starts the Runtime on a kernel-assigned loopback port. The number is read
 * back from the endpoints file the Runtime publishes after it binds, which is
 * the only way to learn a `tcp:127.0.0.1:0` address; guessing a port here would
 * also risk colliding with a Runtime the operator is already running.
 */
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

/* ------------------------------------------------------------------ the Host */

const hostBinary = join(
  root,
  "target",
  process.platform === "win32" ? "armadra-host.exe" : "armadra-host",
);
const hostData = join(workspace, "host");
const hostEnv = {
  ...process.env,
  // Never write into the operator's real keychain during a check.
  ARMADRA_GITHUB_SECRET_STORE: "file",
};
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
      // Naming the Runtime executable and its database is what makes a switch
      // over HTTPS possible at all: without them the Host answers the record
      // and refuses to move it, because it has no way to tell the Runtime.
      "--runtime-binary",
      runtimeBinary,
      "--runtime-database",
      runtimeDatabase,
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
 * Stops the Host completely. The ownership commands take the same data
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

function ownership(action, extra = []) {
  return JSON.parse(
    run(
      hostBinary,
      [
        "ownership",
        action,
        "--data-dir",
        hostData,
        "--output",
        "json",
        ...extra,
      ],
      { env: hostEnv },
    ),
  );
}

/* ------------------------------------------------------- the event stream */

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
 * The smallest RFC 6455 client that can prove the Host's stream works.
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
      if (opcode === 0x8)
        frames.push({
          close: payload.length >= 2 ? payload.readUInt16BE(0) : 0,
          at: Date.now(),
        });
      else if (opcode === 0x2)
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
  return {
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
    /** The next frame, or null when nothing arrived inside the deadline. */
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
    /** Every event page frame that arrives inside the deadline. */
    async pages(timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      const collected = [];
      for (;;) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return collected;
        const entry = await this.next(remaining);
        if (!entry) return collected;
        const page = entry.frame?.payload?.value;
        if (entry.frame?.payload?.case === "page")
          collected.push({ page, at: entry.at });
      }
    },
    close() {
      socket.destroy();
    },
  };
}

/* ------------------------------------------------------------------- Chrome */

async function browserPath() {
  const candidates = process.env.CHROME_PATH
    ? [process.env.CHROME_PATH]
    : process.platform === "darwin"
      ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
      : process.platform === "win32"
        ? [
            join(
              process.env.PROGRAMFILES ?? "",
              "Google/Chrome/Application/chrome.exe",
            ),
          ]
        : [
            "/usr/bin/google-chrome",
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
          ];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {}
  }
  throw new Error("Chrome not found. Set CHROME_PATH; nothing is downloaded.");
}

let sequence = 0;
function devtools(socket) {
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const settle = pending.get(message.id);
    if (!settle) return;
    pending.delete(message.id);
    if (message.error) settle.reject(new Error(message.error.message));
    else settle.resolve(message.result);
  });
  return (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = (sequence += 1);
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params, sessionId }));
      setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`${method} timed out`));
      }, 60_000);
    });
}

/* -------------------------------------------------- the canvas the C02 shapes */

const uuid = () => crypto.randomUUID();
const stamp = "2026-09-06T09:00:00.000Z";

const outerFrame = uuid();
const innerFrame = uuid();
const terminalNode = uuid();
const stickyNode = uuid();
const contextLink = uuid();
const note =
  "第一行：迁移前写下的备注\n第二行：ünïcödé 与 emoji-free 文本\n第三行：tail";
const whiteboard = JSON.stringify({
  schema: 2,
  records: [{ id: "shape:ink", type: "draw", text: "白板笔迹 ünïcödé" }],
});

function node(id, type, title, x, y, data, extra = {}) {
  return {
    id,
    boardId: "",
    type,
    title,
    color: "#7c5cff",
    position: { x, y },
    labels: [],
    note: "",
    data,
    createdAt: stamp,
    updatedAt: stamp,
    ...extra,
  };
}

/** The C02 document: a frame inside a frame, two children, a link, a snapshot. */
function documentFor(boardId, stickyContent) {
  const nodes = [
    node(
      outerFrame,
      "group",
      "外层画框",
      0,
      0,
      { kind: "group" },
      {
        size: { width: 900, height: 620 },
      },
    ),
    node(
      innerFrame,
      "group",
      "内层画框",
      60,
      80,
      { kind: "group" },
      {
        size: { width: 720, height: 460 },
        parentId: outerFrame,
      },
    ),
    node(
      terminalNode,
      "terminal",
      "终端节点",
      120,
      160,
      { kind: "terminal", cwd: runtimeRoot, shell: "/bin/sh" },
      {
        size: { width: 420, height: 260 },
        parentId: innerFrame,
        labels: ["运行中", "review"],
        note,
      },
    ),
    node(
      stickyNode,
      "sticky",
      "便签节点",
      600,
      160,
      { kind: "sticky", content: stickyContent },
      {
        size: { width: 240, height: 200 },
        parentId: innerFrame,
        labels: ["笔记"],
        note: "便签自己的备注：ünïcödé",
      },
    ),
  ].map((value) => ({ ...value, boardId }));
  const edges = [
    {
      id: contextLink,
      boardId,
      source: terminalNode,
      target: stickyNode,
      kind: "link",
      createdAt: stamp,
      updatedAt: stamp,
    },
  ];
  return { nodes, edges };
}

/* --------------------------------------------------------------------- run */

let chrome, socket, canvasDriver, devtoolsCall;
try {
  console.log("Building the Host binary, the Runtime, the client and the app…");
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
  // The browser half is skippable so the switch itself can be checked on a
  // machine with no Chrome; the summary says which half ran rather than
  // implying both did.
  if (!skipApplication) pnpm(["--filter", "@armadra/web", "build"]);

  // The driver the whole check talks through: one @armadra/host-client, driven
  // from Chrome or, with the browser half skipped, from Node over the same TLS
  // proxy.
  const { driverCore, driver: nodeDriver } = await openDriver({
    root,
    workspace,
    appOrigin,
    driverFile,
    skipApplication,
    nodeTransport,
    run,
  });
  canvasDriver = nodeDriver;

  appServer.listen(appPort, "127.0.0.1");
  await once(appServer, "listening");
  cleanups.push(() => appServer.close());

  /* ------------------------------------------ 1. a canvas the Runtime owns */

  step(
    "the Runtime started on a kernel-assigned loopback port",
    await startRuntime(),
    `${runtimeOrigin} ${runtimeDiagnostics}`.trim(),
  );

  const before = await runtimeCall("GET", "/api/ownership");
  step(
    "a fresh database starts with the Runtime owning canvas writes",
    before.status === 200 &&
      before.json?.owner === "runtime" &&
      before.json?.epoch === "1",
    `owner=${before.json?.owner} epoch=${before.json?.epoch}`,
  );

  const created = await runtimeCall("POST", "/api/workspaces", {
    name: "所有权端到端",
    rootPath: runtimeRoot,
  });
  step(
    "the Runtime created a workspace",
    created.status === 200 && typeof created.json?.id === "string",
    created.json?.id ?? created.text,
  );
  const workspaceId = created.json.id;

  const board = await runtimeCall(
    "POST",
    `/api/workspaces/${workspaceId}/boards`,
    { name: "迁移画布" },
  );
  step(
    "the Runtime created a canvas",
    board.status === 200 && typeof board.json?.id === "string",
    board.json?.id ?? board.text,
  );
  const canvasId = board.json.id;
  const documentPath = `/api/workspaces/${workspaceId}/boards/${canvasId}/document`;

  const original = documentFor(canvasId, "迁移前的便签正文\n第二行");
  const saved = await runtimeCall("PUT", documentPath, {
    expectedUpdatedAt: board.json.updatedAt,
    ...original,
    viewport: { x: -40, y: 20, zoom: 1.5 },
    whiteboard,
  });
  const savedDigest = digestOf({
    name: board.json.name,
    whiteboard,
    nodes: original.nodes.map((value) => ({
      id: value.id,
      type: value.type,
      title: value.title,
      color: value.color,
      x: value.position.x,
      y: value.position.y,
      width: value.size?.width ?? null,
      height: value.size?.height ?? null,
      parentId: value.parentId ?? "",
      labels: value.labels,
      note: value.note,
      data: stable(value.data),
    })),
    edges: original.edges,
  });
  step(
    "the Runtime stored the C02 document",
    saved.status === 200 && digestOf(runtimeShape(saved.json)) === savedDigest,
    `sha256=${savedDigest.slice(0, 16)}`,
  );

  /* ---------------------------------------------- 2. it reads back verbatim */

  const reloaded = await runtimeCall("GET", documentPath);
  const runtimeDigest = digestOf(runtimeShape(reloaded.json ?? {}));
  step(
    "the stored document reads back with the same digest",
    reloaded.status === 200 && runtimeDigest === savedDigest,
    `sha256=${runtimeDigest.slice(0, 16)}`,
  );
  const stored = new Map(
    (reloaded.json?.nodes ?? []).map((value) => [value.id, value]),
  );
  step(
    "a frame nests inside a frame and both children name the inner one",
    stored.get(outerFrame)?.parentId === undefined &&
      stored.get(innerFrame)?.parentId === outerFrame &&
      stored.get(terminalNode)?.parentId === innerFrame &&
      stored.get(stickyNode)?.parentId === innerFrame,
    `${stored.get(innerFrame)?.parentId?.slice(0, 8)} ⊂ ${outerFrame.slice(0, 8)}`,
  );
  step(
    "positions, labels and the multi-line note survived the save",
    stored.get(terminalNode)?.position?.x === 120 &&
      stored.get(terminalNode)?.size?.height === 260 &&
      stored.get(terminalNode)?.labels?.join(",") === "运行中,review" &&
      stored.get(terminalNode)?.note === note,
    `note lines=${(stored.get(terminalNode)?.note ?? "").split("\n").length}`,
  );
  step(
    "the context link joins the terminal to the sticky",
    reloaded.json?.edges?.length === 1 &&
      reloaded.json.edges[0].source === terminalNode &&
      reloaded.json.edges[0].target === stickyNode &&
      reloaded.json.edges[0].kind === "link",
    `${terminalNode.slice(0, 8)} → ${stickyNode.slice(0, 8)}`,
  );
  step(
    "the whiteboard snapshot round-tripped byte for byte",
    sha256(reloaded.json?.board?.whiteboard ?? "") === sha256(whiteboard),
    `sha256=${sha256(whiteboard).slice(0, 16)}`,
  );

  /* ---------------------------------------- 3. export, import and the switch */

  // The export reads the database file and the ownership command drives a
  // Worker that writes to it. Stopping the Runtime first is the maintenance
  // window the design asks for: no second writer while the epoch moves.
  await stopRuntime();
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
  step(
    "the Runtime wrote a verified export package",
    typeof exported.exportId === "string" &&
      existsSync(join(exportDirectory, "manifest.pb")) &&
      exported.ownershipSwitchAllowed === false,
    `exportId=${exported.exportId?.slice(0, 8)} bytes=${exported.databaseBytes}`,
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
    "the Host staged the package without taking ownership",
    typeof imported.importId === "string" &&
      imported.exportId === exported.exportId &&
      imported.state === "staged",
    `importId=${imported.importId?.slice(0, 8)} entities=${imported.entityCount}`,
  );

  const switched = ownership("switch", [
    "--import-id",
    imported.importId,
    "--runtime-binary",
    runtimeBinary,
    "--runtime-database",
    runtimeDatabase,
  ]);
  const switchChecks = switched.report?.checks ?? [];
  step(
    "the switch moved the epoch to the Host",
    switched.ownership?.owner === "CANVAS_OWNERSHIP_OWNER_HOST" &&
      switched.ownership?.phase === "CANVAS_OWNERSHIP_PHASE_SETTLED" &&
      switched.ownership?.epoch === "2",
    `owner=${switched.ownership?.owner} epoch=${switched.ownership?.epoch}`,
  );
  step(
    "every consistency check matched, with no differences reported",
    switched.report?.matched === true &&
      switchChecks.length > 0 &&
      switchChecks.every((check) => !check.differences?.length),
    `${switchChecks.map((check) => check.check).join(", ")} entities=${switched.report?.entityCount}`,
  );
  const status = ownership("status");
  step(
    "a fresh status read agrees with the switch it just performed",
    status.ownership?.owner === "CANVAS_OWNERSHIP_OWNER_HOST" &&
      status.ownership?.phase === "CANVAS_OWNERSHIP_PHASE_SETTLED" &&
      status.ownership?.epoch === "2" &&
      status.ownership?.importId === imported.importId,
    `reason=${status.ownership?.reasonCode}`,
  );

  /* --------------------------------------------- 4. the Runtime now refuses */

  step(
    "the Runtime restarted after the maintenance window",
    await startRuntime(),
    runtimeOrigin,
  );
  const moved = await runtimeCall("GET", "/api/ownership");
  step(
    "the Runtime reports the domain as the Host's",
    moved.json?.owner === "host" && moved.json?.epoch === "2",
    `owner=${moved.json?.owner} epoch=${moved.json?.epoch} reason=${moved.json?.reasonCode}`,
  );
  const refusedSave = await runtimeCall("PUT", documentPath, {
    expectedUpdatedAt: reloaded.json.board.updatedAt,
    ...documentFor(canvasId, "这次写入必须被拒绝"),
    viewport: { x: 0, y: 0, zoom: 1 },
    whiteboard,
  });
  step(
    "a canvas write to the Runtime is refused with ownership_moved",
    refusedSave.status === 409 && refusedSave.json?.code === "ownership_moved",
    `HTTP ${refusedSave.status} ${refusedSave.json?.code}`,
  );
  const refusedBoard = await runtimeCall(
    "POST",
    `/api/workspaces/${workspaceId}/boards`,
    { name: "不应创建" },
  );
  step(
    "creating a canvas is refused the same way, not with a different code",
    refusedBoard.status === 409 &&
      refusedBoard.json?.code === "ownership_moved",
    `HTTP ${refusedBoard.status} ${refusedBoard.json?.code}`,
  );
  const readOnly = await runtimeCall("GET", documentPath);
  step(
    "the read-only fallback still answers the document it no longer owns",
    readOnly.status === 200 &&
      digestOf(runtimeShape(readOnly.json)) === runtimeDigest,
    `sha256=${digestOf(runtimeShape(readOnly.json ?? {})).slice(0, 16)}`,
  );

  /* --------------------------------------------- 5. the Host now writes it */

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
        "canvas-e2e",
        "--data-dir",
        hostData,
      ],
      { env: hostEnv },
    ),
  );
  step("the Host issued a pairing ticket", typeof ticket.ticket === "string");

  if (!skipApplication) {
    chrome = spawn(
      await browserPath(),
      [
        "--headless=new",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-gpu",
        `--user-data-dir=${join(workspace, "chrome-profile")}`,
        "--remote-debugging-port=0",
        // The certificate exists only for this run and never leaves the
        // temporary directory; a private trust store would add nothing.
        "--ignore-certificate-errors",
        "about:blank",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    cleanups.push(() => chrome.kill("SIGTERM"));
    const endpoint = await new Promise((resolve, reject) => {
      let output = "";
      const timer = setTimeout(
        () => reject(new Error("Chrome did not start")),
        30_000,
      );
      chrome.stderr.on("data", (chunk) => {
        output += chunk;
        const match = output.match(
          /ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/\S+/,
        );
        if (match) {
          clearTimeout(timer);
          resolve(match[0]);
        }
      });
    });
    socket = new WebSocket(endpoint);
    await once(socket, "open");
    const call = devtools(socket);
    devtoolsCall = call;

    const { targetId } = await call("Target.createTarget", {
      url: `${appOrigin}/e2e/`,
    });
    const { sessionId } = await call("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    await call("Page.enable", {}, sessionId);
    await call("Runtime.enable", {}, sessionId);
    const evaluate = async (expression) => {
      const result = await call(
        "Runtime.evaluate",
        {
          expression: `(async () => { ${expression} })()`,
          awaitPromise: true,
          returnByValue: true,
        },
        sessionId,
      );
      if (result.exceptionDetails)
        throw new Error(
          result.exceptionDetails.exception?.description ??
            result.exceptionDetails.text,
        );
      return result.result.value;
    };
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (await evaluate("return globalThis.armadraReady === true;")) break;
      await sleep(100);
    }
    step(
      "the browser loaded the real host-client bundle",
      (await evaluate("return globalThis.armadraReady === true;")) === true,
    );
    const { decodeValue, encodeValue } = await import(
      pathToFileURL(driverCore).href
    );
    canvasDriver = {
      hello: async () => decodeValue(await evaluate("return armadra.hello();")),
      pair: async (material) =>
        decodeValue(
          await evaluate(`return armadra.pair(${JSON.stringify(material)});`),
        ),
      connect: (workspaceId) =>
        evaluate(`return armadra.connect(${JSON.stringify(workspaceId)});`),
      call: async (method, args) =>
        decodeValue(
          await evaluate(
            `return armadra.call(${JSON.stringify(method)}, ${JSON.stringify(encodeValue(args))});`,
          ),
        ),
      ownership: async (method, args) =>
        decodeValue(
          await evaluate(
            `return armadra.ownership(${JSON.stringify(method)}, ${JSON.stringify(encodeValue(args))});`,
          ),
        ),
    };
    cleanups.push(() =>
      call("Target.closeTarget", { targetId }).catch(() => {}),
    );
  } else {
    console.log("  skip  the browser half (CANVAS_E2E_SKIP_APP=1)");
  }

  const hello = await canvasDriver.hello();
  step(
    "Hello advertises the canvas surface through the proxied origin",
    hello.capabilities?.includes("canvas.documents.v1") === true,
    hello.capabilities?.join(", "),
  );
  const session = await canvasDriver.pair(JSON.stringify(ticket));
  const scopes = (session.scopes ?? []).map((scope) => scope.permission);
  step(
    "pairing produced a session holding the canvas scopes",
    scopes.includes("canvas:read") && scopes.includes("canvas:write"),
    scopes.filter((scope) => scope.startsWith("canvas")).join(", "),
  );
  await canvasDriver.connect(workspaceId);

  const hostOwnership = await canvasDriver.call("getOwnership", []);
  step(
    "the authenticated client is told the Host owns the domain",
    hostOwnership.ownership?.owner === 2 &&
      hostOwnership.ownership?.epoch === 2n,
    `owner=${hostOwnership.ownership?.owner} epoch=${hostOwnership.ownership?.epoch}${refusal(hostOwnership)}`,
  );

  const migrated = await canvasDriver.call("getDocument", [canvasId]);
  const migratedDigest = digestOf(hostShape(migrated));
  step(
    "the migrated document is the same canvas, digest for digest",
    migratedDigest === runtimeDigest,
    `host=${migratedDigest.slice(0, 16)} runtime=${runtimeDigest.slice(0, 16)}${refusal(migrated)}`,
  );
  const beforeEdit = migrated.eventSequence;
  const canvasRevision = migrated.canvas.revision;

  // Only the canvas row changes: everything else is re-sent exactly as it was
  // read, so a save that replayed the whole document would show up as extra
  // events and a larger transaction below.
  const edit = {
    operationId: `canvas/${workspaceId}/${canvasId}/1`,
    canvas: { ...migrated.canvas, name: "迁移后的画布名" },
    expectedRevision: canvasRevision,
    nodes: migrated.nodes,
    edges: migrated.edges,
    annotations: migrated.annotations,
  };
  const applied = await canvasDriver.call("saveDocument", [edit]);
  // Read the canvas back rather than trusting the save's own answer. The write
  // reaches storage before the client validates the response, so the effect is
  // observable even when the response itself is refused — and a save that
  // reported success while storing nothing would be caught right here.
  const afterEdit = await canvasDriver.call("getDocument", [canvasId]);
  step(
    "the Host applied the edit and advanced the canvas revision",
    afterEdit.canvas?.revision === canvasRevision + 1n &&
      afterEdit.canvas?.name === "迁移后的画布名",
    `revision ${canvasRevision} → ${afterEdit.canvas?.revision} name=${afterEdit.canvas?.name}${refusal(afterEdit)}`,
  );
  step(
    "the save answered with a receipt for the operation id the client sent",
    applied.receipt?.operationId === edit.operationId &&
      applied.receipt?.replayed !== true &&
      applied.receipt?.transactionId > 0n,
    `sent=${edit.operationId} transaction=${applied.receipt?.transactionId}${refusal(applied)}`,
  );
  step(
    "the receipt names exactly the one object the save changed",
    applied.receipt?.revisions?.length === 1 &&
      applied.receipt.revisions[0].entityId === canvasId,
    `${applied.receipt?.revisions?.length ?? 0} revision(s)`,
  );

  const replay = await canvasDriver.call("saveDocument", [
    {
      ...edit,
      canvas: afterEdit.canvas,
      expectedRevision: canvasRevision + 1n,
    },
  ]);
  step(
    "replaying the identical save with the same operation id writes nothing",
    replay.receipt?.replayed === true &&
      replay.document?.canvas?.revision === canvasRevision + 1n,
    `replayed=${replay.receipt?.replayed} revision=${replay.document?.canvas?.revision}${refusal(replay)}`,
  );

  /* ------------------------------------------------------- 6. the event feed */

  const feed = await canvasDriver.call("subscribeEvents", [beforeEdit, 200]);
  const event = feed.events?.[0];
  step(
    "the subscription hands over exactly the object that changed",
    feed.status === "ok" &&
      feed.events?.length === 1 &&
      event.entityId === canvasId &&
      event.kind === 2 &&
      event.sequence > beforeEdit,
    `sequence ${beforeEdit} → ${event?.sequence} entity=${event?.entityId?.slice(0, 8)}${refusal(feed)}`,
  );
  step(
    "the event names its position in a single-object transaction",
    event?.transactionIndex === 0 && event?.transactionSize === 1,
    `index=${event?.transactionIndex} size=${event?.transactionSize}`,
  );

  /* ------------------------------------------- 6b. the pushed event stream */

  // A second client, paired on its own device, following the Host's WebSocket
  // stream instead of asking every few seconds. Everything below is measured
  // against real frames on a real socket: the point of the stream is latency
  // and resumability, and neither can be proved by "no error was thrown".
  const streamProtocol = await import(
    pathToFileURL(join(root, "packages/protocol/dist/index.js")).href
  );
  const streamTicket = JSON.parse(
    run(
      hostBinary,
      [
        "pair",
        "--origin",
        appOrigin,
        "--device-name",
        "canvas-e2e-stream",
        "--data-dir",
        hostData,
      ],
      { env: hostEnv },
    ),
  );
  const streamClients = await import(
    pathToFileURL(join(root, "packages/host-client/dist/index.js")).href
  );
  const streamJar = new Map();
  const streamIdentity = new streamClients.HostIdentityClient({
    baseUrl: appOrigin,
    hostId: streamTicket.hostId,
    hostInstanceId: streamTicket.hostInstanceId,
    pageOrigin: appOrigin,
    fetch: nodeTransport(streamJar),
  });
  const streamSession = await streamIdentity.pair(JSON.stringify(streamTicket));
  step(
    "a second device paired and holds a session cookie of its own",
    streamSession?.device?.displayName === "canvas-e2e-stream" &&
      streamJar.size > 0,
    `cookies=${streamJar.size} device=${streamSession?.device?.displayName}`,
  );

  const stream = await openHostStream(streamProtocol, streamJar);
  step(
    "the Host upgraded the event stream for that session's cookie and origin",
    stream.upgraded,
    stream.handshake,
  );
  const cursorBeforeStream = (
    await canvasDriver.call("getDocument", [canvasId])
  ).eventSequence;
  stream.send({
    payload: {
      case: "subscribe",
      value: {
        afterSequence: cursorBeforeStream,
        workspaceIds: [workspaceId],
      },
    },
  });

  // The catch-up half: the subscription has to reach the watermark before the
  // Host starts pushing, and it says so with `hasMore` rather than leaving the
  // client to guess when it is current.
  let streamCursor = cursorBeforeStream;
  const caughtUp = await stream.pages(5_000);
  for (const entry of caughtUp) streamCursor = entry.page.nextCursor;
  step(
    "the subscription caught up to the Host's watermark before pushing",
    streamCursor >= cursorBeforeStream &&
      caughtUp.every(
        (entry) => entry.page.status === streamProtocol.EventCursorStatus.OK,
      ),
    `cursor ${cursorBeforeStream} → ${streamCursor} in ${caughtUp.length} page(s)`,
  );

  const pushedAt = Date.now();
  const streamedEdit = await canvasDriver.call("saveDocument", [
    {
      operationId: `canvas/${workspaceId}/${canvasId}/stream-1`,
      canvas: { ...afterEdit.canvas, name: "经事件流看到的改名" },
      expectedRevision: afterEdit.canvas.revision,
      nodes: afterEdit.nodes,
      edges: afterEdit.edges,
      annotations: afterEdit.annotations,
    },
  ]);
  const pushedSequence = streamedEdit.receipt?.lastSequence;
  const pushed = await stream.pages(3_000);
  const pushedEvents = pushed.flatMap((entry) => entry.page.events);
  const arrival = pushed.find((entry) =>
    entry.page.events.some((event) => event.sequence === pushedSequence),
  );
  const latency = arrival ? arrival.at - pushedAt : -1;
  step(
    "a save reaches the second client through the stream in under 200 ms",
    arrival !== undefined && latency >= 0 && latency < 200,
    `sequence=${pushedSequence} latency=${latency}ms`,
  );
  step(
    "the pushed envelope names the canvas that changed, in the canvas domain",
    pushedEvents.length === 1 &&
      pushedEvents[0].entityId === canvasId &&
      pushedEvents[0].kind === "canvas" &&
      pushedEvents[0].domain === streamProtocol.EventDomain.CANVAS &&
      pushedEvents[0].entity?.case === "canvas" &&
      pushedEvents[0].entity.value.name === "经事件流看到的改名",
    `${pushedEvents.length} event(s) kind=${pushedEvents[0]?.kind} name=${pushedEvents[0]?.entity?.value?.name}`,
  );
  for (const entry of pushed) streamCursor = entry.page.nextCursor;

  // The reconnect half. Two saves land while nobody is listening; resuming from
  // the cursor has to deliver exactly those two — losing one would leave a
  // client silently stale, and repeating one would re-apply a change it already
  // has.
  stream.close();
  const offlineSequences = [];
  let offlineBase = streamedEdit.document?.canvas ?? afterEdit.canvas;
  for (const name of ["断线期间的第一次改动", "断线期间的第二次改动"]) {
    const saved = await canvasDriver.call("saveDocument", [
      {
        operationId: `canvas/${workspaceId}/${canvasId}/offline-${offlineSequences.length}`,
        canvas: { ...offlineBase, name },
        expectedRevision: offlineBase.revision,
        nodes: afterEdit.nodes,
        edges: afterEdit.edges,
        annotations: afterEdit.annotations,
      },
    ]);
    offlineBase = saved.document?.canvas ?? offlineBase;
    offlineSequences.push(saved.receipt?.lastSequence);
  }
  step(
    "two more edits were written while the stream was disconnected",
    offlineSequences.every((sequence) => typeof sequence === "bigint") &&
      offlineSequences[1] > offlineSequences[0],
    offlineSequences.join(", "),
  );

  const resumed = await openHostStream(streamProtocol, streamJar);
  step(
    "the second client reconnected with the cursor it already held",
    resumed.upgraded,
    resumed.handshake,
  );
  resumed.send({
    payload: {
      case: "subscribe",
      value: { afterSequence: streamCursor, workspaceIds: [workspaceId] },
    },
  });
  const replayed = await resumed.pages(5_000);
  const replayedEvents = replayed.flatMap((entry) => entry.page.events);
  const replayedSequences = replayedEvents.map((event) => event.sequence);
  step(
    "resuming delivered every missed event exactly once, in order",
    replayedSequences.length === offlineSequences.length &&
      replayedSequences.every(
        (sequence, index) => sequence === offlineSequences[index],
      ),
    `expected ${offlineSequences.join(",")} got ${replayedSequences.join(",")}`,
  );
  step(
    "resuming replayed nothing the client had already applied",
    replayedSequences.every((sequence) => sequence > streamCursor),
    `cursor=${streamCursor} first=${replayedSequences[0]}`,
  );
  resumed.close();

  /* ------------------------------------------------------------ 7. rollback */

  await stopHost();
  await stopRuntime();
  // A rollback writes its package once. A directory that already holds one is
  // refused rather than overwritten: the previous attempt may be the only copy
  // of what the Host held.
  const refusedExport = join(workspace, "reverse-export-refused");
  mkdirSync(refusedExport, { recursive: true });
  writeFileSync(join(refusedExport, "occupied"), "not empty\n");
  const refusedRollback = tryRun(
    hostBinary,
    [
      "ownership",
      "rollback",
      "--data-dir",
      hostData,
      "--output",
      "json",
      "--export",
      refusedExport,
      "--runtime-binary",
      runtimeBinary,
      "--runtime-database",
      runtimeDatabase,
    ],
    { env: hostEnv },
  );
  step(
    "a rollback refuses to write over a package that is already there",
    refusedRollback.status !== 0 &&
      readdirSync(refusedExport).join() === "occupied",
    refusedRollback.stderr.trim().split("\n").at(-1),
  );
  const stillHost = ownership("status");
  step(
    "the refused rollback left the epoch where it was",
    stillHost.ownership?.owner === "CANVAS_OWNERSHIP_OWNER_HOST" &&
      stillHost.ownership?.epoch === "2",
    `owner=${stillHost.ownership?.owner} epoch=${stillHost.ownership?.epoch}`,
  );

  // No --accept-export-only. The Host's edit has to travel back into the
  // Runtime's own database, and the epoch only moves once the Runtime has read
  // its rows back and the Host has compared the digests.
  const reverseExport = join(workspace, "reverse-export");
  const rolledBack = ownership("rollback", [
    "--export",
    reverseExport,
    "--runtime-binary",
    runtimeBinary,
    "--runtime-database",
    runtimeDatabase,
  ]);
  step(
    "the rollback handed the epoch back without accepting an export-only reversal",
    rolledBack.ownership?.owner === "CANVAS_OWNERSHIP_OWNER_RUNTIME" &&
      rolledBack.ownership?.phase === "CANVAS_OWNERSHIP_PHASE_SETTLED" &&
      rolledBack.ownership?.epoch === "3",
    `owner=${rolledBack.ownership?.owner} epoch=${rolledBack.ownership?.epoch}`,
  );
  const reverseChecks = Object.fromEntries(
    (rolledBack.report?.checks ?? []).map((check) => [
      check.check,
      check.matched === true,
    ]),
  );
  step(
    "the epoch moved on the Runtime's own re-read, not on the Host's word",
    reverseChecks["reverse.import"] === true &&
      reverseChecks["reverse.workspaces"] === true &&
      reverseChecks["reverse.unsupported_entity"] === true,
    Object.keys(reverseChecks).join(", "),
  );

  const index = JSON.parse(
    readFileSync(join(reverseExport, "export.json"), "utf8"),
  );
  const entries = readdirSync(reverseExport).sort();
  step(
    "the reverse export is a format version 2 package for the canvas domain",
    entries.length === 2 &&
      entries.includes("export.json") &&
      index.formatVersion === 2 &&
      index.domain === "canvas" &&
      index.epoch === 2 &&
      index.entityCount > 0 &&
      index.files?.length === 1,
    `${entries.join(", ")} epoch=${index.epoch} entities=${index.entityCount}`,
  );
  const mismatched = (index.files ?? []).filter((file) => {
    const payload = readFileSync(join(reverseExport, file.name));
    return payload.length !== file.bytes || sha256(payload) !== file.sha256;
  });
  step(
    "every digest in export.json describes the bytes actually on disk",
    (index.files ?? []).length > 0 && mismatched.length === 0,
    `${index.files?.[0]?.bytes} bytes sha256=${index.files?.[0]?.sha256?.slice(0, 16)}`,
  );
  // The canonical digest describes the records with the Host's own revisions
  // and asset references removed, which is why it cannot be the on-disk one.
  step(
    "each file also carries the canonical digest the Runtime is compared against",
    (index.files ?? []).length > 0 &&
      index.files.every(
        (file) =>
          /^[0-9a-f]{64}$/.test(file.contentSha256) &&
          file.contentSha256 !== file.sha256 &&
          file.entityCount === index.entityCount,
      ),
    `contentSha256=${index.files?.[0]?.contentSha256?.slice(0, 16)}`,
  );

  /* ------------------------------------------- 8. writes are the Runtime's */

  step(
    "the Runtime restarted after the reversal",
    await startRuntime(),
    runtimeOrigin,
  );
  const returned = await runtimeCall("GET", "/api/ownership");
  step(
    "the Runtime reports itself as the owner at the new epoch",
    returned.json?.owner === "runtime" && returned.json?.epoch === "3",
    `owner=${returned.json?.owner} epoch=${returned.json?.epoch} reason=${returned.json?.reasonCode}`,
  );
  // The point of the reverse import: what the Host wrote while it owned the
  // canvas is in the Runtime's own rows, not only in the package. The last Host
  // write is the second offline rename from the stream section above. The whole
  // document is compared, not just the renamed field, so a rollback that
  // brought the name back while dropping a node would fail here.
  const current = await runtimeCall("GET", documentPath);
  const restoredDigest = digestOf(runtimeShape(current.json ?? {}));
  step(
    "the Runtime reads back the edit the Host made while it owned the canvas",
    current.status === 200 &&
      current.json?.board?.name === "断线期间的第二次改动" &&
      restoredDigest ===
        digestOf({
          ...runtimeShape(reloaded.json ?? {}),
          name: "断线期间的第二次改动",
        }) &&
      restoredDigest !== runtimeDigest,
    `name=${current.json?.board?.name} sha256=${restoredDigest.slice(0, 16)} (pre-switch ${runtimeDigest.slice(0, 16)})`,
  );
  const rewritten = documentFor(canvasId, "回滚之后重新写入的正文");
  const rewrittenBoard = await runtimeCall("PUT", documentPath, {
    expectedUpdatedAt: current.json.board.updatedAt,
    ...rewritten,
    viewport: { x: 10, y: 10, zoom: 1 },
    whiteboard,
  });
  step(
    "a canvas write to the Runtime succeeds again",
    rewrittenBoard.status === 200,
    `HTTP ${rewrittenBoard.status}`,
  );
  const finalRead = await runtimeCall("GET", documentPath);
  const finalDigest = digestOf(runtimeShape(finalRead.json ?? {}));
  step(
    "the new content reads back, and is not the pre-switch document",
    finalRead.status === 200 &&
      finalDigest === digestOf(runtimeShape(rewrittenBoard.json)) &&
      finalDigest !== runtimeDigest,
    `sha256=${finalDigest.slice(0, 16)} (was ${runtimeDigest.slice(0, 16)})`,
  );
  const settled = ownership("status");
  step(
    "the Host's own record agrees that the Runtime writes again",
    settled.ownership?.owner === "CANVAS_OWNERSHIP_OWNER_RUNTIME" &&
      settled.ownership?.phase === "CANVAS_OWNERSHIP_PHASE_SETTLED" &&
      settled.ownership?.epoch === "3",
    `owner=${settled.ownership?.owner} epoch=${settled.ownership?.epoch} reason=${settled.ownership?.reasonCode}`,
  );

  /* ---------------------------------- 9. the same switch, over HTTPS */

  // Everything above moved the epoch with the Host stopped: the data directory
  // lock was the maintenance window. This section does it the other way round —
  // the Host serving, the switch arriving over HTTPS, and the window made of a
  // token issued at this machine over the same-user control channel. Only the
  // proof that someone is at the machine changes; the state machine does not.
  await stopRuntime();
  const secondExport = join(workspace, "export-2");
  const exportedAgain = JSON.parse(
    run(
      runtimeBinary,
      [
        "export",
        "--database",
        runtimeDatabase,
        "--destination",
        secondExport,
        "--output",
        "json",
      ],
      { env: runtimeEnv },
    ),
  );
  const importedAgain = JSON.parse(
    run(
      hostBinary,
      [
        "import",
        "--bundle",
        secondExport,
        "--data-dir",
        hostData,
        "--output",
        "json",
      ],
      { env: hostEnv },
    ),
  );
  step(
    "the post-rollback canvas exports and stages again",
    importedAgain.exportId === exportedAgain.exportId &&
      importedAgain.state === "staged",
    `importId=${importedAgain.importId?.slice(0, 8)} entities=${importedAgain.entityCount}`,
  );

  step(
    "the Host restarted with the Runtime database it may hand the epoch to",
    await startHost(),
    hostDiagnostics,
  );
  const onlineTicket = JSON.parse(
    run(
      hostBinary,
      [
        "pair",
        "--origin",
        appOrigin,
        "--device-name",
        "canvas-e2e-https",
        "--data-dir",
        hostData,
      ],
      { env: hostEnv },
    ),
  );
  const onlineHello = await canvasDriver.hello();
  step(
    "Hello advertises the ownership surface",
    onlineHello.capabilities?.includes("ownership.domains.v1") === true,
    onlineHello.capabilities?.join(", "),
  );
  await canvasDriver.pair(JSON.stringify(onlineTicket));
  await canvasDriver.connect(workspaceId);

  const listed = await canvasDriver.ownership("list", []);
  step(
    "the authenticated client is told which side writes each of the six domains",
    Array.isArray(listed) &&
      listed.length === 6 &&
      listed[0].domain === "canvas" &&
      listed[0].owner === "runtime" &&
      listed[0].epoch === 3n &&
      listed
        .slice(1)
        .every((entry) => entry.owner === "runtime" && entry.epoch === 1n),
    Array.isArray(listed)
      ? listed.map((entry) => `${entry.domain}=${entry.owner}`).join(" ")
      : refusal(listed),
  );

  const refusedWithoutWindow = await canvasDriver.ownership("switchDomain", [
    {
      domain: "canvas",
      target: "host",
      expectedEpoch: 3n,
      importId: importedAgain.importId,
      maintenanceToken: "0123456789abcdef0123456789abcdef",
    },
  ]);
  step(
    "a switch carrying a token this Host never issued is refused",
    refusedWithoutWindow.error?.failure === "permission",
    `${refusedWithoutWindow.error?.failure ?? "accepted"} HTTP ${refusedWithoutWindow.error?.httpStatus ?? 200}`,
  );

  // The token comes from the control channel, which only a same-user process on
  // this machine can reach. A browser cannot ask for one; an operator can.
  const window = JSON.parse(
    run(
      hostBinary,
      [
        "ownership",
        "window",
        "--domain",
        "canvas",
        "--data-dir",
        hostData,
        "--output",
        "json",
      ],
      { env: hostEnv },
    ),
  );
  step(
    "the control channel issued a maintenance window for the canvas domain",
    typeof window.token === "string" &&
      window.token.length === 64 &&
      window.domain === "canvas" &&
      Number(window.expiresAtUnixMs) > Date.now(),
    `expires in ${Math.round((Number(window.expiresAtUnixMs) - Date.now()) / 1000)}s`,
  );

  const switchedOnline = await canvasDriver.ownership("switchDomain", [
    {
      domain: "canvas",
      target: "host",
      expectedEpoch: 3n,
      importId: importedAgain.importId,
      maintenanceToken: window.token,
    },
  ]);
  step(
    "the HTTPS switch moved the epoch to the Host",
    switchedOnline.ownership?.owner === 2 &&
      switchedOnline.ownership?.epoch === 4n &&
      switchedOnline.report?.matched === true,
    `owner=${switchedOnline.ownership?.owner} epoch=${switchedOnline.ownership?.epoch}${refusal(switchedOnline)}`,
  );
  const replayedWindow = await canvasDriver.ownership("switchDomain", [
    {
      domain: "canvas",
      target: "runtime",
      expectedEpoch: 4n,
      maintenanceToken: window.token,
    },
  ]);
  step(
    "the same token cannot open a second window",
    replayedWindow.error?.failure === "permission",
    `${replayedWindow.error?.failure ?? "accepted"} HTTP ${replayedWindow.error?.httpStatus ?? 200}`,
  );

  step(
    "the Runtime restarted under the Host-owned epoch",
    await startRuntime(),
    runtimeOrigin,
  );
  const movedOnline = await runtimeCall("GET", "/api/ownership");
  step(
    "the Runtime agrees the Host owns the canvas at the epoch it was handed",
    movedOnline.json?.owner === "host" && movedOnline.json?.epoch === "4",
    `owner=${movedOnline.json?.owner} epoch=${movedOnline.json?.epoch}`,
  );
  const refusedOnline = await runtimeCall(
    "POST",
    `/api/workspaces/${workspaceId}/boards`,
    { name: "HTTPS 切换后不应创建" },
  );
  step(
    "the Runtime refuses canvas writes after the HTTPS switch, and still reads",
    refusedOnline.status === 409 &&
      refusedOnline.json?.code === "ownership_moved" &&
      (await runtimeCall("GET", documentPath)).status === 200,
    `HTTP ${refusedOnline.status} ${refusedOnline.json?.code}`,
  );

  // A change that exists only on the Host, so the reverse import below has
  // something the Runtime cannot already have.
  const onlineDocument = await canvasDriver.call("getDocument", [canvasId]);
  const onlineEdit = await canvasDriver.call("saveDocument", [
    {
      operationId: `canvas/${workspaceId}/${canvasId}/https-1`,
      canvas: { ...onlineDocument.canvas, name: "HTTPS 期间只在 Host 上改名" },
      expectedRevision: onlineDocument.canvas.revision,
      nodes: onlineDocument.nodes,
      edges: onlineDocument.edges,
      annotations: onlineDocument.annotations,
    },
  ]);
  step(
    "the Host accepted a write under the epoch it was handed over HTTPS",
    onlineEdit.document?.canvas?.name === "HTTPS 期间只在 Host 上改名" &&
      onlineEdit.document?.canvas?.revision ===
        onlineDocument.canvas.revision + 1n,
    `revision ${onlineDocument.canvas?.revision} → ${onlineEdit.document?.canvas?.revision}${refusal(onlineEdit)}`,
  );

  // Rolling back over HTTPS names no directory: a browser must not choose paths
  // on this machine, so the Host allocates one under its own data directory.
  // It is otherwise the same handback the CLI ran in section 7 — the package
  // goes to the Runtime, the Runtime re-reads its rows, and the epoch moves
  // only if the digests agree. No --accept-export-only anywhere.
  await stopRuntime();
  const rollbackWindow = JSON.parse(
    run(
      hostBinary,
      [
        "ownership",
        "window",
        "--domain",
        "canvas",
        "--data-dir",
        hostData,
        "--output",
        "json",
      ],
      { env: hostEnv },
    ),
  );
  const rolledBackOnline = await canvasDriver.ownership("switchDomain", [
    {
      domain: "canvas",
      target: "runtime",
      expectedEpoch: 4n,
      maintenanceToken: rollbackWindow.token,
    },
  ]);
  step(
    "the HTTPS rollback handed the epoch back to the Runtime",
    rolledBackOnline.ownership?.owner === 1 &&
      rolledBackOnline.ownership?.epoch === 5n,
    `owner=${rolledBackOnline.ownership?.owner} epoch=${rolledBackOnline.ownership?.epoch}${refusal(rolledBackOnline)}`,
  );
  const onlineChecks = Object.fromEntries(
    (rolledBackOnline.report?.checks ?? []).map((check) => [
      check.check,
      check.matched === true,
    ]),
  );
  step(
    "the HTTPS rollback moved the epoch on the Runtime's own re-read too",
    onlineChecks["reverse.import"] === true &&
      onlineChecks["reverse.workspaces"] === true &&
      onlineChecks["reverse.unsupported_entity"] === true,
    Object.keys(onlineChecks).join(", "),
  );
  const exportRoot = join(hostData, "ownership-exports");
  const packages = existsSync(exportRoot)
    ? readdirSync(exportRoot).filter((name) => name.startsWith("canvas-"))
    : [];
  const onlinePackage = packages.at(0);
  const onlineIndex = onlinePackage
    ? JSON.parse(
        readFileSync(join(exportRoot, onlinePackage, "export.json"), "utf8"),
      )
    : null;
  step(
    "the Host wrote its reverse export where it chose, not where a client asked",
    packages.length === 1 &&
      onlineIndex?.formatVersion === 2 &&
      onlineIndex?.domain === "canvas" &&
      onlineIndex?.epoch === 4 &&
      onlineIndex?.files?.length === 1 &&
      /^[0-9a-f]{64}$/.test(onlineIndex?.files?.[0]?.contentSha256 ?? ""),
    `${packages.join(", ")} epoch=${onlineIndex?.epoch}`,
  );

  step(
    "the Runtime restarted after the HTTPS reversal",
    await startRuntime(),
    runtimeOrigin,
  );
  // The whole point of doing this over HTTPS rather than with a danger switch:
  // what the Host wrote while it owned the canvas is in the Runtime's own rows.
  const afterHttpsRollback = await runtimeCall("GET", documentPath);
  step(
    "the Runtime reads back the edit the Host made under the HTTPS epoch",
    afterHttpsRollback.status === 200 &&
      afterHttpsRollback.json?.board?.name === "HTTPS 期间只在 Host 上改名",
    `name=${afterHttpsRollback.json?.board?.name} HTTP ${afterHttpsRollback.status}`,
  );
  const afterOnline = await runtimeCall(
    "POST",
    `/api/workspaces/${workspaceId}/boards`,
    { name: "HTTPS 回滚之后" },
  );
  step(
    "a canvas write to the Runtime succeeds again after the HTTPS rollback",
    afterOnline.status === 200,
    `HTTP ${afterOnline.status}`,
  );
  const finalDomains = await canvasDriver.ownership("list", []);
  step(
    "every domain reads back as the Runtime's, each on its own epoch",
    Array.isArray(finalDomains) &&
      finalDomains.every((entry) => entry.owner === "runtime") &&
      finalDomains[0].epoch === 5n &&
      finalDomains.slice(1).every((entry) => entry.epoch === 1n),
    Array.isArray(finalDomains)
      ? finalDomains.map((entry) => `${entry.domain}@${entry.epoch}`).join(" ")
      : refusal(finalDomains),
  );

  // The bundle the panel ships as still has to load on this origin. It is the
  // one check here that exercises the application rather than the protocol,
  // and it is what the web build above is for.
  if (!skipApplication) {
    const { targetId } = await devtoolsCall("Target.createTarget", {
      url: appOrigin,
    });
    const { sessionId } = await devtoolsCall("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    await devtoolsCall("Runtime.enable", {}, sessionId);
    await sleep(3000);
    const booted = await devtoolsCall(
      "Runtime.evaluate",
      {
        expression:
          "({ root: Boolean(document.querySelector('#root')?.children.length), title: document.title })",
        returnByValue: true,
      },
      sessionId,
    );
    step(
      "the built application boots on the temporary origin",
      booted.result?.value?.root === true,
      booted.result?.value?.title,
    );
    await devtoolsCall("Target.closeTarget", { targetId });
  }
} catch (error) {
  failures += 1;
  console.error(error);
} finally {
  try {
    socket?.close();
  } catch {}
  chrome?.kill("SIGTERM");
  await stopHost().catch(() => {});
  await stopRuntime().catch(() => {});
  // Give the browser and the two services a moment to release their files
  // before the temporary directory that holds all of them is removed.
  await sleep(500);
  teardown();
}

console.log(
  failures === 0
    ? `Canvas ownership end-to-end passed: ${results.length} checks${skipApplication ? " (browser half skipped)" : ""}.`
    : `Canvas ownership end-to-end failed: ${failures} of ${results.length} checks.`,
);
process.exit(failures === 0 ? 0 : 1);
