import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
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
  externalRuntimeBase,
  processCommandLine,
  runtimeExecutable,
  stopStaleRuntime,
  waitForExit,
  waitUntilAddressIsFree,
} from "./runtime-process";

/**
 * The half of `src-tauri/src/runtime_process_tests.rs` that needs a real OS
 * process: the shutdown frame on stdin, the announcement read off a real pipe,
 * SIGTERM sent only to a Runtime we recognise, and what "the address is free"
 * means. These are worth nothing against a fake, which is why they spawn.
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

describe.runIf(unix)("stopping the Runtime this shell owns", () => {
  it("sends the shutdown frame and requires a successful exit", async () => {
    const path = join(temporary(), "frame");
    // Reads exactly the six bytes of the control frame, then exits 0.
    const child = spawn(
      "/bin/sh",
      ["-c", `dd bs=1 count=6 of="${path}" 2>/dev/null`],
      {
        stdio: ["pipe", "ignore", "ignore"],
      },
    );
    const runtime = holding(child);
    await expect(runtime.stop()).resolves.toBeUndefined();
    // A 4-byte big-endian length, then a one-field protobuf: the same six
    // bytes the Rust shell wrote.
    expect([...readFileSync(path)]).toEqual([0, 0, 0, 2, 10, 0]);
    // A second stop on a holder with no child is a no-op, not a failure.
    await expect(runtime.stop()).resolves.toBeUndefined();
  });

  it("never lets a failed shutdown read as success on a second quit", async () => {
    const child = spawn("/bin/sh", ["-c", "exit 0"], {
      stdio: ["pipe", "ignore", "ignore"],
    });
    await waitForExit(child, 5_000);
    const runtime = holding(child);
    // An ordinary exit — even exit 0 — may intentionally leave tmux alive.
    await expect(runtime.stop()).rejects.toThrow(/already exited/);
    await expect(runtime.stop()).rejects.toThrow(
      /previous Runtime shutdown failed/,
    );
  });

  it("fails when the Runtime does not exit successfully", async () => {
    const child = spawn("/bin/sh", ["-c", "cat >/dev/null; exit 3"], {
      stdio: ["pipe", "ignore", "ignore"],
    });
    const runtime = holding(child);
    await expect(runtime.stop()).rejects.toThrow(
      /failed to stop all managed sessions/,
    );
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
    const program = join(directory, "armadra-runtime");
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

  it("recognises a Runtime a previous shell left, and stops it with SIGTERM", async () => {
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
    expect(exit, "the stale Runtime ignored the stop request").toBeDefined();
    // SIGTERM, not SIGKILL: the Runtime's handler is what detaches tmux
    // instead of ending it.
    expect(exit?.signal).toBe("SIGTERM");
  });

  it("never signals a process that is not one of our Runtimes", async () => {
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
      /not an Armadra Runtime/,
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

describe("where the Runtime binary is", () => {
  it("comes out of the cargo target directory in development", () => {
    expect(
      runtimeExecutable(
        false,
        { CARGO_TARGET_DIR: "/build/target" },
        "/res",
        "/repo",
      ),
    ).toBe(join("/build/target", "debug", "armadra-runtime"));
    expect(runtimeExecutable(false, {}, "/res", "/repo")).toBe(
      join("/repo/target", "debug", "armadra-runtime"),
    );
    // A relative CARGO_TARGET_DIR resolves against the repo, as cargo does.
    expect(
      runtimeExecutable(false, { CARGO_TARGET_DIR: "target" }, "/res", "/repo"),
    ).toBe(join("/repo/target", "debug", "armadra-runtime"));
  });

  it("comes out of the bundle's resources when packaged", () => {
    expect(
      runtimeExecutable(true, {}, "/App/Contents/Resources", "/repo"),
    ).toBe(join("/App/Contents/Resources", "armadra-runtime"));
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
