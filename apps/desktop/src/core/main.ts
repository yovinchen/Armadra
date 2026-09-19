import type { Server } from "node:http";
import { USAGE, parseArguments } from "./args";
import { install as installAssets } from "./assets/routes";
import { install as installCanvas } from "./canvas/routes";
import { install as installWorkspaces } from "./workspaces/routes";
import { EventBus } from "./bus";
import { absorbHostDatabase } from "./db/absorb-host";
import { DatabaseRefused, type OpenedDatabase, openDatabase } from "./db/open";
import { resolveMigrationsDir } from "./db/migrations";
import { resolveUnifiedMigrationsDir, unifiedEnabled } from "./db/unified";
import { installIdentity } from "./identity";
import { install as installHooks } from "./hook";
import { hookService } from "./hook/service";
import {
  RUNTIME_SERVICE,
  type ServiceEndpoint,
  publish,
  serviceEndpointNow,
  withdraw,
} from "./endpoints";
import { install as installEvents } from "./events";
import { NO_HOOK_SERVICE } from "./http/health";
import { CoreServer } from "./http/server";
import { VERSION, announcement, instanceId } from "./instance";
import { install as installSettings } from "./settings";
import { install as installUsage } from "./usage";
import { type ListenSpec, bind, formatListenSpec, release } from "./listen";
import { databaseFile, endpointsFile, resolveDataDir } from "./paths";
import {
  type CorePlatform,
  createLog,
  logLevel,
  nodePlatform,
} from "./platform";
import { install as installRemote } from "./remote";
import { install as installTerminals } from "./terminal/install";
import { install as installAgents } from "./agent";
import { install as installBrowser } from "./browser";

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
  /**
   * Domain wiring, run after the database and the server exist and before any
   * listener binds — so a route registered here is reachable from the first
   * request. Each domain exports one `install(context)`; `main` lists them.
   */
  readonly domains?: readonly ((context: CoreContext) => void)[];
}

/**
 * What every domain module receives at assembly time. One object rather than
 * a bag of parameters so that adding a shared facility (a scheduler, a cache)
 * is one line here and none in the domains.
 */
export interface CoreContext {
  readonly dataDir: string;
  readonly db: OpenedDatabase;
  readonly server: CoreServer;
  readonly bus: EventBus;
  readonly platform: CorePlatform;
  readonly log: ReturnType<typeof createLog>;
}

export interface RunningCore extends CoreContext {
  readonly instanceId: string;
  readonly bound: readonly ListenSpec[];
  stop(): Promise<void>;
}

/** The domains assembled by default; each phase adds its `install` here. */
export const DOMAINS: readonly ((context: CoreContext) => void)[] = [
  // Events first: a domain installed after it may emit during its own
  // installation, and a fan-out that is not listening yet would drop that.
  installEvents,
  // Workspaces next: it mints the default workspace, and the domains after it
  // read a workspace row before they do anything.
  installWorkspaces,
  installCanvas,
  installAssets,
  installSettings,
  installUsage,
  installIdentity,
  // Agents before terminals: the collaboration verbs and the context-usage
  // cache have to exist before a PTY can report into them, and the terminal
  // domain hands its bridge back through `agent/setTerminalBridge`.
  installAgents,
  // Remote before the terminals: an SSH terminal is decorated with this
  // domain's askpass service and host registry, which `remoteDomain()` hands
  // over the same way `settingsDomain()` does. It reads the settings store
  // `installSettings` assembled, and it starts nothing until it is asked to.
  installRemote,
  installTerminals,
  // After agents: the browser verbs reach the canvas through the same node and
  // link tables, and the hook surface that carries them is the agent domain's.
  installBrowser,
  // Last: the hook service publishes an endpoint file, and nothing may be
  // advertised before the domains that answer a hook report exist.
  installHooks,
];

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
  //
  // `ARMADRA_CORE=ts` 时多叠一个迁移目录：统一库迁移 0015。它是单向门——应用
  // 之后 Rust Runtime 会因为「这条迁移本构建不认识」拒绝启动，所以应用前先把
  // 整个库复制成 `canvas.db.before-ts-core-<ts>`，那是唯一的回滚点。
  const unified = unifiedEnabled(env);
  const opened = openDatabase({
    file: databaseFile(dataDir),
    migrationsDir: resolveMigrationsDir({
      env,
      resourcesPath: platform.resourcesPath,
      from: options.moduleDir,
    }),
    ...(unified
      ? {
          unifiedMigrationsDir: resolveUnifiedMigrationsDir({
            env,
            resourcesPath: platform.resourcesPath,
            from: options.moduleDir,
          }),
        }
      : {}),
  });
  log.info("opened the database", {
    file: databaseFile(dataDir),
    migrations: opened.migrations.length,
  });
  if (opened.backup !== null) {
    log.warn(
      "统一库迁移已应用：这个库 Rust Runtime 不再打得开，回滚请用备份替换",
      { backup: opened.backup },
    );
  }
  if (opened.unified) {
    // 搬运必须在任何域读 `store_meta` 之前：`host_id` 要从旧库带过来，晚一步
    // 就会先生成一个新的，页面记下的那个 Host 就认不出来了。
    const absorbed = absorbHostDatabase({ database: opened.database, dataDir });
    if (absorbed.absorbed) {
      log.info("旧 host.db 已并入统一库", {
        rows: absorbed.rows,
        renamedTo: absorbed.renamedTo,
      });
    }
  }

  const bus = new EventBus();
  const server = new CoreServer({
    platform,
    bus,
    version: VERSION,
    // R3: the section reconciles the endpoint file with the addresses this
    // core is actually on; until the hook domain installs there is no service
    // and `/health` reports a core with none.
    hookHealth: () => hookService()?.health() ?? NO_HOOK_SERVICE,
  });
  const context: CoreContext = {
    dataDir,
    db: opened,
    server,
    bus,
    platform,
    log,
  };
  for (const install of options.domains ?? DOMAINS) install(context);

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
    ...context,
    instanceId: instanceId(),
    bound,
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
