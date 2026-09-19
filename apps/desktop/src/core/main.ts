import type { Server } from "node:http";
import { USAGE, parseArguments } from "./args";
import { EventBus } from "./bus";
import { DatabaseRefused, openDatabase } from "./db/open";
import { resolveMigrationsDir } from "./db/migrations";
import {
  RUNTIME_SERVICE,
  type ServiceEndpoint,
  publish,
  serviceEndpointNow,
  withdraw,
} from "./endpoints";
import { CoreServer } from "./http/server";
import { VERSION, announcement, instanceId } from "./instance";
import { type ListenSpec, bind, formatListenSpec, release } from "./listen";
import { databaseFile, endpointsFile, resolveDataDir } from "./paths";
import { createLog, logLevel, nodePlatform } from "./platform";

/**
 * The core process.
 *
 * Runnable two ways, and it must stay that way: `node out/core/main.js --listen
 * … --data-dir …` for development and for the server shell, and
 * `utilityProcess.fork` from the Electron shell. Nothing here imports
 * `electron` — the scan in `shell-core/no-electron.test.ts` covers this whole
 * directory — so the difference between the two is only who reads stdout.
 *
 * The start-up order is not arbitrary. It is, in this order:
 *
 *   1. **Announce.** Before anything can fail. A core that cannot bind because
 *      a stale one still holds the socket has nonetheless told the shell which
 *      id to expect; without that the shell cannot tell its own child from
 *      whatever else answers on the address.
 *   2. **Open the database.** A refusal here must happen before an endpoint
 *      file says this process is serving.
 *   3. **Bind every listener.** Reserve the addresses before publishing any.
 *   4. **Arm the signal handlers.** Until they are armed SIGTERM is fatal where
 *      it lands, and everything published in step 5 is a file that survives
 *      such a death pointing at a pid that no longer exists.
 *   5. **Publish.** Bind first, then publish: an endpoint file must never
 *      advertise an address nothing is listening on.
 */

export interface RunOptions {
  readonly argv?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  /** Where to look for `apps/runtime/migrations` when nothing else says. */
  readonly moduleDir?: string;
  readonly stdout?: (line: string) => void;
}

export interface RunningCore {
  readonly instanceId: string;
  readonly bound: readonly ListenSpec[];
  readonly server: CoreServer;
  readonly bus: EventBus;
  stop(): Promise<void>;
}

export async function run(options: RunOptions = {}): Promise<RunningCore> {
  const env = options.env ?? process.env;
  const argv = options.argv ?? process.argv.slice(2);
  const write =
    options.stdout ?? ((line: string) => process.stdout.write(line));

  const parsed = parseArguments(argv, env);
  if (parsed.kind === "help") {
    write(`${USAGE}\n`);
    throw new HelpRequested();
  }
  if (parsed.kind === "error") throw new Error(parsed.reason);

  const dataDir = resolveDataDir(parsed.args.dataDir, process.platform, env);
  const log = createLog(logLevel(env.ARMADRA_LOG));
  const platform = nodePlatform({
    dataDir,
    appVersion: VERSION,
    isPackaged: env.ARMADRA_DESKTOP_PACKAGED === "1",
    resourcesPath: process.resourcesPath,
    log,
  });

  // Step 1 — before anything can fail.
  write(`${announcement()}\n`);

  // Step 2.
  const opened = openDatabase({
    file: databaseFile(dataDir),
    migrationsDir: resolveMigrationsDir({
      env,
      resourcesPath: platform.resourcesPath,
      from: options.moduleDir,
    }),
  });
  log.info("opened the database", {
    file: databaseFile(dataDir),
    migrations: opened.migrations.length,
  });

  const bus = new EventBus();
  const server = new CoreServer({ platform, bus, version: VERSION });

  // Step 3.
  const listeners: { server: Server; spec: ListenSpec }[] = [];
  const bound: ListenSpec[] = [];
  try {
    for (const spec of parsed.args.listen) {
      const listener = server.createListener();
      bound.push(await bind(listener, spec));
      listeners.push({
        server: listener,
        spec: bound[bound.length - 1] as ListenSpec,
      });
    }
  } catch (error) {
    await server.close();
    opened.close();
    throw error;
  }

  const endpoints = endpointsFile(dataDir);
  let released = false;
  const releaseAll = (): void => {
    if (released) return;
    released = true;
    try {
      withdraw(endpoints, RUNTIME_SERVICE);
    } catch (error) {
      log.warn("could not withdraw the core endpoint", {
        error: describe(error),
      });
    }
    for (const listener of listeners) release(listener.spec);
  };

  // Step 4 — armed before step 5 publishes anything about this process.
  const stop = async (): Promise<void> => {
    await server.close();
    opened.close();
    releaseAll();
  };
  const onSignal = (): void => {
    void stop().then(() => process.exit(0));
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);

  // Step 5.
  try {
    publish(endpoints, RUNTIME_SERVICE, runtimeEndpoint(instanceId(), bound));
  } catch (error) {
    // Discovery is a convenience; an unwritable data directory must not stop a
    // core whose address the caller already knows.
    log.warn("could not publish the core endpoint", {
      path: endpoints,
      error: describe(error),
    });
  }
  for (const spec of bound)
    log.info("Armadra core is listening", { spec: formatListenSpec(spec) });
  bus.emit("runtime.hello", { instanceId: instanceId(), version: VERSION });

  return {
    instanceId: instanceId(),
    bound,
    server,
    bus,
    stop: async () => {
      process.off("SIGTERM", onSignal);
      process.off("SIGINT", onSignal);
      await stop();
    },
  };
}

/** Thrown for `--help`, so the caller exits 0 rather than reporting a failure. */
export class HelpRequested extends Error {}

/** Turns the addresses we actually bound into one `endpoints.json` record. */
export function runtimeEndpoint(
  id: string,
  bound: readonly ListenSpec[],
  now: () => Date = () => new Date(),
  processId: number = process.pid,
): ServiceEndpoint {
  let endpoint = serviceEndpointNow(id, now, processId);
  for (const spec of bound) {
    switch (spec.kind) {
      case "tcp":
        endpoint = {
          ...endpoint,
          http: `http://${spec.host}:${spec.port}`,
          websocket: `ws://${spec.host}:${spec.port}`,
        };
        break;
      case "unix":
        endpoint = { ...endpoint, socket: spec.path };
        break;
      case "pipe":
        endpoint = { ...endpoint, pipe: `\\\\.\\pipe\\${spec.name}` };
        break;
    }
  }
  return endpoint;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The process entry point, exercised by the integration test.
 *
 * The `typeof` guards are not decoration: the bundle is CJS, but the same
 * module is imported as ESM by vitest, where `require` and `module` do not
 * exist and touching them would throw before a single test ran.
 */
const isEntryPoint =
  typeof require !== "undefined" &&
  typeof module !== "undefined" &&
  require.main === module;

if (isEntryPoint) {
  run({
    moduleDir: typeof __dirname === "string" ? __dirname : undefined,
  }).catch((error: unknown) => {
    if (error instanceof HelpRequested) {
      process.exit(0);
    }
    process.stderr.write(
      `${error instanceof DatabaseRefused ? "" : "Armadra core could not start: "}${describe(error)}\n`,
    );
    process.exit(1);
  });
}
