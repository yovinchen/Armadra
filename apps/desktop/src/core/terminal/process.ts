import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

/**
 * The process tree, read once per question.
 *
 * `sysinfo`'s job in the Rust Runtime, done with the two commands that are on
 * every machine: one `ps` on unix, `taskkill /T` on Windows. Walking a tree
 * therefore costs the same as looking at a single process, which matters
 * because `terminate` walks one for every terminal a user closes.
 */

export interface ProcessRow {
  readonly parent: number;
  readonly argv: string;
}

/**
 * One `ps` line into `[pid, ppid, argv]`.
 *
 * `ps` right-aligns `pid` and `ppid` in fixed-width columns, so the separator
 * between them is usually several spaces. Splitting on "a whitespace char"
 * would yield an empty second field for those lines and drop them — which is
 * silent and total: with the table empty, a process tree is just its root and
 * a terminate would signal a shell while leaving the agent under it running.
 * The columns are therefore split on *runs* of whitespace, and only the first
 * two, so that an argv containing spaces survives intact.
 */
export function parseProcessLine(
  line: string,
): readonly [number, number, string] | undefined {
  const match = /^\s*(\S+)\s+(\S+)\s+([\s\S]*)$/.exec(line);
  if (match === null) return undefined;
  const pid = Number.parseInt(match[1] as string, 10);
  const parent = Number.parseInt(match[2] as string, 10);
  if (!Number.isInteger(pid) || !Number.isInteger(parent)) return undefined;
  if (!/^\d+$/.test(match[1] as string)) return undefined;
  if (!/^\d+$/.test(match[2] as string)) return undefined;
  return [pid, parent, (match[3] as string).trimStart()];
}

/** `pid -> { parent, argv }` for every process of this machine. */
export function processTable(): Map<number, ProcessRow> {
  const table = new Map<number, ProcessRow>();
  if (process.platform === "win32") return table;
  let output: string;
  try {
    output = execFileSync("ps", ["-Ao", "pid=,ppid=,args="], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    return table;
  }
  for (const line of output.split("\n")) {
    const parsed = parseProcessLine(line);
    if (parsed !== undefined) {
      table.set(parsed[0], { parent: parsed[1], argv: parsed[2] });
    }
  }
  return table;
}

/** `root` first, then its descendants breadth-first. */
export function processTree(
  root: number,
  table: Map<number, ProcessRow> = processTable(),
): number[] {
  const tree = [root];
  for (let index = 0; index < tree.length; index += 1) {
    const parent = tree[index] as number;
    for (const [pid, row] of table) {
      if (row.parent === parent && !tree.includes(pid)) tree.push(pid);
    }
  }
  return tree;
}

/** argv of everything running under `root`, excluding `root` itself. */
export function childCommands(
  root: number,
  table: Map<number, ProcessRow> = processTable(),
): string[] {
  const frontier = [root];
  const commands: string[] = [];
  for (let index = 0; index < frontier.length; index += 1) {
    const parent = frontier[index] as number;
    for (const [pid, row] of table) {
      if (row.parent === parent && !frontier.includes(pid)) {
        frontier.push(pid);
        commands.push(row.argv);
      }
    }
  }
  return commands;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * SIGTERM the whole tree, wait up to two seconds, then SIGKILL the survivors
 * (contract §15.4). Children are signalled before their parent so a shell
 * cannot reap and restart them.
 */
export async function terminateTree(root: number): Promise<void> {
  if (process.platform === "win32") {
    for (const pid of processTree(root)) {
      try {
        execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
          stdio: "ignore",
        });
      } catch {
        // Already gone.
      }
    }
    return;
  }
  const tree = processTree(root).reverse();
  for (const pid of tree) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await delay(100);
    if (!tree.some(alive)) return;
  }
  for (const pid of tree) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}
