import {
  chmodSync,
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { render, owns } from "./render";
import {
  DEFINITION_MODE,
  MARKER_NAME,
  ServiceDefinitionError,
  type Spec,
  fileNameFor,
} from "./spec";

/**
 * 把渲染好的定义落到磁盘，以及把「落在哪儿」记在数据目录里。
 *
 * 目录先建成 0700，文件写成临时名再改名：服务管理器绝不会读到一份写了一半的
 * 定义。标记文件是 0600，因为它挨着 core 自己的私有状态——它里面没有凭据，但
 * 它确实记着这台机器的部署形状。
 */

export interface Marker {
  readonly spec: Spec;
  readonly path: string;
}

export function markerPath(dataDir: string): string {
  return join(dataDir, MARKER_NAME);
}

export function writeMarker(dataDir: string, marker: Marker): void {
  writeAtomic(
    markerPath(dataDir),
    `${JSON.stringify(marker, null, 2)}\n`,
    0o600,
  );
}

export function readMarker(dataDir: string): Marker | undefined {
  let raw: string;
  try {
    raw = readFileSync(markerPath(dataDir), "utf8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ServiceDefinitionError("记下的服务定义读不出来");
  }
  const marker = parsed as Marker;
  if (
    marker === null ||
    typeof marker !== "object" ||
    typeof marker.path !== "string" ||
    marker.path === ""
  ) {
    throw new ServiceDefinitionError("记下的服务定义没有路径");
  }
  return marker;
}

export function removeMarker(dataDir: string): void {
  rmSync(markerPath(dataDir), { force: true });
}

/**
 * 写出定义并记下标记。返回写到哪儿与写了什么，好让调用方原样打印——运维要审阅
 * 的就是这份内容。
 */
export function generate(
  spec: Spec,
  serviceDir: string,
): { path: string; content: string } {
  if (!isAbsolute(serviceDir)) {
    throw new ServiceDefinitionError(
      "服务定义无效：--service-dir 必须是绝对路径",
    );
  }
  const content = render(spec);
  mkdirSync(serviceDir, { recursive: true, mode: 0o700 });
  const directory = lstatSync(serviceDir);
  if (!directory.isDirectory() || directory.isSymbolicLink()) {
    throw new ServiceDefinitionError(
      "服务定义无效：--service-dir 必须是一个真目录",
    );
  }
  const path = join(serviceDir, fileNameFor(spec));
  writeAtomic(path, content, DEFINITION_MODE);
  return { path, content };
}

/**
 * 删掉本命令生成过的那份定义。通不过归属检查的文件一个字节都不动，返回值说明
 * 到底发生了什么，`uninstall` 据此报告而不是假装成功。
 */
export function removeDefinition(
  spec: Spec,
  path: string,
): "removed" | "missing" | "foreign" {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return "missing";
  }
  if (!owns(content, spec)) return "foreign";
  rmSync(path, { force: true });
  return "removed";
}

/**
 * 写临时文件 → 设权限 → 改名。`writeFileSync` 的 mode 受 umask 影响，所以权限
 * 单独设一次；改名是原子的，读者要么看到旧的要么看到新的。
 */
function writeAtomic(path: string, content: string, mode: number): void {
  const temporary = `${path}.tmp-${process.pid}`;
  const handle = openSync(temporary, "wx", mode);
  try {
    writeSync(handle, content);
  } finally {
    closeSync(handle);
  }
  try {
    chmodSync(temporary, mode);
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}
