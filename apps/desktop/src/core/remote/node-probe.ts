/**
 * "Does this machine have a Node the remote core can run on?"
 *
 * This is the one place the TypeScript port is **less capable than the Rust
 * Runtime**, and the design says so in as many words (§9, 「远端执行需要目标机
 * 有 Node」): the Rust Worker is a static binary that runs on a bare machine,
 * and the TypeScript Worker is `out/core/main.js`, which is not.
 *
 * The decided behaviour is not a fallback. A host with no Node reports
 * `unsupported` with the version it would need, and a workspace on it refuses
 * to execute. The outcome that must never happen is the quiet one — a
 * "remote" workspace whose files are read on this machine — because that is a
 * data operation wearing a preference's clothes.
 */

import type { SshHost } from "../settings/ssh-hosts";
import { nodeProbeArgv } from "../terminal/ssh/argv";
import { redactSecrets, tail } from "../terminal/ssh/redact";
import { runCommand } from "../terminal/ssh/run";

/**
 * The lowest Node the remote core is known to run on.
 *
 * It is the `engines.node` floor of `@armadra/desktop` rather than a number
 * chosen here: the thing being shipped to the far side is this build's own
 * bundle, so the requirement is this build's own requirement.
 */
export const MINIMUM_NODE_MAJOR = 22;

/** How long the far side gets to answer. The probe line is `ssh -o ConnectTimeout=5`. */
const PROBE_TIMEOUT_MS = 20_000;

export interface NodeProbe {
  /** `v22.11.0`, exactly as `node --version` printed it. Absent when missing. */
  readonly version?: string;
  readonly major?: number;
  /** The far side has a Node this build can run on. */
  readonly usable: boolean;
  /** A stable key: `missing`, `tooOld`, `unreachable`. Absent when usable. */
  readonly reason?: "missing" | "tooOld" | "unreachable";
  /** Redacted diagnostics, for the settings page. Empty when everything worked. */
  readonly detail: string;
}

/** `v22.11.0` → 22. Anything that is not that shape has no major. */
export function parseNodeVersion(output: string): number | undefined {
  const match = /^v(\d+)\./mu.exec(output.trim());
  if (match?.[1] === undefined) return undefined;
  const major = Number.parseInt(match[1], 10);
  return Number.isNaN(major) ? undefined : major;
}

/** Turn one probe's raw output into the verdict, without running anything. */
export function readNodeProbe(
  exitCode: number | undefined,
  stdout: string,
  stderr: string,
): NodeProbe {
  const major = parseNodeVersion(stdout);
  if (exitCode !== 0 || major === undefined) {
    // The `command -v node` guard means a zero exit with no version is still a
    // host without Node; a non-zero exit with no diagnostics is the same thing
    // reported differently by a different login shell.
    const detail = redactSecrets(tail(stderr === "" ? stdout : stderr));
    return {
      usable: false,
      reason: exitCode === undefined ? "unreachable" : "missing",
      detail,
    };
  }
  const version = stdout.trim().split(/\s+/u)[0] ?? "";
  if (major < MINIMUM_NODE_MAJOR) {
    return {
      version,
      major,
      usable: false,
      reason: "tooOld",
      detail: `Node ${version}; the remote Armadra core needs ${MINIMUM_NODE_MAJOR} or newer`,
    };
  }
  return { version, major, usable: true, detail: "" };
}

/** Ask the host. */
export async function probeNode(
  dataDir: string,
  host: SshHost,
): Promise<NodeProbe> {
  const argv = nodeProbeArgv(dataDir, host);
  const program = argv.shift() as string;
  const output = await runCommand(program, argv, {
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  if (output.spawnError !== undefined || output.timedOut) {
    return {
      usable: false,
      reason: "unreachable",
      detail: output.timedOut
        ? "The Node probe timed out"
        : `ssh could not be started: ${output.spawnError ?? ""}`,
    };
  }
  return readNodeProbe(output.code, output.stdout, output.stderr);
}

/**
 * The message a person is shown when the host cannot run a remote Worker.
 *
 * It names the requirement rather than the symptom, because "unsupported" on
 * its own is not something anybody can act on.
 */
export function unsupportedMessage(host: SshHost, probe: NodeProbe): string {
  if (probe.reason === "tooOld") {
    return `执行主机 ${host.name} 上的 Node 是 ${probe.version ?? "未知版本"}，远端 Armadra core 需要 ${MINIMUM_NODE_MAJOR} 或更新`;
  }
  if (probe.reason === "unreachable") {
    return `无法在执行主机 ${host.name} 上探测 Node：${probe.detail}`;
  }
  return `执行主机 ${host.name} 上没有 Node。这个构建的远端 Worker 是一份 JavaScript 包，需要目标机自带 Node ${MINIMUM_NODE_MAJOR} 或更新`;
}
