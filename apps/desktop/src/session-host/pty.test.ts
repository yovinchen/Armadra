import { describe, expect, it, vi } from "vitest";
import { FakePty, fakeSpawner } from "./fake-pty";
import { CloseTimeout, ConsoleSession } from "./pty";

/**
 * The close handshake, which is §4.3 of the status document — the ConPTY
 * release race — turned into a state machine that can be exercised without a
 * ConPTY.
 *
 * The rule under test is one sentence: **a close is reported as done only
 * when this process observed the exit.** Everything else here is the
 * consequences of that sentence.
 */

function session(options: { exitsOnKill?: boolean; timeoutMs?: number } = {}): {
  console: ConsoleSession;
  pty: FakePty;
  data: Buffer[];
  exits: (number | undefined)[];
} {
  const spawner = fakeSpawner();
  const data: Buffer[] = [];
  const exits: (number | undefined)[] = [];
  const built = new ConsoleSession(
    {
      sessionKey: "node-a",
      cwd: "C:\\src",
      program: "powershell.exe",
      args: [],
      env: { PATH: "C:\\Windows" },
      cols: 80,
      rows: 24,
      onData: (chunk) => data.push(chunk),
      onExit: (code) => exits.push(code),
    },
    spawner.spawn,
    options.timeoutMs ?? 50,
  );
  const pty = spawner.last();
  pty.exitsOnKill = options.exitsOnKill ?? true;
  return { console: built, pty, data, exits };
}

describe("console session", () => {
  it("hands the console what the core asked for", () => {
    const { pty, console: built } = session();
    expect(pty.options.program).toBe("powershell.exe");
    expect(pty.options.cwd).toBe("C:\\src");
    // Inherited environment would let a CLI see another agent's variables; the
    // core sends the exact set it wants and nothing is added to it.
    expect(pty.options.env).toEqual({ PATH: "C:\\Windows" });
    expect(built.pid).toBe(4000);
    expect(built.phase).toBe("running");
  });

  it("carries bytes above 0x7f through write unchanged", () => {
    const { pty, console: built } = session();
    const bytes = Buffer.from("中文 🙂", "utf8");
    built.write(bytes);
    expect(pty.written().equals(bytes)).toBe(true);
  });

  it("reports output as buffers whatever the console hands over", () => {
    const { pty, data } = session();
    pty.emit(Buffer.from("bytes"));
    pty.emit("text");
    expect(data.map((chunk) => chunk.toString())).toEqual(["bytes", "text"]);
  });

  /* ------------------------------- flow gate ------------------------------ */

  it("pauses and resumes the reader, idempotently", () => {
    const { pty, console: built } = session();
    built.setPaused(true);
    built.setPaused(true);
    expect(pty.paused).toBe(true);
    built.setPaused(false);
    expect(pty.paused).toBe(false);
  });

  /**
   * A paused stream does not drain, and node-pty will not run its own
   * teardown until the read side is flowing again: a paused pty that is
   * killed leaks both the handle and the reader.
   */
  it("resumes before killing, so a paused console can still be torn down", () => {
    const { pty, console: built } = session();
    built.setPaused(true);
    built.kill();
    expect(pty.paused).toBe(false);
    expect(pty.killed).toBe(1);
  });

  /* ---------------------------- the close proof --------------------------- */

  it("proves a close by waiting for the exit it caused", async () => {
    const { console: built } = session();
    await expect(built.close()).resolves.toEqual({
      kind: "exited",
      exitCode: 130,
    });
    expect(built.phase).toBe("closed");
    expect(built.exited).toBe(true);
  });

  /**
   * The failure this whole mechanism exists for: the console is asked to go
   * and never says it went. Reporting success here is how a machine
   * accumulates orphaned conhosts until a reboot.
   */
  it("refuses to report a close it did not observe", async () => {
    vi.useFakeTimers();
    try {
      const { console: built } = session({ exitsOnKill: false, timeoutMs: 50 });
      const closing = built.close();
      const settled = expect(closing).rejects.toBeInstanceOf(CloseTimeout);
      await vi.advanceTimersByTimeAsync(60);
      await settled;
      // Not `closed`: this console is not known to have been released, and a
      // second close is a legitimate second attempt rather than a no-op.
      expect(built.phase).toBe("closing");
    } finally {
      vi.useRealTimers();
    }
  });

  it("names the session and the wait in the refusal", async () => {
    vi.useFakeTimers();
    try {
      const { console: built } = session({ exitsOnKill: false, timeoutMs: 50 });
      const closing = built.close().catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(60);
      const error = (await closing) as CloseTimeout;
      expect(error.sessionKey).toBe("node-a");
      expect(error.waitedMs).toBe(50);
      expect(error.message).toContain("node-a");
    } finally {
      vi.useRealTimers();
    }
  });

  /** A second attempt after a timeout may still succeed, and must be allowed to. */
  it("lets a timed-out close be retried, and succeed", async () => {
    vi.useFakeTimers();
    try {
      const { pty, console: built } = session({
        exitsOnKill: false,
        timeoutMs: 50,
      });
      const first = built.close().catch(() => "timed out");
      await vi.advanceTimersByTimeAsync(60);
      expect(await first).toBe("timed out");

      pty.exitsOnKill = true;
      const second = built.close();
      await vi.advanceTimersByTimeAsync(1);
      await expect(second).resolves.toEqual({ kind: "exited", exitCode: 130 });
      expect(built.phase).toBe("closed");
      expect(pty.killed).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes a console that had already ended without waiting for anything", async () => {
    const { pty, console: built } = session();
    pty.exit(0);
    expect(built.phase).toBe("exited");
    await expect(built.close()).resolves.toEqual({
      kind: "alreadyExited",
      exitCode: 0,
    });
    expect(built.phase).toBe("closed");
    // Nothing was killed: the process was already gone, and killing a pid that
    // no longer exists is how the wrong process gets signalled.
    expect(pty.killed).toBe(0);
  });

  it("is idempotent once closed", async () => {
    const { console: built } = session();
    await built.close();
    await expect(built.close()).resolves.toEqual({
      kind: "alreadyExited",
      exitCode: 130,
    });
  });

  /* -------------------------------- the exit ------------------------------ */

  it("tells the host about an exit exactly once", () => {
    const { pty, exits } = session();
    pty.exit(7);
    pty.exit(9);
    expect(exits).toEqual([7]);
  });

  it("reports the exit of a console that was closed, not only of one that ended", async () => {
    const { exits, console: built } = session();
    await built.close();
    expect(exits).toEqual([130]);
  });

  it("stops accepting input and resizes once the console is gone", () => {
    const { pty, console: built } = session();
    pty.exit(0);
    built.write(Buffer.from("ignored"));
    built.resize(100, 40);
    expect(pty.writes).toEqual([]);
    expect(pty.resizes).toEqual([]);
  });

  it("never lets a resize below a console's minimum through", () => {
    const { pty, console: built } = session();
    built.resize(0, 0);
    expect(pty.resizes).toEqual([[2, 2]]);
  });
});
