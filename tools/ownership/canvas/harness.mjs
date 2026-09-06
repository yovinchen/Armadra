// 画布所有权端到端检查的进程层：临时证书、把 /rpc 转给 Host 的同源代理、真实的
// Rust Runtime 与 Go Host，以及它们的启停与清理。这里没有任何一步断言——步骤在
// `canvas/stages/` 下，按阶段一个文件。
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import {
  createServer as createHttpServer,
  request as httpRequest,
} from "node:http";
import { createServer, request as httpsRequest } from "node:https";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("../../../", import.meta.url));
export const skipApplication = process.env.CANVAS_E2E_SKIP_APP === "1";
export const workspace = mkdtempSync(join(tmpdir(), "armadra-canvas-e2e-"));
export const cleanups = [];
export const results = [];
export let failures = 0;

export function step(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(
    `  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`,
  );
  if (!ok) failures += 1;
}

export function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: root,
    stdio: "pipe",
    encoding: "utf8",
    timeout: 900_000,
    ...options,
  });
}

/** Runs a command that is expected to fail, so the refusal can be asserted. */
export function tryRun(command, args, options = {}) {
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

export function pnpm(args) {
  const options = { stdio: "inherit" };
  if (/\.(?:c|m)?js$/i.test(process.env.npm_execpath ?? ""))
    return run(process.execPath, [process.env.npm_execpath, ...args], options);
  return run(process.platform === "win32" ? "pnpm.exe" : "pnpm", args, options);
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const sha256 = (value) =>
  createHash("sha256").update(value).digest("hex");

/**
 * Runs every registered cleanup once. Two processes, a TLS server, a browser
 * and a temporary directory outlive a crash otherwise, and an abandoned Host
 * keeps the data directory lock a later run would need.
 */
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

export const mediaTypes = {
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
export const distribution = join(root, "apps/web/dist");
export const driverFile = join(workspace, "driver.js");

export const appServer = createServer(credentials, (req, res) => {
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

export const runtimeBinary = join(
  root,
  "target",
  "debug",
  process.platform === "win32" ? "armadra-runtime.exe" : "armadra-runtime",
);
export const runtimeData = join(workspace, "runtime");
export const runtimeRoot = join(workspace, "project");
export const runtimeDatabase = join(runtimeData, "canvas.db");
mkdirSync(runtimeData, { recursive: true });
mkdirSync(runtimeRoot, { recursive: true });
export const runtimeEnv = {
  ...process.env,
  // Everything the Runtime persists — database, endpoints file, hook socket,
  // node tokens — is redirected here, so a check never touches the operator's
  // own data directory or the endpoints file a running Armadra publishes to.
  ARMADRA_DATA_DIR: runtimeData,
  ARMADRA_DATABASE_URL: `sqlite://${runtimeDatabase}?mode=rwc`,
  RUST_LOG: process.env.RUST_LOG ?? "warn",
};
export const endpointsFile = join(runtimeData, "endpoints.json");

export let runtime = null;
export let runtimeOrigin = "";
export let runtimeDiagnostics = "";

/**
 * Starts the Runtime on a kernel-assigned loopback port. The number is read
 * back from the endpoints file the Runtime publishes after it binds, which is
 * the only way to learn a `tcp:127.0.0.1:0` address; guessing a port here would
 * also risk colliding with a Runtime the operator is already running.
 */
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

/* ------------------------------------------------------------------ the Host */

export const hostBinary = join(
  root,
  "target",
  process.platform === "win32" ? "armadra-host.exe" : "armadra-host",
);
export const hostData = join(workspace, "host");
export const hostEnv = {
  ...process.env,
  // Never write into the operator's real keychain during a check.
  ARMADRA_GITHUB_SECRET_STORE: "file",
};
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

export function ownership(action, extra = []) {
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

/** `step` 之外的一笔失败：编排层捕获到异常时也要算进总数。 */
export function noteFailure() {
  failures += 1;
}
