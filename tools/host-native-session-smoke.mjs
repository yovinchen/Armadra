// The desktop shell's native Host session, end to end against a real Go Host
// (docs/design/host-native-session.md §5). The shell itself is stood in for
// by the same CLI call it makes: `armadra-host pair` over the private control
// channel. Proves that a native origin plus that ticket buys a bearer session
// which a permissioned method answers, that a browser origin cannot spend the
// same ticket, that the ticket cannot be spent twice, and that nothing
// authenticates on the native origin without a bearer.
//
// A shell origin is no longer one fixed spelling: the Electron shell serves
// its page over loopback HTTP on a kernel-assigned port
// (docs/design/electron-migration.md §2.1), so the same ticket flow is proved
// a second time for `http://127.0.0.1:NNNN`, over raw requests because the
// host-client transport still spells out the Tauri origins.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), "armadra-native-session-"));
const dataDir = join(temporary, "host");
const cache = join(root, "target", "protocol-go");
mkdirSync(cache, { recursive: true });
const env = {
  ...process.env,
  GOCACHE: process.env.GOCACHE ?? join(cache, "build"),
  GOMODCACHE: process.env.GOMODCACHE ?? join(cache, "mod"),
  GOPATH: process.env.GOPATH ?? join(cache, "path"),
};
// A private output path: this probe never touches the sidecar staging area.
const binary = join(
  root,
  "target",
  "native-session-smoke",
  process.platform === "win32" ? "armadra-host.exe" : "armadra-host",
);
const NATIVE = "tauri://localhost";
// A real browser origin: off this machine, so never a shell origin however
// explicitly it is allowed. A loopback HTTP origin is a shell origin now.
const BROWSER = "https://armadra.example";
const MEDIA = "application/x-protobuf";

/** The port the Electron shell's static server would have been given. */
async function freeLoopbackOrigin() {
  const probe = createServer();
  const port = await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => resolve(probe.address().port));
  });
  await new Promise((resolve) => probe.close(resolve));
  return `http://127.0.0.1:${port}`;
}
const ELECTRON = await freeLoopbackOrigin();

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: root,
    env,
    stdio: "inherit",
    timeout: 300_000,
    ...options,
  });
}
function pnpm(args) {
  if (/\.(?:c|m)?js$/i.test(process.env.npm_execpath ?? ""))
    return run(process.execPath, [process.env.npm_execpath, ...args]);
  return run(process.platform === "win32" ? "pnpm.exe" : "pnpm", args);
}

let host = null;
async function startHost() {
  const child = spawn(
    binary,
    [
      "serve",
      "--data-dir",
      dataDir,
      "--listen",
      "127.0.0.1:0",
      "--allow-origin",
      NATIVE,
      "--allow-origin",
      ELECTRON,
      "--allow-origin",
      BROWSER,
    ],
    { cwd: root, env, stdio: ["ignore", "pipe", "inherit"] },
  );
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const endpoint = await new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(
      () => reject(new Error("Host did not report its listener")),
      30_000,
    );
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      const match = output.match(/Armadra listening on (http:\/\/[^\s]+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    exited.then(() => {
      clearTimeout(timer);
      reject(new Error("Host exited before listening"));
    });
  });
  return { child, exited, endpoint };
}
async function stopHost() {
  if (!host) return;
  host.child.kill("SIGTERM");
  await Promise.race([
    host.exited,
    new Promise((resolve) => setTimeout(resolve, 10_000)),
  ]);
  host = null;
}

/** A fetch that speaks as one page origin, the way a WebView would. */
function fetchAs(origin) {
  return (url, init = {}) =>
    fetch(url, {
      ...init,
      headers: { ...(init.headers ?? {}), Origin: origin },
    });
}

try {
  mkdirSync(dirname(binary), { recursive: true });
  run("go", ["-C", "apps/host", "build", "-o", binary, "./cmd/armadra-host"]);
  pnpm(["--filter", "@armadra/host-client...", "build"]);
  const protocol = await import("../packages/protocol/dist/index.js");
  const { HostClient, HostIdentityClient, HostNativeCredentials } =
    await import("../packages/host-client/dist/index.js");
  const {
    create,
    toBinary,
    fromBinary,
    PairDeviceRequestSchema,
    CurrentSessionRequestSchema,
    AuthenticatedSessionSchema,
    ErrorResponseSchema,
  } = protocol;

  host = await startHost();
  const { endpoint } = host;
  const status = JSON.parse(
    execFileSync(binary, ["status", "--data-dir", dataDir], {
      env,
      encoding: "utf8",
      timeout: 10_000,
    }),
  );
  assert.equal(status.state, "running");
  assert.equal(status.httpEndpoint, endpoint);

  // 1. Hello: the native origin is offered the native session and the
  //    business surfaces; a browser origin on plain HTTP is offered neither.
  const hello = (origin) =>
    new HostClient({
      baseUrl: endpoint,
      clientId: "native-session-smoke",
      fetch: fetchAs(origin),
    }).hello();
  const nativeHello = await hello(NATIVE);
  assert.ok(nativeHello.capabilities.includes("identity.native-session.v1"));
  assert.ok(nativeHello.capabilities.includes("settings.documents.v1"));
  assert.ok(!nativeHello.capabilities.includes("identity.browser-session.v1"));
  const browserHello = await hello(BROWSER);
  assert.ok(!browserHello.capabilities.includes("identity.native-session.v1"));
  assert.ok(!browserHello.capabilities.includes("settings.documents.v1"));
  // The Electron shell's loopback HTTP origin is offered the same surfaces as
  // the Tauri one, and still never the cookie session.
  const electronHello = await hello(ELECTRON);
  assert.ok(electronHello.capabilities.includes("identity.native-session.v1"));
  assert.ok(electronHello.capabilities.includes("settings.documents.v1"));
  assert.ok(
    !electronHello.capabilities.includes("identity.browser-session.v1"),
  );

  // 2. The shell's step: one ticket over the private control channel. The
  //    same CLI refuses a browser origin on a plain-HTTP Host.
  const mint = (origin) =>
    execFileSync(
      binary,
      [
        "pair",
        "--data-dir",
        dataDir,
        "--origin",
        origin,
        "--device-name",
        "本机桌面",
      ],
      {
        env,
        encoding: "utf8",
        timeout: 10_000,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
  assert.throws(() => mint(BROWSER));
  const ticketJson = mint(NATIVE);
  const ticket = JSON.parse(ticketJson);
  assert.equal(ticket.hostId, nativeHello.hostId);
  assert.equal(ticket.hostInstanceId, nativeHello.hostInstanceId);
  assert.equal(ticket.origin, NATIVE);

  const rawPair = async (origin, spend = ticket) => {
    const response = await fetchAs(origin)(
      `${endpoint}/rpc/armadra.v1.IdentityService/Pair`,
      {
        method: "POST",
        headers: { "Content-Type": MEDIA, Accept: MEDIA },
        body: new Uint8Array(
          toBinary(
            PairDeviceRequestSchema,
            create(PairDeviceRequestSchema, {
              expectedHostId: spend.hostId,
              expectedInstanceId: spend.hostInstanceId,
              ticket: spend.ticket,
            }),
          ),
        ),
      },
    );
    const body = new Uint8Array(await response.arrayBuffer());
    return {
      status: response.status,
      code: response.ok ? "" : fromBinary(ErrorResponseSchema, body).code,
      cookies: response.headers.getSetCookie(),
      body,
    };
  };

  // 3. A browser origin cannot spend the shell's ticket: refused at the
  //    gate, so the ticket is still unspent afterwards.
  const browserPair = await rawPair(BROWSER);
  assert.equal(browserPair.status, 403);
  assert.equal(browserPair.code, "PERMISSION_DENIED");

  // 4. The native origin trades the ticket for a bearer session, and a
  //    permissioned method (identity:read) answers it. No cookies anywhere.
  let ticketsAsked = 0;
  const credentials = new HostNativeCredentials({
    ticket: async () => {
      ticketsAsked += 1;
      return ticketJson;
    },
  });
  const identity = new HostIdentityClient({
    baseUrl: endpoint,
    hostId: nativeHello.hostId,
    hostInstanceId: nativeHello.hostInstanceId,
    pageOrigin: NATIVE,
    transport: { kind: "native", credentials },
    fetch: fetchAs(NATIVE),
  });
  const session = await identity.resume();
  assert.equal(ticketsAsked, 1);
  assert.equal(session.device.displayName, "本机桌面");
  assert.equal(session.device.role, "owner");
  assert.ok(credentials.signedIn);
  assert.ok(!("native" in session) && !("csrfToken" in session));
  const devices = await identity.listDevices();
  assert.equal(devices.devices.length, 1);
  assert.equal(devices.devices[0].displayName, "本机桌面");
  const firstAccess = credentials.access;
  await identity.refresh();
  assert.notEqual(credentials.access, firstAccess);
  const current = await identity.current();
  assert.equal(current.device.deviceId, session.device.deviceId);
  // A second client on the same credentials reuses the session: no ticket.
  const second = new HostIdentityClient({
    baseUrl: endpoint,
    hostId: nativeHello.hostId,
    hostInstanceId: nativeHello.hostInstanceId,
    pageOrigin: NATIVE,
    transport: { kind: "native", credentials },
    fetch: fetchAs(NATIVE),
  });
  assert.equal(
    (await second.resume()).device.deviceId,
    session.device.deviceId,
  );
  assert.equal(ticketsAsked, 1);

  // 5. The ticket was consumed: a second use from the native origin fails.
  const replay = await rawPair(NATIVE);
  assert.equal(replay.status, 401);
  assert.equal(replay.code, "UNAUTHENTICATED");
  assert.equal(replay.cookies.length, 0);

  // 6. Nothing authenticates on the native origin without a bearer, and the
  //    bearer is useless from a browser origin.
  const rawCurrent = async (origin, bearer) => {
    const response = await fetchAs(origin)(
      `${endpoint}/rpc/armadra.v1.IdentityService/Current`,
      {
        method: "POST",
        headers: {
          "Content-Type": MEDIA,
          Accept: MEDIA,
          ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
        },
        body: new Uint8Array(
          toBinary(
            CurrentSessionRequestSchema,
            create(CurrentSessionRequestSchema),
          ),
        ),
      },
    );
    await response.arrayBuffer();
    return response.status;
  };
  assert.equal(await rawCurrent(NATIVE, ""), 401);
  assert.equal(await rawCurrent(NATIVE, credentials.access), 200);
  assert.equal(await rawCurrent(BROWSER, credentials.access), 403);

  // 7. Logout ends the session for every holder of the credentials.
  const lastAccess = credentials.access;
  await identity.logout();
  assert.ok(!credentials.signedIn);
  assert.equal(await rawCurrent(NATIVE, lastAccess), 401);

  // 8. The Electron shape: the very same flow on the shell's loopback HTTP
  //    origin, with no custom scheme anywhere. Raw requests, because the
  //    host-client transport still spells out the Tauri origins.
  const electronTicket = JSON.parse(mint(ELECTRON));
  assert.equal(electronTicket.origin, ELECTRON);
  const stolen = await rawPair(BROWSER, electronTicket);
  assert.equal(stolen.status, 403);
  assert.equal(stolen.code, "PERMISSION_DENIED");
  const electronPair = await rawPair(ELECTRON, electronTicket);
  assert.equal(electronPair.status, 200);
  assert.equal(electronPair.cookies.length, 0);
  const electronSession = fromBinary(
    AuthenticatedSessionSchema,
    electronPair.body,
  );
  assert.equal(electronSession.device.displayName, "本机桌面");
  const electronAccess = electronSession.native?.accessToken ?? "";
  assert.ok(electronAccess);
  assert.equal(await rawCurrent(ELECTRON, electronAccess), 200);
  assert.equal(await rawCurrent(ELECTRON, ""), 401);
  // The session is bound to its origin, and the browser origin is still
  // stopped at the gate.
  assert.equal(await rawCurrent(NATIVE, electronAccess), 401);
  assert.equal(await rawCurrent(BROWSER, electronAccess), 403);
  // The ticket was consumed by the one origin that could spend it.
  assert.equal((await rawPair(ELECTRON, electronTicket)).status, 401);

  console.log(
    "PASS: shell origin (Tauri scheme and loopback HTTP) + control-channel ticket → bearer session → ListDevices; browser origin refused the same ticket; ticket single-use; no bearer, no session; logout revokes.",
  );
} finally {
  await stopHost();
  rmSync(temporary, { recursive: true, force: true });
}
