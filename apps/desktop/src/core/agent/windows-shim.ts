import { readFileSync, statSync } from "node:fs";
import { win32 } from "node:path";

/**
 * 读 npm / pnpm 在 Windows 上给 CLI 生成的包装脚本，找出它真正运行的程序。
 *
 * npm 装的 CLI 在 Windows 上是 `claude.cmd`（旁边还有 `claude.ps1` 与无扩展名
 * 的 sh 版本）。批处理用 `%*` 把参数交给真正的程序，这一步 `cmd.exe` 会把参数
 * 文本再读一遍：含 `"` 的值在第二遍里把引号翻了面，`&`、`|` 就当成命令执行了
 * ——敲进去的那一行怎么引用都挡不住（状态文档 §54.3）。所以启动行绕过包装：
 * 包装脚本的格式是生成的、固定的，读出它最后那条命令——`node <脚本>`，或者
 * 一个原生程序——直接启动它。
 *
 * 认的格式（样本见 `windows-shim.test.ts`）：
 *
 *   * npm 7–10（cmd-shim 4–7）：`SET "_prog=%dp0%\node.exe"` / `SET "_prog=node"`
 *     两支，最后一行 `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% &
 *     "%_prog%"  "%dp0%\node_modules\…\cli.js" %*`；目标没有 shebang 时（包里
 *     带的原生程序）只有 `"%dp0%\node_modules\…\claude.exe"   %*`。
 *   * npm 6 与 pnpm：`@IF EXIST "%~dp0\node.exe" ( "%~dp0\node.exe" "…" %* )
 *     ELSE ( … node "…" %* )`，pnpm 多一段 `NODE_PATH`。
 *   * 同一套生成器写的 `.ps1`：`& "$basedir/node$exe" "$basedir/…" $args`。
 *
 * 读不出来（手写的批处理、别的生成器）就答 `undefined`，调用方照旧用包装本身，
 * 由 `shellCommandLine` 只放行 `cmd.exe` 两遍都读不坏的参数。
 *
 * pnpm 的包装还设 `NODE_PATH`（指向它的全局 store）：直接启动时不带它。CLI
 * 都是打包好的单文件或原生程序，不靠 `NODE_PATH` 找依赖；靠它的包会在启动时
 * 报找不到模块，而不是悄悄跑错。
 */

/** 包装背后的真正启动方式：`program` 后面先跟 `args`，再跟 CLI 自己的参数。 */
export interface ShimTarget {
  readonly program: string;
  readonly args: readonly string[];
}

/** 文件系统的三个问题，注入给用例（Windows 路径在别的平台上也能测）。 */
export interface ShimProbe {
  readonly isFile: (path: string) => boolean;
  readonly read: (path: string) => string | undefined;
  /** PATH 上的程序（`node` → `C:\Program Files\nodejs\node.exe`）。 */
  readonly which: (name: string) => string | undefined;
}

export function fileProbe(
  which: (name: string) => string | undefined,
): ShimProbe {
  return {
    isFile: (path) => {
      try {
        return statSync(path).isFile();
      } catch {
        return false;
      }
    },
    read: (path) => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return undefined;
      }
    },
    which,
  };
}

const SHIM = /\.(cmd|bat|ps1)$/i;

/**
 * `path` 是包装脚本时答它背后的程序；不是包装、或读不出来时答 `undefined`。
 * `.cmd` 读不出来时再试同名的 `.ps1`——两份是同一个生成器一起写的。
 */
export function shimTarget(
  path: string,
  probe: ShimProbe,
): ShimTarget | undefined {
  const match = SHIM.exec(path);
  if (match === null) return undefined;
  const stem = path.slice(0, -match[0].length);
  const tries =
    match[1]?.toLowerCase() === "ps1"
      ? [path]
      : [path, ...(probe.isFile(`${stem}.ps1`) ? [`${stem}.ps1`] : [])];
  for (const candidate of tries) {
    const text = probe.read(candidate);
    if (text === undefined) continue;
    const target = candidate.toLowerCase().endsWith(".ps1")
      ? parsePs1Shim(text, candidate, probe)
      : parseCmdShim(text, candidate, probe);
    if (target !== undefined) return target;
  }
  return undefined;
}

/* ---------------------------------- .cmd ---------------------------------- */

/** 一个 `.cmd` 包装背后的程序，读不出来答 `undefined`。 */
export function parseCmdShim(
  text: string,
  shimPath: string,
  probe: ShimProbe,
): ShimTarget | undefined {
  const dir = win32.dirname(shimPath);
  const expand = (value: string): string =>
    value.replace(/%~dp0|%dp0%/gi, `${dir}\\`);
  // `SET "_prog=…"` 的两支：包旁边的 node.exe，或 PATH 上的 node。
  const progs = [...text.matchAll(/^\s*@?SET\s+"_prog=([^"\r\n]*)"/gim)].map(
    (found) => found[1] as string,
  );
  const lines = text
    .split(/\r?\n/)
    .filter((line) => /%\*\s*$/.test(line))
    .map((line) => line.replace(/%\*\s*$/, ""));
  for (const line of lines) {
    const tokens = words(afterLastAmpersand(line).replace(/^\s*@/, ""));
    if (tokens === undefined || tokens.length === 0) continue;
    const [head, ...rest] = tokens as [string, ...string[]];
    const heads = /^%_prog%$/i.test(head) ? progs : [head];
    const target = resolveTarget(heads.map(expand), rest.map(expand), probe);
    if (target !== undefined) return target;
  }
  return undefined;
}

/* ---------------------------------- .ps1 ---------------------------------- */

/** 一个 `.ps1` 包装背后的程序，读不出来答 `undefined`。 */
export function parsePs1Shim(
  text: string,
  shimPath: string,
  probe: ShimProbe,
): ShimTarget | undefined {
  const dir = win32.dirname(shimPath);
  const expand = (value: string): string =>
    value.replace(/\$basedir/g, dir).replace(/\$exe/g, ".exe");
  const lines = text
    .split(/\r?\n/)
    .filter((line) => /\$args\s*$/.test(line) && line.includes("&"))
    .map((line) => line.replace(/\$args\s*$/, ""));
  for (const line of lines) {
    const tokens = words(line.slice(line.lastIndexOf("&") + 1));
    if (tokens === undefined || tokens.length === 0) continue;
    const [head, ...rest] = tokens as [string, ...string[]];
    const target = resolveTarget([expand(head)], rest.map(expand), probe);
    if (target !== undefined) return target;
  }
  return undefined;
}

/* --------------------------------- shared --------------------------------- */

/**
 * 候选的程序依次试，第一个存在的就是；后面的词原样跟上，最后一个（脚本）
 * 必须存在。只有一个词时它就是包里的原生程序。
 */
function resolveTarget(
  heads: readonly string[],
  rest: readonly string[],
  probe: ShimProbe,
): ShimTarget | undefined {
  if (rest.some(unexpanded)) return undefined;
  const script = rest.at(-1);
  if (script !== undefined && !probe.isFile(win32.normalize(script))) {
    return undefined;
  }
  for (const head of heads) {
    if (unexpanded(head)) continue;
    const program = programPath(head, probe);
    if (program === undefined) continue;
    if (rest.length === 0 && !/\.(exe|com)$/i.test(program)) continue;
    return {
      program,
      args: rest.map((word, index) =>
        index === rest.length - 1 ? win32.normalize(word) : word,
      ),
    };
  }
  return undefined;
}

/** 带路径的要存在；光一个名字（`node`）按 PATH 找。 */
function programPath(head: string, probe: ShimProbe): string | undefined {
  if (/[\\/]/.test(head)) {
    const path = win32.normalize(head);
    return probe.isFile(path) ? path : undefined;
  }
  return probe.which(head.replace(/\.exe$/i, ""));
}

/** 还剩没展开的变量（`%NODE_EXE%`、`$node`）：不是认得的格式。 */
function unexpanded(word: string): boolean {
  return /%[^%\s]+%|\$[A-Za-z_]/.test(word);
}

/** `a & b & "prog" "x"` → `"prog" "x"`：只看引号外的最后一个 `&`。 */
function afterLastAmpersand(line: string): string {
  let quoted = false;
  let cut = 0;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') quoted = !quoted;
    else if (char === "&" && !quoted) cut = index + 1;
  }
  return line.slice(cut);
}

/** 按空白切词，`"…"` 里的空白不切；引号不配对答 `undefined`。 */
function words(text: string): string[] | undefined {
  const out: string[] = [];
  const pattern = /"([^"]*)"|(\S+)/g;
  for (const found of text.matchAll(pattern)) {
    const word = found[1] ?? found[2] ?? "";
    if (found[2]?.includes('"')) return undefined;
    out.push(word);
  }
  return out;
}
