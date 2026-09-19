import { existsSync, readFileSync } from "node:fs";
import { X509Certificate } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import { read as readEndpoints } from "../../desktop/src/core/endpoints";
import { VERSION } from "../../desktop/src/core/instance";
import { endpointsFile, resolveDataDir } from "../../desktop/src/core/paths";
import {
  DEFAULT_DEVICE_NAME,
  DEFAULT_LISTEN,
  USAGE,
  many,
  parseCommandLine,
  parseListen,
  single,
  switched,
  wantsJson,
} from "./cli";
import { serve } from "./serve";
import { SELF_SIGNED_CERT, SELF_SIGNED_DIR } from "./tls";
import { defaultWebRoot } from "./web-root";
import {
  generate,
  readMarker,
  removeDefinition,
  removeMarker,
  writeMarker,
} from "./service/install";
import { render } from "./service/render";
import { DEFAULT_LINES, tail } from "./service/logs";
import { type Spec, fileNameFor, normalizeSpec } from "./service/spec";
import {
  COMPONENT_NAME,
  checkVersion,
  probe,
  replace,
  rollback,
  rollbackAvailable,
  verifyCandidate,
  verifyChecksum,
} from "./service/upgrade";

/**
 * 服务器壳的入口。
 *
 * 一条命令一个函数，全部经由 {@link main}——它拿 argv 与一份 I/O，返回退出码，
 * 从不自己调 `process.exit`。这样每条命令都是可以在用例里跑的，包括那些「什么
 * 都不该发生」的路径（没有 `--confirm` 的升级、拒绝特权账号的安装）。
 *
 * 打包：`scripts/build.mjs` 用 esbuild 把这棵树打成 `out/main.js`（CJS，
 * `--platform=node`），`node-pty` 一类原生模块 `--external`。选 esbuild 是因为
 * core 与桌面壳共用的 electron-vite 也是它，同一套外部化规则不会在两种壳之间
 * 分叉。
 */

export interface MainIo {
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  readonly env: NodeJS.ProcessEnv;
  /** 本模块所在目录，用于往上找检出里的 `apps/web/dist`。 */
  readonly moduleDir: string;
  /** `serve` 装配完成后的回调，用例靠它拿到句柄并停掉。 */
  readonly serving?: (
    running: Awaited<ReturnType<typeof serve>>,
  ) => Promise<void>;
}

export async function main(
  argv: readonly string[],
  io: MainIo,
): Promise<number> {
  const parsed = parseCommandLine(argv);
  if (parsed.kind === "help") {
    io.stdout(`${USAGE}\n`);
    return 0;
  }
  if (parsed.kind === "error") {
    io.stderr(`${parsed.reason}\n`);
    return 2;
  }
  const { command, values } = parsed;
  const json = wantsJson(values);
  const dataDir = resolveDataDir(
    single(values, "--data-dir"),
    process.platform,
    io.env,
  );
  try {
    switch (command) {
      case "version":
        emit(
          io,
          json,
          versionReport(),
          () => `${COMPONENT_NAME} ${VERSION} (node ${process.versions.node})`,
        );
        return 0;
      case "serve":
        return await runServe(values, dataDir, io);
      case "install":
        return runInstall(values, dataDir, io, json);
      case "uninstall":
        return runUninstall(values, dataDir, io, json);
      case "status":
        return runStatus(dataDir, io, json);
      case "logs":
        return runLogs(values, dataDir, io, json);
      case "upgrade":
        return await runUpgrade(values, io, json);
    }
  } catch (error) {
    io.stderr(`${describe(error)}\n`);
    return 1;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function emit(
  io: MainIo,
  json: boolean,
  document: unknown,
  text: () => string,
): void {
  io.stdout(json ? `${JSON.stringify(document, null, 2)}\n` : `${text()}\n`);
}

function versionReport(): Record<string, unknown> {
  return {
    component: COMPONENT_NAME,
    version: VERSION,
    node: process.versions.node,
  };
}

/* ---------------------------------- serve --------------------------------- */

async function runServe(
  values: ReadonlyMap<string, readonly string[]>,
  dataDir: string,
  io: MainIo,
): Promise<number> {
  const listenText = single(values, "--listen") ?? DEFAULT_LISTEN;
  const listen = parseListen(listenText);
  if (listen === undefined) {
    io.stderr(`--listen 不是一个地址：${listenText}\n`);
    return 2;
  }
  const webRoot = single(values, "--web-root") ?? defaultWebRoot(io.moduleDir);
  if (webRoot === undefined) {
    io.stderr(
      "找不到 apps/web 的构建产物：先 pnpm --filter @armadra/web build，或给 --web-root\n",
    );
    return 2;
  }
  const running = await serve({
    listen,
    publicOrigins: many(values, "--public-origin"),
    dataDir: single(values, "--data-dir") ?? dataDir,
    webRoot,
    certFile: single(values, "--tls-cert"),
    keyFile: single(values, "--tls-key"),
    deviceName: single(values, "--device-name") ?? DEFAULT_DEVICE_NAME,
    pairing: !switched(values, "--no-pairing"),
    env: io.env,
    stdout: io.stdout,
    moduleDir: io.moduleDir,
  });
  if (io.serving !== undefined) {
    await io.serving(running);
    return 0;
  }
  await waitForSignal(running, io);
  return 0;
}

/**
 * 跑到收到信号为止。SIGUSR2 再铸一张配对码——运维不必为了让一台新设备加入而
 * 重启服务。
 */
function waitForSignal(
  running: Awaited<ReturnType<typeof serve>>,
  io: MainIo,
): Promise<void> {
  return new Promise((done) => {
    const stop = (): void => {
      void running.stop().then(() => done());
    };
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
    if (process.platform !== "win32") {
      process.on("SIGUSR2", () => {
        const issued = running.pair();
        io.stdout(`armadra-server pairing ${issued.url}\n`);
      });
    }
  });
}

/* --------------------------------- install -------------------------------- */

function specFrom(
  values: ReadonlyMap<string, readonly string[]>,
  dataDir: string,
  io: MainIo,
): Spec {
  const script = process.argv[1];
  const bundled = script === undefined || !/\.(c|m)?js$/.test(script);
  return normalizeSpec({
    identifier: single(values, "--identifier"),
    platform: single(values, "--target-platform"),
    executable: single(values, "--executable") ?? process.execPath,
    script:
      single(values, "--executable") !== undefined || bundled
        ? ""
        : resolve(script as string),
    runAs: single(values, "--run-as"),
    dataDir,
    workingDir: single(values, "--working-dir"),
    logPath: single(values, "--log-file"),
    listen: single(values, "--listen") ?? DEFAULT_LISTEN,
    webRoot: single(values, "--web-root") ?? defaultWebRoot(io.moduleDir),
    publicOrigins: many(values, "--public-origin"),
    certFile: single(values, "--tls-cert"),
    keyFile: single(values, "--tls-key"),
    environment: many(values, "--env"),
  });
}

function runInstall(
  values: ReadonlyMap<string, readonly string[]>,
  dataDir: string,
  io: MainIo,
  json: boolean,
): number {
  const serviceDir = single(values, "--service-dir");
  if (serviceDir === undefined || !isAbsolute(serviceDir)) {
    io.stderr("install 需要 --service-dir 绝对目录\n");
    return 2;
  }
  if (single(values, "--run-as") === undefined) {
    io.stderr("install 需要 --run-as 账号；服务账号永远不取当前用户\n");
    return 2;
  }
  const spec = specFrom(values, dataDir, io);
  const written = generate(spec, serviceDir);
  writeMarker(dataDir, { spec, path: written.path });
  emit(
    io,
    json,
    { command: "install", path: written.path, spec, registered: false },
    () =>
      [
        `已生成服务定义：${written.path}`,
        "没有注册、没有启用、没有启动任何东西——请自己审阅并注册。",
        "",
        written.content.trimEnd(),
      ].join("\n"),
  );
  return 0;
}

function runUninstall(
  values: ReadonlyMap<string, readonly string[]>,
  dataDir: string,
  io: MainIo,
  json: boolean,
): number {
  const marker = readMarker(dataDir);
  const identifier = single(values, "--identifier");
  const serviceDir = single(values, "--service-dir");
  if (
    marker === undefined &&
    (identifier === undefined || serviceDir === undefined)
  ) {
    io.stderr(
      "这个数据目录没有记下任何服务定义；要删别处的定义请同时给 --service-dir 与 --identifier\n",
    );
    return 2;
  }
  const spec =
    marker !== undefined && identifier === undefined
      ? marker.spec
      : normalizeSpec({
          ...(marker?.spec ?? {}),
          identifier,
          // 只是为了拼出文件名与归属检查，账号与路径沿用记下来的那份。
          runAs: marker?.spec.runAs ?? "armadra",
          executable: marker?.spec.executable ?? "/nonexistent",
          dataDir: marker?.spec.dataDir ?? dataDir,
          webRoot: marker?.spec.webRoot ?? "/nonexistent",
          listen: marker?.spec.listen ?? DEFAULT_LISTEN,
        });
  const path =
    serviceDir === undefined
      ? (marker?.path as string)
      : join(serviceDir, fileNameFor(spec));
  const outcome = removeDefinition(spec, path);
  if (outcome !== "foreign") removeMarker(dataDir);
  emit(io, json, { command: "uninstall", path, outcome }, () =>
    outcome === "removed"
      ? `已删除服务定义：${path}`
      : outcome === "missing"
        ? `定义文件已经不在：${path}`
        : `${path} 不是本命令生成的，一个字节都没动`,
  );
  return outcome === "foreign" ? 1 : 0;
}

/* --------------------------------- status --------------------------------- */

function runStatus(dataDir: string, io: MainIo, json: boolean): number {
  const marker = readMarker(dataDir);
  let definition: Record<string, unknown> = { state: "none" };
  if (marker !== undefined) {
    const expected = render(marker.spec);
    let actual: string | undefined;
    try {
      actual = readFileSync(marker.path, "utf8");
    } catch {
      actual = undefined;
    }
    definition = {
      state:
        actual === undefined
          ? "missing"
          : actual === expected
            ? "matches"
            : "drifted",
      path: marker.path,
      identifier: marker.spec.identifier,
      runAs: marker.spec.runAs,
      listen: marker.spec.listen,
    };
  }
  const endpoints = readEndpoints(endpointsFile(dataDir));
  const document = {
    component: COMPONENT_NAME,
    version: VERSION,
    node: process.versions.node,
    dataDir,
    definition,
    tls: tlsStatus(dataDir, marker?.spec.certFile ?? ""),
    core:
      endpoints.runtime === undefined
        ? { running: false }
        : {
            running: true,
            instanceId: endpoints.runtime.instanceId,
            processId: endpoints.runtime.processId,
            http: endpoints.runtime.http,
          },
  };
  emit(io, json, document, () =>
    [
      `${COMPONENT_NAME} ${VERSION}（node ${process.versions.node}）`,
      `数据目录：${dataDir}`,
      `服务定义：${String(definition.state)}${definition.path === undefined ? "" : ` ${String(definition.path)}`}`,
      `TLS：${document.tls.kind}${document.tls.notAfter === undefined ? "" : `，有效期至 ${document.tls.notAfter}`}`,
      `core：${document.core.running ? `在跑（pid ${String(document.core.processId)}）` : "没在跑"}`,
    ].join("\n"),
  );
  return 0;
}

function tlsStatus(
  dataDir: string,
  certFile: string,
): { kind: string; certFile?: string; notAfter?: string } {
  const path =
    certFile !== ""
      ? certFile
      : join(dataDir, SELF_SIGNED_DIR, SELF_SIGNED_CERT);
  if (!existsSync(path)) {
    return { kind: certFile !== "" ? "运维提供（文件不在）" : "尚未生成" };
  }
  try {
    const parsed = new X509Certificate(readFileSync(path, "utf8"));
    return {
      // 自签名的那张在 status 里必须显式标出来：浏览器会拦它。
      kind: certFile !== "" ? "运维提供" : "自签名",
      certFile: path,
      notAfter: parsed.validTo,
    };
  } catch {
    return { kind: "读不出来", certFile: path };
  }
}

/* ---------------------------------- logs ---------------------------------- */

function runLogs(
  values: ReadonlyMap<string, readonly string[]>,
  dataDir: string,
  io: MainIo,
  json: boolean,
): number {
  const marker = readMarker(dataDir);
  const path =
    single(values, "--log-file") ??
    marker?.spec.logPath ??
    join(dataDir, "server.log");
  const lines = Number(single(values, "--lines") ?? DEFAULT_LINES);
  const read = tail(path, lines);
  emit(io, json, { command: "logs", path, lines: read }, () => read.join("\n"));
  return 0;
}

/* --------------------------------- upgrade -------------------------------- */

async function runUpgrade(
  values: ReadonlyMap<string, readonly string[]>,
  io: MainIo,
  json: boolean,
): Promise<number> {
  const script = process.argv[1];
  const target =
    script !== undefined && /\.(c|m)?js$/.test(script)
      ? resolve(script)
      : process.execPath;
  if (switched(values, "--rollback")) {
    if (!rollbackAvailable(target)) {
      io.stderr(`${target} 没有可回滚的上一份\n`);
      return 1;
    }
    if (!switched(values, "--confirm")) {
      emit(
        io,
        json,
        { command: "upgrade", mode: "rollback", applied: false, target },
        () =>
          `计划：把 ${target} 换回上一次升级换下来的那一份。加 --confirm 才会真的动。`,
      );
      return 0;
    }
    const failed = rollback(target);
    emit(
      io,
      json,
      { command: "upgrade", mode: "rollback", applied: true, target, failed },
      () => `已回滚 ${target}；失败的那一份留在 ${failed}`,
    );
    return 0;
  }
  const candidate = single(values, "--binary");
  if (candidate === undefined) {
    io.stderr("upgrade 需要 --binary 绝对路径，或者 --rollback\n");
    return 2;
  }
  if (resolve(candidate) === target) {
    io.stderr("候选和装着的那个是同一个文件\n");
    return 2;
  }
  verifyCandidate(candidate);
  const checksumFile = single(values, "--checksum-file");
  const digest =
    checksumFile === undefined
      ? undefined
      : verifyChecksum(candidate, checksumFile);
  const report = await probe(candidate);
  checkVersion(report, single(values, "--expect-version"));
  const plan = {
    command: "upgrade",
    mode: "binary",
    candidate: resolve(candidate),
    target,
    candidateVersion: report.version,
    sha256: digest,
    applied: false,
  };
  if (!switched(values, "--confirm")) {
    emit(io, json, plan, () =>
      [
        `计划：用 ${plan.candidate}（${report.version}）替换 ${target}`,
        digest === undefined ? "没有给校验文件" : `sha256 已核对：${digest}`,
        "加 --confirm 才会真的动；在那之前磁盘上一个字节都没变。",
      ].join("\n"),
    );
    return 0;
  }
  const previous = replace(candidate, target);
  emit(
    io,
    json,
    { ...plan, applied: true, previous },
    () =>
      `已替换 ${target}；换下来的那一份在 ${previous}，回滚用 upgrade --rollback --confirm`,
  );
  return 0;
}

/* --------------------------------- 进程入口 -------------------------------- */

const isEntryPoint =
  typeof require !== "undefined" &&
  typeof module !== "undefined" &&
  require.main === module;

if (isEntryPoint) {
  void main(process.argv.slice(2), {
    stdout: (line) => process.stdout.write(line),
    stderr: (line) => process.stderr.write(line),
    env: process.env,
    moduleDir: typeof __dirname === "string" ? __dirname : process.cwd(),
  }).then((code) => {
    if (code !== 0) process.exitCode = code;
  });
}
