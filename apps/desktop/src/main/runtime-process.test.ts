import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeRecord } from "../shell-core/runtime/identity";
import {
  RuntimeProcess,
  addressIsHeld,
  CORE_PROCESS_MARKER,
  coreEntry,
  externalRuntimeBase,
  processCommandLine,
  isPackagedShell,
  setPackagedShell,
  stopStaleRuntime,
  waitForExit,
  waitUntilAddressIsFree,
} from "./runtime-process";

/**
 * 这一半需要一个真的操作系统进程：公告从一根真的管道上读回来、SIGTERM 只发给
 * 认得出来的那个 core、以及「地址空出来了」到底是什么意思。这几件事对着假对象
 * 一文不值，所以它们真的起进程。
 */

const unix = process.platform !== "win32";
const directories: string[] = [];

function temporary(): string {
  const path = mkdtempSync(join(tmpdir(), "armadra-runtime-test-"));
  directories.push(path);
  return path;
}

afterEach(() => {
  for (const path of directories.splice(0))
    rmSync(path, { recursive: true, force: true });
});

/** Reaches into the holder the way `RuntimeProcess::holding` does in Rust. */
function holding(child: ReturnType<typeof spawn>): RuntimeProcess {
  const runtime = new RuntimeProcess();
  (runtime as unknown as { child: unknown }).child = child;
  const stdout = child.stdout;
  if (stdout) {
    (
      runtime as unknown as { watchOutput(s: NodeJS.ReadableStream): void }
    ).watchOutput(stdout);
  }
  return runtime;
}

describe.runIf(unix)("停掉这个壳自己起的 core", () => {
  it("SIGTERM，而且等它真的退出来", async () => {
    const child = spawn("/bin/sh", ["-c", "sleep 30"], {
      stdio: ["pipe", "ignore", "ignore"],
    });
    const runtime = holding(child);
    await expect(runtime.stop()).resolves.toBeUndefined();
    expect(child.signalCode).toBe("SIGTERM");
    // 手上没有子进程时再停一次是空操作，不是失败。
    await expect(runtime.stop()).resolves.toBeUndefined();
  });

  it("一次没确认的停止不会在第二次退出时读成成功", async () => {
    // 走过 SIGKILL 那一支的 core 留下的状态：这里直接摆出那个状态，因为触发它
    // 要等满 12 秒的预算，而这条用例守的是**那之后**的事。
    const runtime = new RuntimeProcess();
    (runtime as unknown as { shutdownFailed: boolean }).shutdownFailed = true;
    await expect(runtime.stop()).rejects.toThrow(/previous core shutdown/);
    await expect(runtime.stop()).rejects.toThrow(/previous core shutdown/);
  });
});

describe.runIf(unix)("the instance announcement", () => {
  it("is learned from the child's own stdout, among log lines", async () => {
    const child = spawn(
      "/bin/sh",
      [
        "-c",
        "echo 'armadra-runtime instance fake-run-7 build test'; " +
          "echo '  INFO armadra_runtime: listening'; sleep 5",
      ],
      { stdio: ["pipe", "pipe", "ignore"] },
    );
    const runtime = holding(child);
    const deadline = Date.now() + 5_000;
    while (runtime.announcedInstance() === undefined && Date.now() < deadline) {
      await new Promise((done) => setTimeout(done, 20));
    }
    expect(runtime.announcedInstance()).toBe("fake-run-7");
    child.kill("SIGKILL");
    await waitForExit(child, 2_000);
  });
});

describe.runIf(unix)("taking the address back", () => {
  /**
   * A stand-in for the Runtime a previous shell left behind: a script named
   * like the real binary, started with the flag only the shell's own spawn
   * passes, so the process-table check sees what it would see in production.
   */
  function staleStandIn(directory: string): ReturnType<typeof spawn> {
    // 命令行要同时有 `core/main.js` 与 `--desktop-control-stdin`，进程表那一关
    // 看到的就和生产里一样。
    mkdirSync(join(directory, "core"), { recursive: true });
    const program = join(directory, "core", "main.js");
    writeFileSync(program, "#!/bin/sh\nsleep 30\n");
    chmodSync(program, 0o700);
    return spawn(
      program,
      ["--desktop-control-stdin", "--listen", "unix:/tmp/x.sock"],
      {
        stdio: ["ignore", "ignore", "ignore"],
      },
    );
  }

  it("recognises a core a previous shell left, and stops it with SIGTERM", async () => {
    const stale = staleStandIn(temporary());
    const pid = stale.pid as number;
    const commandLine = await processCommandLine(pid);
    expect(commandLine, "the stand-in should be running").toBeDefined();
    expect(commandLine).toContain("--desktop-control-stdin");

    const record: RuntimeRecord = {
      instanceId: "run-0",
      processId: pid,
      socket: "/tmp/x.sock",
      pipe: undefined,
      http: undefined,
    };
    await stopStaleRuntime(record);
    const exit = await waitForExit(stale, 5_000);
    expect(exit, "the stale core ignored the stop request").toBeDefined();
    // SIGTERM，不是 SIGKILL：core 自己的处理才会把 tmux 会话解绑而不是结束掉。
    expect(exit?.signal).toBe("SIGTERM");
  });

  it("never signals a process that is not one of our cores", async () => {
    const other = spawn("/bin/sleep", ["30"], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    const record: RuntimeRecord = {
      instanceId: "run-0",
      processId: other.pid as number,
      socket: "/tmp/x.sock",
      pipe: undefined,
      http: undefined,
    };
    await expect(stopStaleRuntime(record)).rejects.toThrow(
      /not an Armadra core/,
    );
    expect(
      await waitForExit(other, 300),
      "an unrelated process was signalled",
    ).toBeUndefined();
    other.kill("SIGKILL");
    await waitForExit(other, 2_000);

    // A pid nobody holds is a dead record, not a licence to signal pid reuse.
    await expect(
      stopStaleRuntime({
        instanceId: "",
        processId: 0x7fff_fffe,
        socket: undefined,
        pipe: undefined,
        http: undefined,
      }),
    ).rejects.toThrow(/no longer running/);
  });

  it("reads an address as held only while something accepts on it", async () => {
    const socket = join(temporary(), "runtime.sock");
    const address = { kind: "socket", path: socket } as const;
    expect(await addressIsHeld(address)).toBe(false);

    const server = createServer();
    await new Promise<void>((done) => server.listen(socket, done));
    expect(await addressIsHeld(address)).toBe(true);

    // A Runtime that exits leaves the inode behind; a refused connection is
    // what tells the shell the address is its to take.
    await new Promise<void>((done) => server.close(() => done()));
    await expect(waitUntilAddressIsFree(address)).resolves.toBeUndefined();
  });
});

describe("是不是一份打好包的应用", () => {
  it("答案来自 Electron，不是环境变量", () => {
    setPackagedShell(false);
    try {
      expect(isPackagedShell({})).toBe(false);
      expect(isPackagedShell({ ARMADRA_DESKTOP_PACKAGED: "1" })).toBe(true);
      expect(isPackagedShell({ ARMADRA_DESKTOP_PACKAGED: "0" })).toBe(false);
      setPackagedShell(true);
      expect(isPackagedShell({})).toBe(true);
    } finally {
      setPackagedShell(false);
    }
  });
});

describe("the external development Runtime", () => {
  it("defaults to the documented loopback port and honours the override", () => {
    expect(externalRuntimeBase({})).toBe("http://127.0.0.1:43120");
    expect(externalRuntimeBase({ ARMADRA_RUNTIME_PORT: "51000" })).toBe(
      "http://127.0.0.1:51000",
    );
    // Nonsense is not a port; the default is safer than guessing.
    expect(externalRuntimeBase({ ARMADRA_RUNTIME_PORT: "nope" })).toBe(
      "http://127.0.0.1:43120",
    );
    expect(externalRuntimeBase({ ARMADRA_RUNTIME_PORT: "0" })).toBe(
      "http://127.0.0.1:43120",
    );
  });
});

describe("壳启动的 core", () => {
  it("finds the core bundle beside the main bundle in both layouts", () => {
    expect(coreEntry({}, "/app/out/main")).toBe("/app/out/core/main.js");
    expect(coreEntry({ ARMADRA_CORE_ENTRY: "/elsewhere/main.js" })).toBe(
      "/elsewhere/main.js",
    );
  });

  it("孤儿清扫认的是 core 的那段命令行", () => {
    expect(CORE_PROCESS_MARKER).toBe("core/main.js");
  });
});
