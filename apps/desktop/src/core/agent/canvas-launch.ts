import {
  type ShellDialect,
  isBatchProgram,
  shellCommandLine,
  shellDialect,
} from "../terminal/shell";
import {
  type Injection,
  canvasInjection,
  isInjected,
  prepareInjection,
} from "../hook/install/inject";
import { defaultShell } from "../terminal/environment";
import { planLaunch } from "./launch";
import {
  type AgentSettings,
  baseAgent,
  customAgent,
  definition,
  launchTargetOf,
  resolveCommand,
} from "./registry";

/**
 * The one exit every canvas launch line leaves the core through
 * (docs/design/canvas-only-integration.md §2).
 *
 * The core starts a CLI on four roads — dependency orchestration, the Eco
 * wake-up, a schedule's cold start, and (through the page, which builds its
 * own line from `GET /api/agents`) every node the user or `open-agent` /
 * `team` creates. The first three all build their line here, so the argv the
 * integration needs is added in one place: {@link canvasInjection}. A
 * structural test (`canvas-launch.test.ts`) fails if a launch line is built
 * anywhere else.
 *
 * The environment half ({@link canvasEnvironment}) goes where every canvas
 * terminal's environment is built — the terminal domain's
 * `ownedEnvironment` — so the page's road carries it too.
 *
 * Both halves are written for the node terminal's shell ({@link nodeDialect}):
 * the line is quoted in its dialect, and a Codex value the line expands from
 * the environment is written so that shell expands it intact.
 *
 * On Windows the program is what the npm / pnpm wrapper runs, not the wrapper
 * (`windows-shim.ts`): a `.cmd` has `cmd.exe` read every argument a second
 * time. A wrapper that cannot be read stays the program, and then only words
 * that survive both reads go on the line (`shellCommandLine`).
 */

export interface CanvasLaunchRequest {
  readonly settings: AgentSettings;
  /** Our data directory; without one there is nothing to inject. */
  readonly dataDir?: string;
  /** The node's agent id — a `custom:` entry is injected as its base. */
  readonly agentId: string;
  readonly nodeId?: string;
  readonly permissionMode?: string;
  readonly model?: string;
  /** Continue this provider session. */
  readonly resume?: string;
  /**
   * The program resolved on this machine (`GET /api/agents`' `resolvedPath`);
   * the registry's name otherwise — looked up on PATH here on Windows, where
   * the shell would find the `.cmd` wrapper.
   */
  readonly program?: string;
  /**
   * A frozen argv (a schedule's plan) used *instead of* the flags derived
   * from the permission mode and model — the plan already carries those.
   */
  readonly frozenArgs?: readonly string[];
  /**
   * The dialect of the shell the line is typed into ({@link nodeDialect}).
   * The core's own default shell's when absent.
   */
  readonly dialect?: ShellDialect;
  /**
   * The node's terminal is an SSH session: the line is read by a POSIX shell
   * on the execution host. It carries no injected words — every path they
   * name is on this machine — and no program resolved here; the host's
   * shims (`hook/install/remote.ts`) add the injection when the CLI starts.
   */
  readonly ssh?: boolean;
}

export interface CanvasLaunch {
  readonly program: string;
  /** The whole argv, literal — for a caller that execs the CLI. */
  readonly args: readonly string[];
  /** The line typed into the node's shell, quoted for its dialect. */
  readonly line: string;
}

/**
 * The dialect a node's launch line is written in: the shell its terminal
 * runs. An SSH node's line is read by the shell on the far host, which is a
 * POSIX login shell whatever this machine is; a local node without a shell
 * of its own runs the default one ({@link defaultShell}, `COMSPEC` on
 * Windows).
 */
export function nodeDialect(
  shell: string | undefined,
  ssh = false,
): ShellDialect {
  if (ssh) return "posix";
  return shellDialect(shell ?? defaultShell());
}

/** The injection for this node's CLI, a custom entry resolved to its base. */
export function injectionFor(
  settings: AgentSettings,
  dataDir: string | undefined,
  agentId: string,
  options: {
    readonly nodeId?: string;
    readonly resume?: boolean;
    readonly dialect?: ShellDialect;
  } = {},
): Injection {
  if (dataDir === undefined) return { args: [], words: [], env: [] };
  return canvasInjection({
    dataDir,
    agentId: baseAgent(settings, agentId),
    ...(options.nodeId === undefined ? {} : { nodeId: options.nodeId }),
    ...(options.resume === undefined ? {} : { resume: options.resume }),
    ...(options.dialect === undefined ? {} : { dialect: options.dialect }),
  });
}

export function canvasLaunch(request: CanvasLaunchRequest): CanvasLaunch {
  const plan = planLaunch(request.settings, {
    agentId: request.agentId,
    ...(request.resume === undefined ? {} : { resume: request.resume }),
    ...(request.permissionMode === undefined
      ? {}
      : { permissionMode: request.permissionMode }),
    ...(request.model === undefined ? {} : { model: request.model }),
  });
  const ssh = request.ssh === true;
  const injection = ssh
    ? { args: [], words: [] }
    : injectionFor(request.settings, request.dataDir, request.agentId, {
        ...(request.nodeId === undefined ? {} : { nodeId: request.nodeId }),
        resume: request.resume !== undefined && request.resume !== "",
      });
  const flags = request.frozenArgs ?? plan.args;
  // 本机解析到的程序路径在执行主机上不存在：SSH 节点用注册表里的程序名，由
  // 远端 shell 的 PATH 找（垫片排在最前面）。本机在 Windows 上则绕过 npm 的
  // `.cmd` 包装，直接起它背后的程序。
  const resolved = ssh
    ? plan.program
    : (request.program ??
      (process.platform === "win32"
        ? resolveCommand(plan.program)
        : undefined) ??
      plan.program);
  const target = ssh ? undefined : launchTargetOf(resolved);
  const program = target?.program ?? resolved;
  const lead = target?.args ?? [];
  const dialect = ssh
    ? nodeDialect(undefined, true)
    : (request.dialect ?? nodeDialect(undefined));
  return {
    program,
    args: [...lead, ...flags, ...injection.args],
    line: shellCommandLine(
      program,
      [...lead, ...flags, ...injection.words],
      dialect,
    ),
  };
}

/**
 * Whether this agent starts through a batch wrapper nothing could be read
 * out of. Its line then reaches the CLI through `cmd.exe`'s second read, so
 * a value the line expands from the environment has to be written for
 * `cmd.exe` whatever shell types it.
 */
export function startsThroughBatch(
  settings: AgentSettings,
  agentId: string,
): boolean {
  const command =
    customAgent(settings, agentId)?.launchCmd ?? definition(agentId)?.launchCmd;
  if (command === undefined) return false;
  const resolved = resolveCommand(command);
  return (
    resolved !== undefined &&
    isBatchProgram(resolved) &&
    launchTargetOf(resolved) === undefined
  );
}

/** The same launch as one line of shell text, each word quoted only if needed. */
export function canvasLaunchLine(request: CanvasLaunchRequest): string {
  return canvasLaunch(request).line;
}

/**
 * The environment a canvas node's terminal carries for its CLI, and the
 * moment the artifacts are made current: a terminal is about to start this
 * CLI. A failure to write them never stops the terminal — the launch simply
 * goes without, and the log says why.
 */
export function canvasEnvironment(
  settings: AgentSettings,
  dataDir: string,
  agentId: string,
  nodeId: string,
  log?: (message: string, fields: Record<string, unknown>) => void,
  dialect: ShellDialect = nodeDialect(undefined),
): readonly (readonly [string, string])[] {
  const base = baseAgent(settings, agentId);
  if (!isInjected(base)) return [];
  try {
    prepareInjection(base, { dataDir });
  } catch (error) {
    log?.("could not prepare the canvas injection", {
      agentId: base,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return injectionFor(settings, dataDir, agentId, {
    nodeId,
    dialect: startsThroughBatch(settings, agentId) ? "cmd" : dialect,
  }).env;
}
