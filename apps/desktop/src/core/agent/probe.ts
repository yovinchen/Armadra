/**
 * CLI 版本探测 —— `docs/design/agent-automation-design.md` §1「CLI 版本探测」。
 *
 * 移植自 `apps/runtime/src/agent_probe.rs`。每个已装上的 CLI 一天跑一次
 * `<launchCmd> --version`，把解析出来的版本缓存在
 * `settings.agents.probes[<agentId>]`——设计 §9 说的那张 `agent_capability_cache`
 * 表，在这里就是设置文档里的这一节。
 *
 * 比版本号本身更要紧的是三条性质：
 *
 *   * **失败是一个单独的答案。** 一个不在、卡住、或者打印出我们看不懂的东西的
 *     CLI 留下 `status: "failed"`。§1 禁止把「问不出来」变成「支持」，共享的求
 *     交集把 unknown 的能力画成**没有**——一个我们担保不了的功能不画按钮。
 *   * **除了 `--version` 什么都不执行。** 不过 shell、不带用户的 argv、不给
 *     stdin；子进程拿到一个关掉的 stdin、一个短截止时间和一个小的输出预算，所以
 *     一个决定开 TUI 的 CLI 卡不住任何东西。
 *   * **只跑解析出来的程序。** 用 {@link resolveCommand} 找到的那个绝对路径，
 *     从不把一个裸名字丢给子进程的 PATH 去重新解析。
 *
 * 探测**不阻塞装配**：`install` 只武装一个 `unref` 的定时器，扫描在后台跑，结果
 * 到了才写进去。`GET /api/agents` 读的永远是缓存——这一次读到什么就是什么，读不
 * 到就是「还没探过」，而不是等。
 */

import { spawn } from "node:child_process";

import { settingsDomain } from "../settings";
import { parseCustomAgents } from "../settings/custom-agents";
import { isJsonObject } from "../settings/local";
import { AGENT_REGISTRY, resolveCommand } from "./registry";

/** 一个 CLI 到这会儿还没答，就不会答了；`--version` 是一次打印。 */
export const PROBE_TIMEOUT_MS = 8_000;
/** 版本横幅是一行。超过这个的不是版本。 */
const MAX_OUTPUT_BYTES = 64 * 1024;
/** 一天以后重探，中间装的 CLI 升级那时被认出来。 */
export const PROBE_TTL_MS = 24 * 60 * 60 * 1000;
/** 装配之后多久开始扫描。装配不等它。 */
export const SWEEP_DELAY_MS = 3_000;

/** 一条缓存好的探测。和 `packages/shared` 的 `agentProbeSchema` 同形。 */
export interface AgentProbe {
  readonly agentId: string;
  /** 探测真正跑的程序。换了启动程序就重探，而不是继承上一个程序的答案。 */
  readonly launchCmd: string;
  /** 解析出来的 `major.minor.patch`，输出里没有版本就是 null。 */
  readonly version: string | null;
  /** `ok` = 程序跑了、输出读到了；`failed` = 问不出来。两者从不混为一谈。 */
  readonly status: "ok" | "failed";
  /** ISO-8601。 */
  readonly probedAt: string;
}

/**
 * `--version` 那一行里第一个 `x.y` / `x.y.z`。和 `packages/shared` 的
 * `parseCliVersion` 逐字一致——core 不依赖那个包，所以这里重述一遍。
 *
 * CLI 打印的东西从 `1.2.3` 到 `codex-cli 0.104.0 (rust)` 到 `v18.1.8` 都有，所以
 * 规则是「第一个带点的数字」，前面不加 `\b`——`\b` 不肯从 `v18` 里面开始，会拿回
 * 一个 `1.8`。要求两段是为了让一个只是以数字结尾的标识符（`sha256`、`utf8mb4`）
 * 不被读成版本；一个数字都没有就是没有版本，永远不是一个能让判定通过的默认值。
 */
export function parseCliVersion(output: string): string | null {
  const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(output);
  return match ? `${match[1]}.${match[2]}.${match[3] ?? "0"}` : null;
}

/** 跑 `<program> --version`，stdin 关掉、有截止时间。输出读不到就是 undefined。 */
export function runVersion(program: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(program, ["--version"], {
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      resolve(undefined);
      return;
    }
    let output = "";
    let settled = false;
    const finish = (value: string | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      try {
        child.kill();
      } catch {
        // 已经退了。
      }
      resolve(value);
    };
    const deadline = setTimeout(() => finish(undefined), PROBE_TIMEOUT_MS);
    deadline.unref?.();
    // 有些 CLI 把横幅打在 stderr 上；两边都读，stdout 在前。
    const append = (chunk: Buffer): void => {
      if (output.length < MAX_OUTPUT_BYTES) output += chunk.toString("utf8");
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.on("error", () => finish(undefined));
    child.on("close", () => finish(output));
    child.unref?.();
  });
}

export interface ProbeOptions {
  /** 注入点：测试给一个假 CLI，不必在 PATH 上放脚本。 */
  readonly run?: (program: string) => Promise<string | undefined>;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => number;
}

/** 探一个 Agent，不理会任何缓存。 */
export async function probeAgent(
  agentId: string,
  launchCmd: string,
  options: ProbeOptions = {},
): Promise<AgentProbe> {
  const probedAt = new Date(options.now?.() ?? Date.now()).toISOString();
  const program = resolveCommand(launchCmd, options.env ?? process.env);
  if (program === undefined) {
    return {
      agentId,
      launchCmd,
      version: null,
      status: "failed",
      probedAt,
    };
  }
  const output = await (options.run ?? runVersion)(program);
  return {
    agentId,
    launchCmd,
    // 一个跑起来了但没打印出可认版本的程序仍然算 `ok`：我们**确实**问到了，问到
    // 的结果是「没有版本」。
    status: output === undefined ? "failed" : "ok",
    version: output === undefined ? null : parseCliVersion(output),
    probedAt,
  };
}

/* --------------------------------- 缓存 ----------------------------------- */

/**
 * 这一次运行里探到的结果。
 *
 * 内存里一份，是因为设置文档可能写不进去（只读的数据目录），而那不该让
 * `GET /api/agents` 少一个字段；设置文档里那一份让答案跨重启活下来。
 */
const MEMORY = new Map<string, AgentProbe>();

/** 丢掉记着的探测。测试用。 */
export function forgetProbes(): void {
  MEMORY.clear();
}

function fromSettings(agentId: string): AgentProbe | undefined {
  const probes = settingsDomain()?.settings.get("agents.probes");
  if (!isJsonObject(probes)) return undefined;
  const raw = probes[agentId];
  if (!isJsonObject(raw)) return undefined;
  const status = raw.status;
  const launchCmd = raw.launchCmd;
  const probedAt = raw.probedAt;
  if (status !== "ok" && status !== "failed") return undefined;
  if (typeof launchCmd !== "string" || typeof probedAt !== "string") {
    return undefined;
  }
  return {
    agentId,
    launchCmd,
    version: typeof raw.version === "string" ? raw.version : null,
    status,
    probedAt,
  };
}

/** 一个 Agent 现在已知的探测结果：内存优先，然后是设置文档。 */
export function storedProbe(agentId: string): AgentProbe | undefined {
  return MEMORY.get(agentId) ?? fromSettings(agentId);
}

/** 记住一条探测。写不进设置只损失跨重启那一份，不损失这一次。 */
export function rememberProbe(probe: AgentProbe): void {
  MEMORY.set(probe.agentId, probe);
  settingsDomain()?.settings.patch({
    agents: { probes: { [probe.agentId]: { ...probe } } },
  });
}

/** 读不懂的时间戳一律当作过期：重探便宜，信一个读不懂的日期不便宜。 */
export function isFresh(
  probe: AgentProbe,
  launchCmd: string,
  now: number,
): boolean {
  if (probe.launchCmd !== launchCmd) return false;
  const at = Date.parse(probe.probedAt);
  return Number.isFinite(at) && now - at < PROBE_TTL_MS;
}

/* --------------------------------- 扫描 ----------------------------------- */

export interface SweepTarget {
  readonly id: string;
  readonly launchCmd: string;
}

/**
 * 这台机器上「已知的 CLI」：六个内置适配器，加上用户 `settings.agents.custom[]`
 * 里的条目。
 *
 * 自定义条目也探，而且探的是**它自己**的启动程序：借基础适配器的版本等于替一个
 * 从没被问过的二进制作担保。
 */
export function knownAgents(): SweepTarget[] {
  const builtins = AGENT_REGISTRY.map((agent) => ({
    id: agent.id,
    launchCmd: agent.launchCmd,
  }));
  const custom = parseCustomAgents(
    settingsDomain()?.settings.snapshot() ?? {},
  ).map((entry) => ({ id: entry.id, launchCmd: entry.launchCmd }));
  return [...builtins, ...custom];
}

/**
 * 探一遍还没有新鲜答案的那些 Agent。
 *
 * 装不上的不探：没有可问的东西，而 `resolveCommand` 找不到程序本身就是
 * `failed`，那一条仍然会被记下来，于是页面看得出「问过了，问不出来」。
 */
export async function sweepProbes(
  targets: readonly SweepTarget[] = knownAgents(),
  options: ProbeOptions = {},
): Promise<AgentProbe[]> {
  const now = options.now?.() ?? Date.now();
  const probes: AgentProbe[] = [];
  for (const target of targets) {
    const known = storedProbe(target.id);
    if (known !== undefined && isFresh(known, target.launchCmd, now)) {
      probes.push(known);
      continue;
    }
    const probe = await probeAgent(target.id, target.launchCmd, options);
    rememberProbe(probe);
    probes.push(probe);
  }
  return probes;
}

let armed: NodeJS.Timeout | undefined;

/**
 * 装配时武装一遍扫描。
 *
 * `unref` 的定时器 + 后台的 promise：装配一步都不等它，一个开了就关的 core 根本
 * 不会起任何子进程。一次扫描失败只是少一条缓存，绝不能挡住启动。
 */
export function armProbeSweep(
  onError: (error: unknown) => void = () => {},
  delayMs: number = SWEEP_DELAY_MS,
): void {
  if (armed !== undefined) return;
  armed = setTimeout(() => {
    armed = undefined;
    void sweepProbes().catch(onError);
  }, delayMs);
  armed.unref?.();
}

/** 取消还没跑的那一次扫描。 */
export function cancelProbeSweep(): void {
  if (armed !== undefined) clearTimeout(armed);
  armed = undefined;
}
