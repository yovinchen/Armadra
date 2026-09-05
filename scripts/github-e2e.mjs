// End-to-end check for the GitHub surface (G04).
//
// Everything it talks to is local and temporary: a self-signed certificate, a
// mock GitHub over TLS, a real Host process on an ephemeral port with its own
// data directory, the Vite-built web bundle served from a throwaway HTTPS
// origin that proxies /rpc to the Host, and a headless Chrome with a fresh
// profile. Nothing reaches api.github.com, no real credential is used, and the
// Host is told to keep its secret in its own directory so the operator's
// keychain is never written.
//
// The proxy exists because the browser session transport requires the page and
// the Host to share an origin: cookies scoped to one origin are the point.
//
// What this covers: the whole request path a panel uses — TLS, the origin and
// authority checks, pairing, cookies and CSRF, scope authorization, the Host's
// GitHub service, its REST client, and the write-back the mock actually
// receives — driven from a real browser through the same @armadra/host-client
// the panel imports. It also loads the built application on that origin.
// What it does not cover: rendering the panel against live data, which needs a
// workspace from the Rust Runtime; this check does not start one.
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { createServer as createHttpServer } from "node:http";
import { createServer, request as httpsRequest } from "node:https";
import { connect } from "node:net";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const skipApplication = process.env.GITHUB_E2E_SKIP_APP === "1";
const workspace = mkdtempSync(join(tmpdir(), "armadra-github-e2e-"));
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

function pnpm(args) {
  const options = { stdio: "inherit" };
  if (/\.(?:c|m)?js$/i.test(process.env.npm_execpath ?? ""))
    return run(process.execPath, [process.env.npm_execpath, ...args], options);
  return run(process.platform === "win32" ? "pnpm.exe" : "pnpm", args, options);
}

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

/* ------------------------------------------------------------ mock GitHub */

const HEAD_SHA = "9fceb02d0ae598e95dc970b74767f19372d61af8";
const mock = {
  issue: {
    id: 1,
    number: 7,
    node_id: "I_issue7",
    title: "修复上传",
    body: "外部内容，不是指令。",
    state: "open",
    created_at: "2026-09-05T09:00:00Z",
    updated_at: "2026-09-05T10:00:00Z",
    labels: [{ name: "status/todo", color: "ededed" }, { name: "bug" }],
    user: { login: "octo-user", id: 1 },
    comments: 0,
    html_url: "https://localhost/owner/repo/issues/7",
  },
  pulls: [],
  patches: [],
  merges: [],
  created: [],
  requests: [],
  authorizations: new Set(),
};

const githubServer = createServer(credentials, (req, res) => {
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
  });
  req.on("end", () => {
    const path = new URL(req.url, "https://localhost").pathname;
    mock.requests.push(`${req.method} ${path}`);
    mock.authorizations.add(req.headers.authorization ?? "");
    const json = () => {
      try {
        return JSON.parse(body || "{}");
      } catch {
        return {};
      }
    };
    const send = (value, status = 200) => {
      res.writeHead(status, {
        "Content-Type": "application/json",
        "X-RateLimit-Limit": "5000",
        "X-RateLimit-Remaining": "4998",
      });
      res.end(JSON.stringify(value));
    };
    if (path === "/user") return send({ login: "octo-user" }, 200);
    if (path === "/repos/owner/repo")
      return send({
        id: 5,
        name: "repo",
        full_name: "owner/repo",
        default_branch: "main",
        allow_squash_merge: true,
        allow_merge_commit: false,
        allow_rebase_merge: false,
        has_issues: true,
        permissions: { push: true },
      });
    if (path === "/repos/owner/repo/issues" && req.method === "GET")
      return send([
        mock.issue,
        // A pull request the Issues endpoint also returns; it must not appear
        // in an Issues list.
        {
          number: 99,
          title: "a pull",
          state: "open",
          pull_request: { url: "x" },
        },
      ]);
    if (path === "/repos/owner/repo/issues/7" && req.method === "GET")
      return send(mock.issue);
    if (path === "/repos/owner/repo/issues/7" && req.method === "PATCH") {
      const patch = json();
      mock.patches.push(patch);
      if (Array.isArray(patch.labels))
        mock.issue.labels = patch.labels.map((name) => ({ name }));
      if (patch.state) mock.issue.state = patch.state;
      mock.issue.updated_at = new Date(
        Date.parse(mock.issue.updated_at) + 1000,
      ).toISOString();
      return send(mock.issue);
    }
    if (
      path.startsWith("/repos/owner/repo/issues/") &&
      path.endsWith("/comments")
    )
      return send(req.method === "GET" ? [] : { id: 11, body: json().body });
    if (path === "/repos/owner/repo/pulls" && req.method === "GET")
      return send(mock.pulls);
    if (path === "/repos/owner/repo/pulls" && req.method === "POST") {
      const input = json();
      mock.created.push(input);
      mock.pulls = [
        {
          id: 2,
          number: 9,
          title: input.title,
          body: input.body ?? "",
          state: "open",
          draft: Boolean(input.draft),
          mergeable: true,
          mergeable_state: "clean",
          base: { ref: input.base },
          head: {
            ref: input.head,
            sha: HEAD_SHA,
            repo: { full_name: "owner/repo" },
          },
          user: { login: "octo-user" },
          created_at: "2026-09-05T10:30:00Z",
          updated_at: "2026-09-05T10:30:00Z",
          additions: 2,
          deletions: 1,
          changed_files: 1,
          commits: 1,
        },
      ];
      return send(mock.pulls[0], 201);
    }
    if (path === "/repos/owner/repo/pulls/9" && req.method === "GET")
      return send(mock.pulls[0] ?? {});
    if (path === "/repos/owner/repo/pulls/9/files")
      return send([
        {
          filename: "a.txt",
          status: "modified",
          additions: 2,
          deletions: 1,
          patch: "@@",
        },
      ]);
    if (path === "/repos/owner/repo/pulls/9/reviews" && req.method === "GET")
      return send([]);
    if (path === "/repos/owner/repo/pulls/9/comments") return send([]);
    if (path === "/repos/owner/repo/pulls/9/merge" && req.method === "PUT") {
      const input = json();
      mock.merges.push(input);
      if (input.sha !== HEAD_SHA) return send({ merged: false }, 409);
      mock.pulls[0].state = "closed";
      mock.pulls[0].merged = true;
      mock.pulls[0].merged_at = "2026-09-05T11:00:00Z";
      return send({ merged: true, sha: "1".repeat(40) });
    }
    if (path.includes("/commits/") && path.endsWith("/check-runs"))
      return send({
        check_runs: [
          {
            name: "build",
            status: "completed",
            conclusion: "success",
            app: { name: "GitHub Actions", slug: "github-actions" },
            details_url: "https://localhost/actions/runs/77/job/1",
          },
        ],
      });
    if (path.includes("/commits/") && path.endsWith("/status"))
      return send({ statuses: [] });
    if (path.startsWith("/repos/owner/repo/git/ref/heads/"))
      return send({ object: { sha: HEAD_SHA } });
    return send({ message: "not found" }, 404);
  });
});
githubServer.listen(0, "127.0.0.1");
await once(githubServer, "listening");
const githubPort = githubServer.address().port;
const githubBase = `https://localhost:${githubPort}`;
cleanups.push(() => githubServer.close());

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

/* ---------------------------------------------------------------- the Host */

const hostBinary = join(
  root,
  "target",
  process.platform === "win32" ? "armadra-host.exe" : "armadra-host",
);
const dataDirectory = join(workspace, "host");
const hostEnv = {
  ...process.env,
  GITHUB_API_BASE: githubBase,
  GITHUB_CA_FILE: certFile,
  // Never write into the operator's real keychain during a check.
  ARMADRA_GITHUB_SECRET_STORE: "file",
};

async function waitForHost() {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const reachable = await new Promise((resolve) => {
      const socket = connect(hostPort, "127.0.0.1");
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });
    if (reachable) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
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
function driver(socket) {
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

/* --------------------------------------------------------------------- run */

let host, chrome, socket;
try {
  console.log("Building the Host binary, the client and the web bundle…");
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
  pnpm(["--filter", "@armadra/shared", "build"]);
  pnpm(["--filter", "@armadra/protocol", "build"]);
  pnpm(["--filter", "@armadra/host-client", "build"]);
  // The application build is skippable so the Host path can be checked while
  // the front end is mid-change; the boot check below is skipped with it, and
  // the summary says so rather than implying it ran.
  if (!skipApplication) pnpm(["--filter", "@armadra/web", "build"]);

  // The browser drives the very client the panel imports, bundled for the page.
  // Reimplementing the wire format here would prove nothing about the client.
  const driverSource = join(workspace, "driver-source.mjs");
  writeFileSync(
    driverSource,
    `import {
  create,
  GithubExternalReferenceSchema, GithubRepositoryRefSchema, GithubStatusMappingSchema,
} from "@armadra/protocol";
import {
  HostClient, HostIdentityClient, HostGithubClient,
  GithubCredentialSource, GithubIssueState, GithubMergeMethod,
  GithubReferenceKind, GithubReferenceTargetKind, GithubStatusSource,
} from "@armadra/host-client";
const state = {};
function serialize(value) {
  return JSON.parse(JSON.stringify(value, (key, item) =>
    typeof item === "bigint" ? item.toString() : item));
}
globalThis.armadra = {
  async hello(origin) {
    state.hello = await new HostClient({ baseUrl: origin, clientId: "github-e2e" }).hello();
    return serialize(state.hello);
  },
  async identity(origin) {
    state.identity = new HostIdentityClient({
      baseUrl: origin,
      hostId: state.hello.hostId,
      hostInstanceId: state.hello.hostInstanceId,
    });
    // Built before pairing on purpose: an unpaired device must be refused by
    // the Host, not by the client declining to make the call.
    state.github = new HostGithubClient({
      session: state.identity,
      hostId: state.hello.hostId,
      workspaceId: "workspace-1",
    });
    return true;
  },
  async pair(material) {
    return serialize(await state.identity.pair(material));
  },
  call(method, ...args) {
    return state.github[method](...args).then(serialize, (error) => ({
      error: { failure: error.failure ?? error.code ?? "unknown", outcomeUnknown: error.outcomeUnknown === true },
    }));
  },
  repository(owner, name, apiBase, host) {
    state.repository = create(GithubRepositoryRefSchema, { owner, name, apiBase, host });
    return serialize(state.repository);
  },
  get repositoryRef() { return state.repository; },
  enums: {
    source: GithubCredentialSource,
    issueState: GithubIssueState,
    mergeMethod: GithubMergeMethod,
    referenceKind: GithubReferenceKind,
    targetKind: GithubReferenceTargetKind,
    statusSource: GithubStatusSource,
  },
  schemas: { mapping: GithubStatusMappingSchema, reference: GithubExternalReferenceSchema },
  create,
};
globalThis.armadraReady = true;
`,
  );
  run(
    join(
      root,
      "node_modules/.pnpm/esbuild@0.28.2/node_modules/esbuild/bin/esbuild",
    ),
    [
      driverSource,
      "--bundle",
      "--format=esm",
      "--platform=browser",
      // The driver lives in a temporary directory, so the workspace packages
      // are named explicitly rather than resolved through node_modules.
      `--alias:@armadra/protocol=${join(root, "packages/protocol-ts/dist/index.js")}`,
      `--alias:@armadra/host-client=${join(root, "packages/host-client/dist/index.js")}`,
      `--outfile=${driverFile}`,
      "--log-level=error",
    ],
    { stdio: "inherit" },
  );

  appServer.listen(appPort, "127.0.0.1");
  await once(appServer, "listening");
  cleanups.push(() => appServer.close());

  console.log(`Starting the Host on 127.0.0.1:${hostPort} for ${appOrigin}…`);
  host = spawn(
    hostBinary,
    [
      "serve",
      "--listen",
      `127.0.0.1:${hostPort}`,
      "--data-dir",
      dataDirectory,
      "--tls-cert",
      certFile,
      "--tls-key",
      keyFile,
      "--public-origin",
      appOrigin,
    ],
    { cwd: root, stdio: ["ignore", "pipe", "pipe"], env: hostEnv },
  );
  let diagnostics = "";
  host.stderr.on("data", (chunk) => {
    diagnostics = (diagnostics + chunk).slice(-4096);
  });
  host.stdout.on("data", () => {});
  cleanups.push(() => host.kill("SIGTERM"));
  step(
    "the Host started on a temporary TLS port",
    await waitForHost(),
    diagnostics,
  );

  const ticket = JSON.parse(
    run(
      hostBinary,
      [
        "pair",
        "--origin",
        appOrigin,
        "--device-name",
        "github-e2e",
        "--data-dir",
        dataDirectory,
      ],
      { env: hostEnv },
    ),
  );
  step("the Host issued a pairing ticket", typeof ticket.ticket === "string");

  chrome = spawn(
    await browserPath(),
    [
      "--headless=new",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      `--user-data-dir=${join(workspace, "chrome-profile")}`,
      "--remote-debugging-port=0",
      // The certificate exists only for this run and never leaves the temporary
      // directory; a private trust store would add nothing.
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
  const call = driver(socket);

  async function attach(url) {
    const { targetId } = await call("Target.createTarget", { url });
    const { sessionId } = await call("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    await call("Page.enable", {}, sessionId);
    await call("Runtime.enable", {}, sessionId);
    return { targetId, sessionId };
  }

  async function evaluate(sessionId, expression) {
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
  }

  const page = await attach(`${appOrigin}/e2e/`);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (
      await evaluate(page.sessionId, "return globalThis.armadraReady === true;")
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const ready = await evaluate(
    page.sessionId,
    "return globalThis.armadraReady === true;",
  );
  step("the browser loaded the real host-client bundle", ready === true);

  const hello = await evaluate(
    page.sessionId,
    `return await armadra.hello(${JSON.stringify(appOrigin)});`,
  );
  step(
    "Hello advertises the GitHub capability through the proxied origin",
    hello.capabilities.includes("github.issues.v1") &&
      hello.capabilities.includes("identity.browser-session.v1"),
    hello.capabilities.join(", "),
  );

  await evaluate(
    page.sessionId,
    `return await armadra.identity(${JSON.stringify(appOrigin)});`,
  );
  const unauthenticated = await evaluate(
    page.sessionId,
    `return await armadra.call("getCredential");`,
  );
  step(
    "an unpaired device cannot read the credential status",
    unauthenticated?.error?.failure === "unauthenticated",
    JSON.stringify(unauthenticated?.error ?? unauthenticated),
  );

  const session = await evaluate(
    page.sessionId,
    `return await armadra.pair(${JSON.stringify(JSON.stringify(ticket))});`,
  );
  const scopes = (session.scopes ?? []).map((scope) => scope.permission);
  step(
    "pairing produced a session holding the GitHub scopes",
    scopes.includes("github:read") && scopes.includes("github:write"),
  );

  const before = await evaluate(
    page.sessionId,
    `return await armadra.call("getCredential");`,
  );
  step(
    "an unconfigured Host reports NOT_CONFIGURED rather than looking usable",
    before.available === false && before.reasonCode === "NOT_CONFIGURED",
    JSON.stringify({
      available: before.available,
      reasonCode: before.reasonCode,
    }),
  );

  const configured = await evaluate(
    page.sessionId,
    `return await armadra.call("configureCredential", {
       source: armadra.enums.source.TOKEN_REF,
       token: "gho_EndToEndMockTokenNotReal00000",
       apiBase: ${JSON.stringify(githubBase)},
       expectedRevision: 0n,
     });`,
  );
  step(
    "configuring a pasted token verifies it and reports the account",
    configured.available === true && configured.accountLogin === "octo-user",
    JSON.stringify({
      store: configured.store,
      enterprise: configured.enterprise,
      apiBase: configured.apiBase,
    }),
  );
  step(
    "the status names the degraded file store rather than implying a keychain",
    configured.store === 3,
    `store=${configured.store}`,
  );
  step(
    "no response ever carried the token",
    !JSON.stringify(configured).includes("gho_EndToEndMockTokenNotReal00000"),
  );

  const foreign = await evaluate(
    page.sessionId,
    `return await armadra.call("resolveRepository", "https://github.com/owner/repo.git");`,
  );
  step(
    "a public remote is refused against the enterprise base, with no request",
    foreign.hostMismatch === true && !foreign.repository,
    foreign.reasonCode,
  );

  await evaluate(
    page.sessionId,
    `armadra.repository("owner", "repo", ${JSON.stringify(githubBase)}, "localhost"); return true;`,
  );
  const resolved = await evaluate(
    page.sessionId,
    `return await armadra.call("resolveRepository", ${JSON.stringify(`${githubBase}/owner/repo.git`)});`,
  );
  step(
    "the configured base resolves the repository and only its allowed merge method",
    resolved?.repository?.allowedMergeMethods?.length === 1 &&
      resolved.repository.allowedMergeMethods[0] === 2,
    JSON.stringify(resolved?.repository?.allowedMergeMethods ?? resolved),
  );

  const mapping = await evaluate(
    page.sessionId,
    `return await armadra.call("putStatusMapping", {
       mapping: armadra.create(armadra.schemas.mapping, {
         repository: armadra.repositoryRef,
         source: armadra.enums.statusSource.LABEL,
         groups: [
           { id: "todo", title: "待办", label: "status/todo" },
           { id: "done", title: "完成", label: "status/done" },
         ],
       }),
       expectedRevision: 0n,
     });`,
  );
  step(
    "a label status mapping was stored",
    mapping.revision === "1",
    JSON.stringify(mapping.revision),
  );

  const listed = await evaluate(
    page.sessionId,
    `return await armadra.call("listIssues", { repository: armadra.repositoryRef });`,
  );
  step(
    "the mock's Issues are listed, grouped, and free of pull requests",
    listed.issues?.length === 1 &&
      listed.issues[0].number === "7" &&
      listed.issues[0].statusGroupId === "todo",
    JSON.stringify(
      listed.issues?.map((issue) => [issue.number, issue.statusGroupId]),
    ),
  );
  step(
    "the Host names its own poll interval, since it has no webhook",
    listed.pollIntervalMs === "30000",
    String(listed.pollIntervalMs),
  );

  const moved = await evaluate(
    page.sessionId,
    `return await armadra.call("moveIssue", {
       repository: armadra.repositoryRef,
       number: 7n,
       toGroupId: "done",
       fromGroupId: "todo",
       expectedUpdatedAtUnixMs: ${Date.parse(mock.issue.updated_at)}n,
       expectedMappingRevision: 1n,
     });`,
  );
  step(
    "Move to… reported an applied write",
    moved.outcomes?.length === 1 && moved.outcomes[0].state === 1,
    JSON.stringify(moved.outcomes),
  );
  const patch = mock.patches.at(-1) ?? {};
  step(
    "the mock received the write-back with unmanaged labels preserved",
    Array.isArray(patch.labels) &&
      patch.labels.includes("bug") &&
      patch.labels.includes("status/done") &&
      !patch.labels.includes("status/todo"),
    JSON.stringify(patch.labels),
  );
  step(
    "the move did not close the Issue, because no coupling was configured",
    patch.state === undefined,
  );

  const created = await evaluate(
    page.sessionId,
    `return await armadra.call("createPull", {
       repository: armadra.repositoryRef,
       baseRef: "main",
       headRef: "feature/upload",
       title: "feat: 上传",
       body: "正文",
       expectedHeadSha: ${JSON.stringify(HEAD_SHA)},
     });`,
  );
  step(
    "a pull request was created against the checked head",
    created.number === "9" && created.headSha === HEAD_SHA,
    JSON.stringify({ number: created.number, headSha: created.headSha }),
  );
  step("the mock recorded the created pull request", mock.created.length === 1);

  const detail = await evaluate(
    page.sessionId,
    `return await armadra.call("getPull", { repository: armadra.repositoryRef, number: 9n });`,
  );
  step(
    "the detail's checks describe exactly the head it reports",
    detail.checks?.headSha === detail.pull?.headSha &&
      detail.checks?.rollup === 2,
    JSON.stringify({
      head: detail.pull?.headSha,
      checks: detail.checks?.headSha,
      rollup: detail.checks?.rollup,
    }),
  );

  const stale = await evaluate(
    page.sessionId,
    `return await armadra.call("mergePull", {
       repository: armadra.repositoryRef,
       number: 9n,
       expectedHeadSha: ${JSON.stringify("0".repeat(40))},
       method: armadra.enums.mergeMethod.SQUASH,
     });`,
  );
  step(
    "a merge naming a head that moved is refused with a reason",
    stale.merged === false && stale.reasonCode === "HEAD_MOVED",
    stale.reasonCode,
  );
  step("the refused merge never reached the mock", mock.merges.length === 0);

  const wrongMethod = await evaluate(
    page.sessionId,
    `return await armadra.call("mergePull", {
       repository: armadra.repositoryRef,
       number: 9n,
       expectedHeadSha: ${JSON.stringify(HEAD_SHA)},
       method: armadra.enums.mergeMethod.MERGE,
     });`,
  );
  step(
    "a method this repository disallows is refused before anything is sent",
    wrongMethod.merged === false &&
      wrongMethod.reasonCode === "METHOD_NOT_ALLOWED",
    wrongMethod.reasonCode,
  );

  const merged = await evaluate(
    page.sessionId,
    `return await armadra.call("mergePull", {
       repository: armadra.repositoryRef,
       number: 9n,
       expectedHeadSha: ${JSON.stringify(HEAD_SHA)},
       method: armadra.enums.mergeMethod.SQUASH,
       expectedCheckRollup: 2,
       commitTitle: "feat: 上传",
     });`,
  );
  step(
    "the merge succeeded with the expected head",
    merged.merged === true,
    merged.mergeSha,
  );
  step(
    "the mock received exactly the head the caller named",
    mock.merges.length === 1 &&
      mock.merges[0].sha === HEAD_SHA &&
      mock.merges[0].merge_method === "squash",
    JSON.stringify(mock.merges[0]),
  );

  const linked = await evaluate(
    page.sessionId,
    `return await armadra.call("linkReference", {
       reference: armadra.create(armadra.schemas.reference, {
         repository: armadra.repositoryRef,
         kind: armadra.enums.referenceKind.PULL_REQUEST,
         number: 9n,
         targetKind: armadra.enums.targetKind.WORKTREE,
         targetId: "worktree-upload",
         title: "feat: 上传",
       }),
       expectedRevision: 0n,
     });`,
  );
  step(
    "an external reference was linked",
    linked.revision === "1",
    JSON.stringify(linked.referenceId),
  );
  const duplicate = await evaluate(
    page.sessionId,
    `return await armadra.call("linkReference", {
       reference: armadra.create(armadra.schemas.reference, {
         repository: armadra.repositoryRef,
         kind: armadra.enums.referenceKind.PULL_REQUEST,
         number: 9n,
         targetKind: armadra.enums.targetKind.WORKTREE,
         targetId: "worktree-upload",
         title: "feat: 上传",
       }),
       expectedRevision: 0n,
     });`,
  );
  step(
    "linking the same pair twice is one badge, reported as a conflict",
    duplicate?.error?.failure === "conflict",
    JSON.stringify(duplicate?.error),
  );

  step(
    "every request the mock saw carried a bearer credential",
    [...mock.authorizations].every((value) => value.startsWith("Bearer ")),
    `${mock.requests.length} requests`,
  );

  await call("Target.closeTarget", { targetId: page.targetId });

  // The built application must load on this origin and, with no workspace,
  // say so rather than showing controls that would fail.
  if (skipApplication) {
    console.log("  skip  application boot (GITHUB_E2E_SKIP_APP=1)");
  } else {
    const application = await attach(appOrigin);
    await evaluate(
      application.sessionId,
      `localStorage.setItem("armadra.host-check.address.v1", ${JSON.stringify(appOrigin)}); return true;`,
    );
    await call("Page.reload", {}, application.sessionId);
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const booted = await evaluate(
      application.sessionId,
      `return { root: Boolean(document.querySelector("#root")?.children.length), title: document.title };`,
    );
    step(
      "the built application boots on the temporary origin",
      booted.root === true,
      booted.title,
    );
    await call("Target.closeTarget", { targetId: application.targetId });
  }
} catch (error) {
  failures += 1;
  console.error(error);
} finally {
  try {
    socket?.close();
  } catch {}
  for (const cleanup of cleanups.reverse()) {
    try {
      cleanup();
    } catch {}
  }
  try {
    run(hostBinary, ["stop", "--data-dir", dataDirectory], { env: hostEnv });
  } catch {}
  await new Promise((resolve) => setTimeout(resolve, 500));
  rmSync(workspace, { recursive: true, force: true });
}

console.log(
  failures === 0
    ? `GitHub end-to-end passed: ${results.length} checks.`
    : `GitHub end-to-end failed: ${failures} of ${results.length} checks.`,
);
process.exit(failures === 0 ? 0 : 1);
