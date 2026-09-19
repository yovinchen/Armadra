/**
 * 三件只有操作系统知道的事：内存压力、电源来源、交换区。移植自
 * `apps/runtime/src/resources/platform_memory.rs` 与 `platform_power.rs`。
 *
 * 共同的规矩：**没有信号就是 `null`**。每一个都宁可什么都不说，也不说一个没人做过
 * 的断言。
 */

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type { PowerSource } from "./sample";

function run(tool: string, args: readonly string[]): string | undefined {
  try {
    return execFileSync(tool, [...args], {
      encoding: "utf8",
      timeout: 3_000,
      maxBuffer: 1 << 20,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return undefined;
  }
}

/* ------------------------------- 内存压力 -------------------------------- */

/**
 * `"normal"` / `"warning"` / `"critical"`，或者这个平台没有压力信号、读失败时的
 * `null`。
 *
 * 为什么不从 used/total 算：现代内核上大部分「已用」是可回收的——文件缓存、压缩页、
 * 可清除缓冲区——所以一台坐在 95% 已用的机器常常一点压力都没有，把比例打扮成压力
 * 等级会告诉读者相反的事。面板另外单独显示已用比例；这是内核对**另一个问题**的
 * 回答，只在内核真的回答它的地方报。
 *
 * macOS 把它发布为 `kern.memorystatus_vm_pressure_level`，Activity Monitor 的内存
 * 压力图着色用的就是这个值。别的平台一律 `null`。
 */
export function memoryPressure(): string | null {
  if (process.platform !== "darwin") {
    // Linux 有 PSI（`/proc/pressure/memory`），但它报的是**停顿时间**而不是等级，
    // 把停顿百分比映射成三档等于这个模块自己发明阈值。Windows 压根没有对应物。
    return null;
  }
  const output = run("sysctl", ["-n", "kern.memorystatus_vm_pressure_level"]);
  if (output === undefined) return null;
  return pressureLevelName(Number.parseInt(output.trim(), 10));
}

/**
 * XNU 的三个等级（`kern_memorystatus.h`）：1 normal、2 warning、4 critical。别的
 * 都是这段代码读不懂的值，而一个认不出来的等级是未知，不是最接近的猜测。
 */
export function pressureLevelName(level: number): string | null {
  if (level === 1) return "normal";
  if (level === 2) return "warning";
  if (level === 4) return "critical";
  return null;
}

/* -------------------------------- 交换区 --------------------------------- */

/**
 * 交换区总量与已用。`node:os` 不报它，所以逐平台读；读不到就是两个 `null`，而不是
 * 一台没有交换区的机器。
 */
export function swapUsage(): {
  totalBytes: number | null;
  usedBytes: number | null;
} {
  if (process.platform === "darwin") {
    const output = run("sysctl", ["-n", "vm.swapusage"]);
    if (output === undefined) return { totalBytes: null, usedBytes: null };
    return parseSwapUsage(output);
  }
  if (process.platform === "linux") {
    try {
      return parseMeminfoSwap(readFileSync("/proc/meminfo", "utf8"));
    } catch {
      return { totalBytes: null, usedBytes: null };
    }
  }
  return { totalBytes: null, usedBytes: null };
}

/** `total = 2048.00M  used = 512.25M  free = ...` */
export function parseSwapUsage(text: string): {
  totalBytes: number | null;
  usedBytes: number | null;
} {
  const read = (label: string): number | null => {
    const match = new RegExp(`${label}\\s*=\\s*([0-9.]+)([KMG])`).exec(text);
    if (match === null) return null;
    const value = Number.parseFloat(match[1] as string);
    if (!Number.isFinite(value)) return null;
    const unit = match[2] as string;
    const scale = unit === "G" ? 1 << 30 : unit === "M" ? 1 << 20 : 1 << 10;
    return Math.round(value * scale);
  };
  return { totalBytes: read("total"), usedBytes: read("used") };
}

/** `SwapTotal:  2097148 kB` / `SwapFree:  2097148 kB` */
export function parseMeminfoSwap(text: string): {
  totalBytes: number | null;
  usedBytes: number | null;
} {
  const read = (label: string): number | null => {
    const match = new RegExp(`^${label}:\\s+(\\d+) kB$`, "m").exec(text);
    if (match === null) return null;
    return Number.parseInt(match[1] as string, 10) * 1024;
  };
  const total = read("SwapTotal");
  const free = read("SwapFree");
  return {
    totalBytes: total,
    usedBytes: total === null || free === null ? null : total - free,
  };
}

/* -------------------------------- 电源来源 -------------------------------- */

const UNKNOWN_POWER: PowerSource = {
  source: null,
  batteryPercent: null,
  charging: null,
};

/**
 * 读这台机器的电源来源——**不是**把它保持唤醒。
 *
 * macOS 解析 `pmset -g batt`，Linux 读 `/sys/class/power_supply`，其余一律未知而
 * 不是猜。
 */
export function powerSource(): PowerSource {
  if (process.platform === "darwin") {
    const output = run("/usr/bin/pmset", ["-g", "batt"]);
    return output === undefined ? UNKNOWN_POWER : parsePmset(output);
  }
  if (process.platform === "linux") return linuxPowerSource();
  // Windows：`GetSystemPowerStatus` 能回答这个，但这一轮没有办法在一台真机上核验，
  // 而一个没核验过的数字比一个诚实的空白更糟（设计 §8）。
  return UNKNOWN_POWER;
}

/**
 * `pmset -g batt` 第一行打印来源，每块电池一行：
 *
 * ```text
 * Now drawing from 'AC Power'
 *  -InternalBattery-0 (id=…)  91%; charging; 0:32 remaining present: true
 * ```
 *
 * 没有电池的台式机只打印来源那一行，那正好是「接着市电、没有电池百分比」这种情况。
 */
export function parsePmset(text: string): PowerSource {
  let source: string | null = null;
  if (text.includes("'AC Power'")) source = "ac";
  else if (text.includes("'Battery Power'")) source = "battery";
  let batteryPercent: number | null = null;
  let charging: boolean | null = null;
  for (const line of text.split("\n").slice(1)) {
    const index = line.indexOf("%");
    if (index < 0) continue;
    const head = line.slice(0, index).trim().split(/\s+/).pop() ?? "";
    const value = Number.parseFloat(head);
    if (!Number.isFinite(value) || value < 0 || value > 100) continue;
    const rest = line.slice(index);
    batteryPercent = value;
    charging = rest.includes("charging") && !rest.includes("discharging");
    break;
  }
  return { source, batteryPercent, charging };
}

function linuxPowerSource(): PowerSource {
  const root = "/sys/class/power_supply";
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return UNKNOWN_POWER;
  }
  const read = (path: string): string | undefined => {
    try {
      return readFileSync(path, "utf8").trim();
    } catch {
      return undefined;
    }
  };
  let mains: boolean | undefined;
  let batteryPercent: number | null = null;
  let charging: boolean | null = null;
  for (const entry of entries) {
    const path = join(root, entry);
    const kind = read(join(path, "type")) ?? "";
    if (kind === "Mains") {
      const online = read(join(path, "online"));
      if (online !== undefined) mains = (mains ?? false) || online === "1";
      continue;
    }
    if (kind === "Battery" && batteryPercent === null) {
      const capacity = Number.parseFloat(read(join(path, "capacity")) ?? "");
      if (Number.isFinite(capacity) && capacity >= 0 && capacity <= 100) {
        batteryPercent = capacity;
      }
      const status = read(join(path, "status"));
      if (status !== undefined) charging = status === "Charging";
    }
  }
  return {
    source: mains === undefined ? null : mains ? "ac" : "battery",
    batteryPercent,
    charging,
  };
}
