// The client driver the end-to-end check talks through.
//
// One driver, two transports: headless Chrome bundles it, and the Node
// fallback imports it. Both halves therefore drive the same
// @armadra/host-client the panel imports — reimplementing the wire format
// inside the check would prove nothing about the client that ships.
//
// It lives on its own because it is a layer, not a step: nothing here knows
// what a canvas, a settings document or an ownership epoch is, and the
// sequences in canvas-ownership-e2e.mjs and ownership-e2e.mjs read better
// without the bundling in the middle of them.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// openDriver writes the shared core, then either bundles it for the browser or
// imports it here. It answers the core's path — the browser half re-imports it
// for its own encoder — and the Node driver, which is null when Chrome is going
// to supply one instead. `run` and `nodeTransport` are passed in rather than
// imported: they belong to the one temporary workspace this run owns.
export async function openDriver({
  root,
  workspace,
  appOrigin,
  driverFile,
  skipApplication,
  nodeTransport,
  run,
}) {
  let driver = null;
  const driverCore = join(workspace, "driver-core.mjs");
  writeFileSync(
    driverCore,
    `const BYTES = "$bytes";
const BIG = "$bigint";
function base64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
export function encodeValue(value) {
  if (typeof value === "bigint") return { [BIG]: value.toString() };
  if (value instanceof Uint8Array) return { [BYTES]: base64(value) };
  if (Array.isArray(value)) return value.map(encodeValue);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = encodeValue(item);
    return out;
  }
  return value;
}
export function decodeValue(value) {
  if (Array.isArray(value)) return value.map(decodeValue);
  if (value && typeof value === "object") {
    if (typeof value[BIG] === "string") return BigInt(value[BIG]);
    if (typeof value[BYTES] === "string") {
      const binary = atob(value[BYTES]);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      return bytes;
    }
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = decodeValue(item);
    return out;
  }
  return value;
}
export function createDriver({ HostClient, HostIdentityClient, HostCanvasClient, HostOwnershipClient, HostSettingsClient, origin, transport, pageOrigin }) {
  const state = {};
  return {
    async hello() {
      state.hello = await new HostClient({ baseUrl: origin, clientId: "canvas-e2e", ...transport }).hello();
      return encodeValue(state.hello);
    },
    async pair(material) {
      state.identity = new HostIdentityClient({
        baseUrl: origin,
        hostId: state.hello.hostId,
        hostInstanceId: state.hello.hostInstanceId,
        ...(pageOrigin ? { pageOrigin } : {}),
        ...transport,
      });
      return encodeValue(await state.identity.pair(material));
    },
    connect(workspaceId) {
      state.canvas = new HostCanvasClient({
        session: state.identity,
        hostId: state.hello.hostId,
        workspaceId,
      });
      // The ownership record is host-wide, so this client names no workspace.
      state.ownership = new HostOwnershipClient({
        session: state.identity,
        hostId: state.hello.hostId,
      });
      // So is the settings document: one per Host, not one per workspace.
      if (HostSettingsClient)
        state.settings = new HostSettingsClient({
          session: state.identity,
          hostId: state.hello.hostId,
        });
      return true;
    },
    async settings(method, args) {
      try {
        return encodeValue(await state.settings[method](...decodeValue(args)));
      } catch (error) {
        return {
          error: {
            failure: error.failure ?? error.code ?? "unknown",
            hostCode: error.hostCode ?? "",
            httpStatus: error.httpStatus ?? 0,
            outcomeUnknown: error.outcomeUnknown === true,
          },
        };
      }
    },
    async ownership(method, args) {
      try {
        return encodeValue(await state.ownership[method](...decodeValue(args)));
      } catch (error) {
        return {
          error: {
            failure: error.failure ?? error.code ?? "unknown",
            hostCode: error.hostCode ?? "",
            httpStatus: error.httpStatus ?? 0,
            outcomeUnknown: error.outcomeUnknown === true,
          },
        };
      }
    },
    async call(method, args) {
      try {
        return encodeValue(await state.canvas[method](...decodeValue(args)));
      } catch (error) {
        return {
          error: {
            failure: error.failure ?? error.code ?? "unknown",
            hostCode: error.hostCode ?? "",
            httpStatus: error.httpStatus ?? 0,
            outcomeUnknown: error.outcomeUnknown === true,
          },
        };
      }
    },
  };
}
`,
  );

  if (skipApplication) {
    // No browser: the same client is driven from Node over the same TLS proxy,
    // with a cookie jar standing in for the browser's own. The Host still sees
    // its public origin and still enforces the origin, cookie and CSRF checks.
    const { createDriver, encodeValue, decodeValue } = await import(
      pathToFileURL(driverCore).href
    );
    const clients = await import(
      pathToFileURL(join(root, "packages/host-client/dist/index.js")).href
    );
    const jar = new Map();
    const transport = nodeTransport(jar);
    const client = createDriver({
      HostClient: clients.HostClient,
      HostIdentityClient: clients.HostIdentityClient,
      HostCanvasClient: clients.HostCanvasClient,
      HostOwnershipClient: clients.HostOwnershipClient,
      HostSettingsClient: clients.HostSettingsClient,
      origin: appOrigin,
      transport: { fetch: transport },
      pageOrigin: appOrigin,
    });
    driver = {
      hello: () => client.hello().then(decodeValue),
      pair: (material) => client.pair(material).then(decodeValue),
      connect: (workspaceId) => client.connect(workspaceId),
      call: (method, args) =>
        client.call(method, encodeValue(args)).then(decodeValue),
      ownership: (method, args) =>
        client.ownership(method, encodeValue(args)).then(decodeValue),
      settings: (method, args) =>
        client.settings(method, encodeValue(args)).then(decodeValue),
    };
  } else {
    const driverSource = join(workspace, "driver-source.mjs");
    writeFileSync(
      driverSource,
      `import { HostClient, HostIdentityClient, HostCanvasClient, HostOwnershipClient, HostSettingsClient } from "@armadra/host-client";
import { createDriver } from "./driver-core.mjs";
globalThis.armadra = createDriver({
  HostClient, HostIdentityClient, HostCanvasClient, HostOwnershipClient, HostSettingsClient,
  origin: ${JSON.stringify(appOrigin)}, transport: {},
});
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
        `--alias:@armadra/protocol=${join(root, "packages/protocol/dist/index.js")}`,
        `--alias:@armadra/host-client=${join(root, "packages/host-client/dist/index.js")}`,
        `--outfile=${driverFile}`,
        "--log-level=error",
      ],
      { stdio: "inherit" },
    );
  }
  return { driverCore, driver };
}
