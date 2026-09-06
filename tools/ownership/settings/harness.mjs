// 设置域端到端检查的进程与传输层：证书、同源代理、真实 Runtime 与 Go Host、
// 浏览器形状的传输、事件流客户端，以及文档摘要。这里没有任何一步断言——步骤在
// `settings/stages/` 下，按阶段一个文件。
//
// `tools/ownership-harness.mjs` 是后来写的同类层，但它把 Host 自己的 TLS 端口
// 当作公共源，而这个场景要的是一个独立的同源代理，所以两者暂时并存。
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
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("../../../", import.meta.url));

export const domain = "settings";

export const workspace = mkdtempSync(join(tmpdir(), "armadra-ownership-e2e-"));
export const cleanups = [];
export const results = [];
export let failures = 0;

export function step(name, ok, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures += 1;
  const mark = ok ? "  ok  " : " FAIL ";
  console.log(`${mark}${name}${detail ? `  — ${detail}` : ""}`);
}

export function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 << 20,
    ...options,
  });
}

/** Runs a command that is expected to fail, so the refusal can be asserted. */
export function tryRun(command, args, options = {}) {
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

export function pnpm(args) {
  if (/\.(?:c|m)?js$/i.test(process.env.npm_execpath ?? "")) {
    return run(process.execPath, [process.env.npm_execpath, ...args], {
      stdio: "inherit",
    });
  }
  return run(process.platform === "win32" ? "pnpm.exe" : "pnpm", args, {
    stdio: "inherit",
  });
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const sha256 = (value) =>
  createHash("sha256").update(value).digest("hex");

export let cleaned = false;
export function teardown() {
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
export async function freePort() {
  const probe = createHttpServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  if ([1420, 1421, 43120, 43121].includes(port)) return freePort();
  return port;
}

/* ------------------------------------------------------------- certificate */

export const tlsDirectory = join(workspace, "tls");
mkdirSync(tlsDirectory, { recursive: true });
export const certFile = join(tlsDirectory, "cert.pem");
export const keyFile = join(tlsDirectory, "key.pem");
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
export const credentials = {
  cert: readFileSync(certFile),
  key: readFileSync(keyFile),
};

/* ---------------------------------------------------- app origin and proxy */

export const appPort = await freePort();
export const hostPort = await freePort();
export const appOrigin = `https://localhost:${appPort}`;

// The proxy exists because the browser session transport requires the page and
// the Host to share an origin: cookies scoped to one origin are the point. The
// Host header is forwarded unchanged so the Host still sees its own public
// origin; rewriting it would defeat the check being exercised.
export const appServer = createServer(credentials, (req, res) => {
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

export const runtimeBinary = join(
  root,
  "target",
  "debug",
  process.platform === "win32" ? "armadra-runtime.exe" : "armadra-runtime",
);
export const runtimeData = join(workspace, "runtime");
export const runtimeRoot = join(workspace, "project");
export const runtimeDatabase = join(runtimeData, "canvas.db");
export const runtimeSettings = join(runtimeData, "settings.json");
mkdirSync(runtimeData, { recursive: true });
mkdirSync(runtimeRoot, { recursive: true });
export const runtimeEnv = {
  ...process.env,
  ARMADRA_DATA_DIR: runtimeData,
  ARMADRA_DATABASE_URL: `sqlite://${runtimeDatabase}?mode=rwc`,
  RUST_LOG: process.env.RUST_LOG ?? "warn",
};
export const endpointsFile = join(runtimeData, "endpoints.json");

export let runtime = null;
export let runtimeOrigin = "";
export let runtimeDiagnostics = "";

export async function startRuntime() {
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

export async function stopRuntime() {
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

export function runtimeCall(method, path, body) {
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

export const hostBinary = join(
  root,
  "target",
  process.platform === "win32" ? "armadra-host.exe" : "armadra-host",
);
export const hostData = join(workspace, "host");
export const hostEnv = { ...process.env, ARMADRA_GITHUB_SECRET_STORE: "file" };
export let host = null;
export let hostDiagnostics = "";

export async function startHost() {
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
export async function stopHost() {
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

export function ownershipCli(action, extra = []) {
  return run(
    hostBinary,
    ["ownership", action, "--data-dir", hostData, "--output", "json", ...extra],
    { env: hostEnv },
  );
}

/** The Runtime binary and database every non-read ownership command needs. */
export const runtimeTarget = [
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
export function nodeTransport(jar) {
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

export const streamGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** One masked client frame. Server frames are never masked; client ones must be. */
export function writeStreamFrame(socket, opcode, payload) {
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
export async function openHostStream(protocol, jar) {
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
 * The dotted paths that stay on this execution host (§1.4). Read from the
 * Runtime rather than listed here: it is the side that enforces the split, and
 * a second list would be the e2e agreeing with itself.
 */
export let localSettingPaths = [];

export async function loadLocalSettingPaths() {
  const answer = await runtimeCall("GET", "/api/settings/local");
  localSettingPaths = answer.json?.paths ?? [];
  return localSettingPaths;
}

/**
 * The document the Runtime writes, reduced to what both sides must agree on.
 *
 * Timestamps and revisions are deliberately absent: they are the two things the
 * design says legitimately differ between a Runtime that stamps `updatedAt` and
 * a Host that counts revisions (§6.3).
 *
 * So are the local settings. `GET /api/settings` answers with both halves
 * merged, but only the account's half is ever stored on the Host or written to
 * `settings.json`, and `worker-settings.json` deliberately stays behind when
 * the domain moves. Comparing the merged answer against either of those would
 * be comparing a document against a different document — which is exactly what
 * the `settings.local_split` check exists to make visible rather than hide.
 */
export function settingsShape(document) {
  const copy = JSON.parse(JSON.stringify(document ?? {}));
  for (const path of localSettingPaths) prune(copy, path.split("."));
  return stable(copy);
}

/** Delete one dotted path, and any section it leaves empty. */
function prune(node, segments) {
  if (!node || typeof node !== "object") return;
  const [head, ...rest] = segments;
  if (rest.length === 0) {
    delete node[head];
    return;
  }
  prune(node[head], rest);
  if (
    node[head] &&
    typeof node[head] === "object" &&
    !Array.isArray(node[head]) &&
    Object.keys(node[head]).length === 0
  ) {
    delete node[head];
  }
}

export function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = stable(value[key]);
    return out;
  }
  return value;
}

export const digestOf = (value) => sha256(JSON.stringify(value));

/** The bytes on disk, which is what every digest across the switch is over. */
export function settingsFileDigest() {
  return existsSync(runtimeSettings)
    ? sha256(readFileSync(runtimeSettings))
    : "";
}

/** `step` 之外的一笔失败：编排层捕获到异常时也要算进总数。 */
export function noteFailure() {
  failures += 1;
}

/** The Host's own refusal, appended to a step's detail when there was one. */
export function refusal(answer) {
  return answer?.error
    ? ` (${answer.error.failure} HTTP ${answer.error.httpStatus} ${answer.error.hostCode})`
    : "";
}
