import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type Attachment,
  type BackendNotice,
  type SessionKey,
  type TerminalSpec,
  sanitizePaste,
  sessionKey,
} from "./backend";
import { DirectBackend } from "./direct";

/**
 * The direct backend against real PTYs.
 *
 * Real, not mocked: the whole value of this backend is what a process does —
 * whether the tree dies with it, whether a chunk that ends mid-character
 * survives, whether a paste stays data. A fake PTY would test the fake.
 *
 * Unix only. The direct backend works on Windows through ConPTY, but every
 * assertion below is written in `sh`, and `node-pty`'s Windows path is the one
 * R6 is about (see `session-host/`).
 */

const unix = process.platform !== "win32";
const describeUnix = unix ? describe : describe.skip;

let directory: string | undefined;
let backend: DirectBackend | undefined;

afterEach(async () => {
  await backend?.detachAll();
  backend = undefined;
  if (directory !== undefined)
    rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

function spec(command: string, args: readonly string[] = []): TerminalSpec {
  directory ??= mkdtempSync(join(tmpdir(), "armadra-direct-"));
  return {
    sessionKey: sessionKey("node-a"),
    workspaceId: "ws",
    generation: 1,
    cwd: directory,
    shell: "/bin/sh",
    command,
    args,
    env: [["ARMADRA_NODE_ID", "node-a"]],
    size: { cols: 80, rows: 24 },
  };
}

/** Collects everything an attachment delivers, as text. */
function collect(attachment: Attachment): () => string {
  const chunks: Buffer[] = [];
  attachment.onData((chunk) => chunks.push(chunk));
  return () => Buffer.concat(chunks).toString("utf8");
}

async function waitFor(
  read: () => string,
  needle: string,
  seconds = 10,
): Promise<string> {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    const text = read();
    if (text.includes(needle)) return text;
    if (Date.now() > deadline) {
      throw new Error(`never saw ${needle}; got ${JSON.stringify(text)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const key = (): SessionKey => sessionKey("node-a");

describeUnix("the direct backend", () => {
  it("streams a real PTY's output to an attachment", async () => {
    backend = new DirectBackend();
    await backend.create(
      spec("/bin/sh", ["-c", "printf hello-direct; sleep 5"]),
    );
    const attachment = await backend.attach(key(), 1, { cols: 80, rows: 24 });
    const read = collect(attachment);
    await waitFor(read, "hello-direct");
  });

  /**
   * Bytes that arrived before the socket subscribed are buffered rather than
   * dropped: a process that prints and exits faster than the WebSocket
   * handshake is the normal case for a short command, and the pane would
   * otherwise open empty.
   */
  it("keeps the bytes that arrived before the socket subscribed", async () => {
    backend = new DirectBackend();
    await backend.create(spec("/bin/sh", ["-c", "printf early; sleep 5"]));
    const attachment = await backend.attach(key(), 1, { cols: 80, rows: 24 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const read = collect(attachment);
    await waitFor(read, "early");
  });

  it("starts the command in the requested directory", async () => {
    backend = new DirectBackend();
    await backend.create(spec("/bin/sh", ["-c", "pwd; sleep 5"]));
    const attachment = await backend.attach(key(), 1, { cols: 80, rows: 24 });
    const read = collect(attachment);
    // macOS resolves `/var` to `/private/var`, so the last segment is what is
    // worth asserting rather than the whole path.
    await waitFor(read, (directory as string).split("/").pop() as string);
  });

  it("refuses to attach with a stale generation", async () => {
    backend = new DirectBackend();
    await backend.create(spec("/bin/sh", ["-c", "sleep 5"]));
    await expect(
      backend.attach(key(), 2, { cols: 80, rows: 24 }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("refuses everything about a key it does not have", async () => {
    backend = new DirectBackend();
    await expect(
      backend.attach(sessionKey("nobody"), 1, { cols: 80, rows: 24 }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      backend.capture(sessionKey("nobody"), 10, false),
    ).rejects.toMatchObject({ status: 404 });
  });

  /**
   * There is no screen to re-read, so the replay buffer is both the `snapshot`
   * frame and the answer to `capture` — and `capture` strips the escapes,
   * because an agent is meant to read it.
   */
  it("captures and snapshots its own replay buffer", async () => {
    backend = new DirectBackend();
    await backend.create(
      spec("/bin/sh", ["-c", "printf '\\033[31mred\\033[0m\\n'; sleep 5"]),
    );
    const attachment = await backend.attach(key(), 1, { cols: 80, rows: 24 });
    const read = collect(attachment);
    await waitFor(read, "red");

    const plain = await backend.capture(key(), 40, false);
    expect(plain).toContain("red");
    expect(plain).not.toContain("[31m");

    const raw = await backend.capture(key(), 40, true);
    expect(raw).toContain("[31m");

    expect(backend.snapshot(key())).toContain("red");
  });

  /**
   * 全屏界面不逐行打印：Claude 用跳列代替空格、用定位代替换行，Codex 每一拍
   * 都定位回去重画同几行。capture 要答的是屏幕上此刻的样子——去掉转义直接当
   * 文本，读到的是粘成一行的字或者几十行动画碎片（2026-09-26 direct 后端端
   * 到端实测，Agent 读邻居终端与首投放行门都认不出提示符）。
   */
  it("captures a full-screen interface as the screen it draws", async () => {
    backend = new DirectBackend();
    const frames = Array.from(
      { length: 200 },
      (_, index) => `\\033[1;1H\\033[K⠋ tick ${index}`,
    ).join("");
    await backend.create(
      spec("/bin/sh", [
        "-c",
        `printf '\\033[?1049h\\033[3;1H\\033[2GIs\\033[5Gthis\\033[10Gready?\\033[5;3H› Ask Codex${frames}'; sleep 5`,
      ]),
    );
    const attachment = await backend.attach(key(), 1, { cols: 80, rows: 24 });
    await waitFor(collect(attachment), "tick 199");
    const lines = (await backend.capture(key(), 10, false)).split("\n");
    expect(lines).toContain(" Is this ready?");
    expect(lines).toContain("  › Ask Codex");
    expect(lines.filter((line) => line.includes("tick"))).toEqual([
      "⠋ tick 199",
    ]);
  });

  /**
   * 回放环只留最后 128 批。Codex 的输入框只在起来时画一次，之后每一拍重画
   * 的是一小块动画——几秒钟就把画输入框的那一批挤出环外。屏幕得从会话开头一
   * 直画下来，不能每次从回放环重建。
   */
  it("keeps what was drawn once after the replay ring has moved on", async () => {
    backend = new DirectBackend();
    await backend.create(
      spec("/bin/sh", [
        "-c",
        "printf '\\033[5;3H> Ask Codex'; i=0; while [ $i -lt 400 ]; do printf '\\033[1;1H\\033[K~ tick %s' $i; i=$((i+1)); sleep 0.005; done; sleep 5",
      ]),
    );
    const attachment = await backend.attach(key(), 1, { cols: 80, rows: 24 });
    await waitFor(collect(attachment), "tick 399", 30);
    const lines = (await backend.capture(key(), 30, false)).split("\n");
    expect(lines).toContain("  > Ask Codex");
    expect(lines).toContain("~ tick 399");
  });

  /**
   * The bracketed-paste wrapper is what makes a CLI treat multi-line text as
   * one paste event instead of as keystrokes, so a pasted prompt does not
   * submit itself line by line.
   */
  it("pastes as data, and only runs it when asked to", async () => {
    backend = new DirectBackend();
    await backend.create(spec("/bin/sh", ["-i"]));
    const attachment = await backend.attach(key(), 1, { cols: 80, rows: 24 });
    const read = collect(attachment);
    await backend.paste(key(), "echo pasted-marker", false);
    await waitFor(read, "pasted-marker");
    // Echoed, not run: the marker is on screen but nothing has executed it.
    expect(read()).not.toContain("\npasted-marker\r");
    await backend.paste(key(), "", true);
    await waitFor(read, "pasted-marker");
  });

  /**
   * A pasted closing bracket must not be able to end the paste itself.
   *
   * What is removed is the **escape byte**, not the text after it: `ESC [201~`
   * arrives as the literal `[201~`, which no terminal parser reads as the end
   * of a bracketed paste. Dropping the visible characters too would silently
   * change what the user pasted, which is the other way to get this wrong.
   */
  it("strips the escapes a paste carries, and only the escapes", async () => {
    backend = new DirectBackend();
    await backend.create(spec("/bin/sh", ["-i"]));
    const attachment = await backend.attach(key(), 1, { cols: 80, rows: 24 });
    const read = collect(attachment);
    await backend.paste(key(), "safe\u001b[201~injected", false);
    await waitFor(read, "safe[201~injected");
    // And the escape itself never reached the pty: what came back is the
    // shell's echo of the text, with no second bracket sequence in it.
    expect(sanitizePaste("safe\u001b[201~injected")).toBe("safe[201~injected");
  });

  /**
   * An interrupt is a signal, not a kill: 0x03 goes through the line
   * discipline so it reaches the foreground process group rather than the
   * shell that owns the session.
   */
  it("interrupts the foreground process without ending the session", async () => {
    backend = new DirectBackend();
    await backend.create(spec("/bin/sh", ["-i"]));
    const attachment = await backend.attach(key(), 1, { cols: 80, rows: 24 });
    const read = collect(attachment);
    await backend.input(key(), Buffer.from("sleep 30\n"));
    await new Promise((resolve) => setTimeout(resolve, 300));
    await backend.signal(key(), "interrupt");
    await backend.input(key(), Buffer.from("echo still-here\n"));
    await waitFor(read, "still-here");
  });

  /** Killing the shell alone would leave whatever it started running. */
  it("ends the whole process tree", async () => {
    backend = new DirectBackend();
    await backend.create(
      spec("/bin/sh", ["-c", "sleep 300 & echo child=$!; wait"]),
    );
    const attachment = await backend.attach(key(), 1, { cols: 80, rows: 24 });
    const read = collect(attachment);
    const text = await waitFor(read, "child=");
    const child = Number.parseInt(/child=(\d+)/.exec(text)?.[1] ?? "", 10);
    expect(Number.isInteger(child)).toBe(true);

    await backend.terminate(key(), "session");
    const deadline = Date.now() + 5_000;
    for (;;) {
      let alive = true;
      try {
        process.kill(child, 0);
      } catch {
        alive = false;
      }
      if (!alive) break;
      expect(Date.now()).toBeLessThan(deadline);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  });

  /**
   * A session nobody is attached to still has to stop claiming to be running.
   * The notice channel is how the manager learns that without a socket.
   */
  it("announces an exit nobody was watching", async () => {
    backend = new DirectBackend();
    const notices: BackendNotice[] = [];
    backend.notices((notice) => notices.push(notice));
    await backend.create(spec("/bin/sh", ["-c", "exit 7"]));
    const deadline = Date.now() + 5_000;
    while (notices.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(notices).toEqual([
      { type: "exited", key: "node-a", generation: 1, exitCode: 7 },
    ]);
  });

  it("tells an attachment that subscribed after the exit that it is over", async () => {
    backend = new DirectBackend();
    await backend.create(spec("/bin/sh", ["-c", "exit 3"]));
    await new Promise((resolve) => setTimeout(resolve, 500));
    const attachment = await backend.attach(key(), 1, { cols: 80, rows: 24 });
    const code = await new Promise<number | undefined>((resolve) => {
      attachment.onExit(resolve);
    });
    expect(code).toBe(3);
  });

  /**
   * `setDormant` changes the delivery cadence and nothing else. The process
   * keeps running and every byte is kept, which is what makes waking free and
   * impossible to confuse with a create.
   */
  it("keeps running, and keeps its bytes, while dormant", async () => {
    backend = new DirectBackend();
    await backend.create(
      spec("/bin/sh", ["-c", "printf dormant-output; sleep 5"]),
    );
    await backend.setDormant(key(), true);
    await new Promise((resolve) => setTimeout(resolve, 800));
    await backend.setDormant(key(), false);
    expect(backend.snapshot(key())).toContain("dormant-output");
    expect((await backend.list()).map((entry) => entry.name)).toEqual([
      "node-a",
    ]);
  });

  /**
   * The one place this backend's `detachAll` differs from every other one's,
   * and the reason tmux is the primary backend: a direct session cannot
   * survive the core, so "release" means "kill".
   */
  it("kills its sessions on shutdown rather than leaving them", async () => {
    backend = new DirectBackend();
    await backend.create(spec("/bin/sh", ["-c", "sleep 300"]));
    expect(await backend.list()).toHaveLength(1);
    await backend.detachAll();
    expect(await backend.list()).toHaveLength(0);
  });

  /**
   * A spawn that fails inside node-pty leaks a pty device on macOS, so the
   * question "does this program exist" is answered by `stat` before node-pty
   * is called at all.
   */
  it("refuses a command that does not exist before opening a PTY", async () => {
    backend = new DirectBackend();
    await expect(
      backend.create(spec("/definitely/not/a/program")),
    ).rejects.toThrow(/找不到可执行的程序/);
  });

  it("has nothing to destroy by reference, and says so by succeeding", async () => {
    backend = new DirectBackend();
    await expect(
      backend.destroyByReference("anything"),
    ).resolves.toBeUndefined();
    await expect(backend.scroll(key(), 10)).resolves.toBeUndefined();
  });
});
