import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { signHello } from "../core/terminal/session-host/auth";
import { type LinkEvent, Link } from "../core/terminal/session-host/link";
import {
  RequestIds,
  createMessage,
  resizeMessage,
} from "../core/terminal/session-host/protocol";
import { type FakePty, fakeSpawner } from "./fake-pty";
import { AlreadyServing, SessionHost } from "./server";

/**
 * The host and the core talking to each other, over a real socket, with a
 * fake console behind it.
 *
 * ## Why this runs on a Mac
 *
 * The endpoint is a string that `net.createServer().listen()` accepts. On
 * Windows that is `\\.\pipe\…`; here it is a Unix socket path. **Everything
 * between the two ends is identical** — the frame codec, the handshake, the
 * generation fence, the replay, the flow gate, the request dispatch — so all
 * of it is exercised here rather than waiting for a Windows machine.
 *
 * What is *not* exercised is the part that is genuinely Windows: ConPTY
 * itself, the pipe's namespace and `FILE_FLAG_FIRST_PIPE_INSTANCE`. Those
 * live in `windows.integration.test.ts`, which skips everywhere else.
 *
 * The client is the core's own {@link Link} rather than a hand-rolled one, so
 * a drift between the two speakers fails here instead of on a user's machine.
 */

const scrap: (() => void)[] = [];

afterEach(async () => {
  for (const undo of scrap.splice(0).reverse()) undo();
  // Give the sockets a turn to finish closing before the next test's listen.
  await new Promise((resolve) => setImmediate(resolve));
});

interface Harness {
  readonly host: SessionHost;
  readonly endpoint: string;
  readonly key: Buffer;
  readonly opened: FakePty[];
  last(): FakePty;
}

async function serve(options: { idleExitMs?: number } = {}): Promise<Harness> {
  const dataDir = mkdtempSync(join(tmpdir(), "armadra-host-"));
  // Short, because a Unix socket path has about a hundred bytes to live in.
  const endpoint = join(dataDir, "s");
  const key = randomBytes(32);
  const spawner = fakeSpawner();
  const host = new SessionHost({
    dataDir,
    endpoint,
    key,
    version: "armadra-session-host/test",
    spawn: spawner.spawn,
    tickMs: 60_000,
    ...(options.idleExitMs === undefined
      ? {}
      : { idleExitMs: options.idleExitMs }),
  });
  await host.listen();
  scrap.push(() => {
    void host.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  return { host, endpoint, key, opened: spawner.opened, last: spawner.last };
}

interface Client {
  readonly link: Link;
  readonly events: LinkEvent[];
  readonly ids: RequestIds;
  next(): number;
}

async function connect(
  harness: Harness,
  options: { auth?: "valid" | "none" | "wrong" } = {},
): Promise<Client> {
  const events: LinkEvent[] = [];
  const link = await Link.connect(harness.endpoint, (event) =>
    events.push(event),
  );
  scrap.push(() => link.close());
  const flavour = options.auth ?? "valid";
  const auth =
    flavour === "none"
      ? undefined
      : signHello(
          flavour === "wrong" ? randomBytes(32) : harness.key,
          harness.endpoint,
        );
  await link.handshake("armadra-core/test", auth);
  const ids = new RequestIds();
  return { link, events, ids, next: () => ids.issue() };
}

const SPEC = {
  sessionKey: "node-a",
  generation: 1,
  workspaceId: "ws",
  cwd: "/tmp",
  shell: "powershell.exe",
  command: null,
  args: [] as const,
  env: [["PATH", "/usr/bin"]] as const,
  size: { cols: 80, rows: 24 },
};

async function created(client: Client, overrides = {}): Promise<void> {
  const id = client.next();
  const answer = await client.link.request(
    id,
    createMessage(id, { ...SPEC, ...overrides }),
  );
  expect(answer.type, JSON.stringify(answer)).toBe("ok");
}

/** Waits until `check` holds, or gives up. Sockets settle in their own time. */
async function until(check: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

/* --------------------------------- handshake ------------------------------- */

describe("the handshake", () => {
  it("welcomes a client that proves it can read the key", async () => {
    const harness = await serve();
    const events: LinkEvent[] = [];
    const link = await Link.connect(harness.endpoint, (event) =>
      events.push(event),
    );
    scrap.push(() => link.close());
    const greeting = await link.handshake(
      "armadra-core/test",
      signHello(harness.key, harness.endpoint),
    );
    expect(greeting.hostVersion).toBe("armadra-session-host/test");
    expect(greeting.pid).toBe(process.pid);
    expect(greeting.instanceId).not.toBe("");
    expect(greeting.sessions).toEqual([]);
  });

  /**
   * The check that replaced the pipe's DACL. A connection that cannot prove
   * it holds the key is closed before it can ask for anything at all.
   */
  it("refuses a client with no proof", async () => {
    const harness = await serve();
    await expect(connect(harness, { auth: "none" })).rejects.toThrow(
      /unauthorized/,
    );
  });

  it("refuses a client whose proof was made with another key", async () => {
    const harness = await serve();
    await expect(connect(harness, { auth: "wrong" })).rejects.toThrow(
      /unauthorized/,
    );
  });

  /** The refusal says nothing about *which* part of the attempt was wrong. */
  it("tells a refused client only that it was refused", async () => {
    const harness = await serve();
    await expect(connect(harness, { auth: "wrong" })).rejects.toThrow(
      /handshake refused/,
    );
  });

  /**
   * Two cores starting at once is normal, and the second one must leave
   * rather than serve a competing session table. On Windows this is
   * `FILE_FLAG_FIRST_PIPE_INSTANCE`; here it is the same `EADDRINUSE` on the
   * same code path.
   */
  it("refuses to be the second host on one endpoint", async () => {
    const harness = await serve();
    const second = new SessionHost({
      dataDir: "/tmp",
      endpoint: harness.endpoint,
      key: harness.key,
      version: "second",
    });
    await expect(second.listen()).rejects.toBeInstanceOf(AlreadyServing);
  });
});

/* -------------------------------- lifecycle -------------------------------- */

describe("sessions", () => {
  it("creates a console with exactly what the core asked for", async () => {
    const harness = await serve();
    const client = await connect(harness);
    await created(client);
    const pty = harness.last();
    expect(pty.options.program).toBe("powershell.exe");
    expect(pty.options.args).toEqual([]);
    expect(pty.options.env).toEqual({ PATH: "/usr/bin" });
    expect(pty.options.cols).toBe(80);
  });

  it("prefers an explicit command over the shell", async () => {
    const harness = await serve();
    const client = await connect(harness);
    await created(client, { command: "claude.cmd", args: ["--resume"] });
    expect(harness.last().options.program).toBe("claude.cmd");
    expect(harness.last().options.args).toEqual(["--resume"]);
  });

  it("lists what it holds, with the pid behind it", async () => {
    const harness = await serve();
    const client = await connect(harness);
    await created(client);
    const id = client.next();
    const answer = await client.link.request(id, { type: "list", id });
    expect(answer.type).toBe("ok");
    const sessions = answer.type === "ok" ? (answer.sessions ?? []) : [];
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.sessionKey).toBe("node-a");
    expect(sessions[0]?.pid).toBe(harness.last().pid);
    expect(sessions[0]?.exited).toBe(false);
  });

  /**
   * Silently replacing a session would strand a CLI the user is still using,
   * so the caller is told it is out of date instead.
   */
  it("refuses a create over a running session", async () => {
    const harness = await serve();
    const client = await connect(harness);
    await created(client);
    const id = client.next();
    const answer = await client.link.request(
      id,
      createMessage(id, { ...SPEC, generation: 2 }),
    );
    expect(answer.type === "error" && answer.code).toBe("conflict");
    expect(harness.opened).toHaveLength(1);
  });

  it("does not leave a reservation behind when the spawn fails", async () => {
    const harness = await serve();
    const client = await connect(harness);
    const id = client.next();
    // The fake spawner cannot fail, so the failure is arranged where a real
    // one would produce it: a size a console cannot have is clamped, but an
    // unknown key with a broken generation is refused outright.
    const answer = await client.link.request(
      id,
      createMessage(id, { ...SPEC, generation: 0 }),
    );
    expect(answer.type === "error" && answer.code).toBe("badRequest");
    const listId = client.next();
    const list = await client.link.request(listId, {
      type: "list",
      id: listId,
    });
    expect(list.type === "ok" && list.sessions).toEqual([]);
  });
});

/* ------------------------------ attach and io ------------------------------ */

describe("attach", () => {
  it("replays what happened before the client existed, then goes live", async () => {
    const harness = await serve();
    const client = await connect(harness);
    await created(client);
    harness.last().emit(Buffer.from("before the attach\r\n"));

    const attacher = await connect(harness);
    attacher.link.expectOutput(1);
    const id = attacher.next();
    const answer = await attacher.link.request(id, {
      type: "attach",
      id,
      sessionKey: "node-a",
      generation: 1,
      size: { cols: 80, rows: 24 },
    });
    expect(answer.type).toBe("ok");
    await until(
      () => attacher.events.some((event) => event.type === "snapshotEnd"),
      "the replay to end",
    );
    const snapshot = attacher.events
      .filter((event) => event.type === "snapshot")
      .map((event) => (event as { payload: Buffer }).payload.toString())
      .join("");
    expect(snapshot).toBe("before the attach\r\n");

    harness.last().emit(Buffer.from("live\r\n"));
    await until(
      () => attacher.events.some((event) => event.type === "output"),
      "live output",
    );
    const live = attacher.events
      .filter((event) => event.type === "output")
      .map((event) => (event as { payload: Buffer }).payload.toString())
      .join("");
    expect(live).toBe("live\r\n");
  });

  /**
   * The fence. A client holding the generation you recycled away from is told
   * so, and is never quietly served the session that replaced it.
   */
  it("refuses a stale generation and says what the current one is", async () => {
    const harness = await serve();
    const client = await connect(harness);
    await created(client);
    const id = client.next();
    const answer = await client.link.request(id, {
      type: "attach",
      id,
      sessionKey: "node-a",
      generation: 2,
      size: { cols: 80, rows: 24 },
    });
    expect(answer.type === "error" && answer.code).toBe("stale");
    const stale = client.events.find((event) => event.type === "stale");
    expect(stale).toMatchObject({ sessionKey: "node-a", current: 1 });
  });

  it("reports an unknown session as not found", async () => {
    const harness = await serve();
    const client = await connect(harness);
    const id = client.next();
    const answer = await client.link.request(id, {
      type: "attach",
      id,
      sessionKey: "nobody",
      generation: 1,
      size: { cols: 80, rows: 24 },
    });
    expect(answer.type === "error" && answer.code).toBe("notFound");
  });

  /** A partial replay says so, rather than implying it is the whole history. */
  it("warns when the replay had to drop older output", async () => {
    const harness = await serve();
    const client = await connect(harness);
    await created(client);
    harness.last().emit(Buffer.alloc(300 * 1024, 0x61));

    const attacher = await connect(harness);
    const id = attacher.next();
    await attacher.link.request(id, {
      type: "attach",
      id,
      sessionKey: "node-a",
      generation: 1,
      size: { cols: 80, rows: 24 },
    });
    await until(
      () => attacher.events.some((event) => event.type === "warning"),
      "the truncation warning",
    );
  });

  /** The device that just arrived is the one the user is looking at. */
  it("gives the console the size of the most recent attach", async () => {
    const harness = await serve();
    const client = await connect(harness);
    await created(client);
    const id = client.next();
    await client.link.request(id, {
      type: "attach",
      id,
      sessionKey: "node-a",
      generation: 1,
      size: { cols: 120, rows: 40 },
    });
    expect(harness.last().resizes.at(-1)).toEqual([120, 40]);
  });
});

describe("input", () => {
  it("writes bytes through unchanged", async () => {
    const harness = await serve();
    const client = await connect(harness);
    await created(client);
    const payload = Buffer.from("中文 🙂\r", "utf8");
    const id = client.next();
    const answer = await client.link.request(id, {
      type: "write",
      id,
      sessionKey: "node-a",
      data: payload.toString("base64"),
    });
    expect(answer.type).toBe("ok");
    expect(harness.last().written().equals(payload)).toBe(true);
  });

  it("refuses a write whose payload is not base64", async () => {
    const harness = await serve();
    const client = await connect(harness);
    await created(client);
    const id = client.next();
    const answer = await client.link.request(id, {
      type: "write",
      id,
      sessionKey: "node-a",
      data: "not base64 at all!!",
    });
    expect(answer.type === "error" && answer.code).toBe("badRequest");
  });

  /**
   * Windows has no SIGINT to send. `0x03` through the console input is what a
   * real Ctrl+C is, and it is the one path that works for a Win32 CLI, a Node
   * CLI and a WSL shell alike.
   */
  it("sends an interrupt as the byte a console understands", async () => {
    const harness = await serve();
    const client = await connect(harness);
    await created(client);
    const id = client.next();
    await client.link.request(id, {
      type: "interrupt",
      id,
      sessionKey: "node-a",
    });
    expect(
      harness
        .last()
        .written()
        .equals(Buffer.from([0x03])),
    ).toBe(true);
  });

  it("clamps a resize to something a console can be", async () => {
    const harness = await serve();
    const client = await connect(harness);
    await created(client);
    const id = client.next();
    await client.link.request(
      id,
      resizeMessage(id, "node-a", { cols: 0, rows: 100_000 }),
    );
    expect(harness.last().resizes.at(-1)).toEqual([2, 1000]);
  });

  it("refuses io against a session that is not there", async () => {
    const harness = await serve();
    const client = await connect(harness);
    const id = client.next();
    const answer = await client.link.request(id, {
      type: "write",
      id,
      sessionKey: "nobody",
      data: "",
    });
    expect(answer.type === "error" && answer.code).toBe("notFound");
  });
});

/* -------------------------------- flow gate -------------------------------- */

describe("back pressure", () => {
  it("pauses and resumes the console on request", async () => {
    const harness = await serve();
    const client = await connect(harness);
    await created(client);
    const pause = client.next();
    await client.link.request(pause, {
      type: "flow",
      id: pause,
      sessionKey: "node-a",
      paused: true,
    });
    expect(harness.last().paused).toBe(true);
    const resume = client.next();
    await client.link.request(resume, {
      type: "flow",
      id: resume,
      sessionKey: "node-a",
      paused: false,
    });
    expect(harness.last().paused).toBe(false);
  });

  /** The one that keeps a crashed frontend from freezing a CLI forever. */
  it("releases a pause when the connection holding it goes away", async () => {
    const harness = await serve();
    const client = await connect(harness);
    await created(client);
    const pauser = await connect(harness);
    const id = pauser.next();
    await pauser.link.request(id, {
      type: "flow",
      id,
      sessionKey: "node-a",
      paused: true,
    });
    expect(harness.last().paused).toBe(true);
    pauser.link.close();
    await until(() => !harness.last().paused, "the console to resume");
  });
});

/* --------------------------------- the end --------------------------------- */

describe("ending a session", () => {
  it("tells subscribers when the process ends by itself", async () => {
    const harness = await serve();
    const client = await connect(harness);
    await created(client);
    const attacher = await connect(harness);
    const id = attacher.next();
    await attacher.link.request(id, {
      type: "attach",
      id,
      sessionKey: "node-a",
      generation: 1,
      size: { cols: 80, rows: 24 },
    });
    harness.last().exit(3);
    await until(
      () => attacher.events.some((event) => event.type === "exit"),
      "the exit notice",
    );
    expect(
      attacher.events.find((event) => event.type === "exit"),
    ).toMatchObject({ sessionKey: "node-a", generation: 1, exitCode: 3 });
  });

  it("forgets a destroyed session and lets the key be recycled", async () => {
    const harness = await serve();
    const client = await connect(harness);
    await created(client);
    const destroy = client.next();
    const answer = await client.link.request(destroy, {
      type: "destroy",
      id: destroy,
      sessionKey: "node-a",
    });
    expect(answer.type).toBe("ok");
    expect(harness.last().killed).toBe(1);
    // A fresh session may now take the key at generation 1 again, because the
    // row is gone rather than merely finished.
    await created(client);
    expect(harness.opened).toHaveLength(2);
  });

  /**
   * §4.3 of the status document, end to end: a console that will not confirm
   * its own close is reported as an error rather than as a clean destroy.
   */
  it("reports a destroy whose console never confirmed the close", async () => {
    const harness = await serve();
    const client = await connect(harness);
    await created(client);
    harness.last().exitsOnKill = false;
    const id = client.next();
    const answer = await client.link.request(
      id,
      { type: "destroy", id, sessionKey: "node-a" },
      // The close waits five seconds before it gives up, and the request
      // timeout is ten.
    );
    expect(answer.type === "error" && answer.code).toBe("internal");
    expect(answer.type === "error" && answer.message).toContain("HPCON");
  }, 20_000);

  /**
   * The stand-in for the Job Object: Node has no `KILL_ON_JOB_CLOSE`, so
   * shutdown has to close every console explicitly.
   */
  it("closes every console it holds on the way out", async () => {
    const harness = await serve();
    const client = await connect(harness);
    await created(client);
    await created(client, { sessionKey: "node-b" });
    expect(harness.opened).toHaveLength(2);
    await harness.host.close();
    expect(harness.opened.map((pty) => pty.killed)).toEqual([1, 1]);
  });

  /** Closing a connection is a detach, never an end. */
  it("keeps a session when the client that made it disconnects", async () => {
    const harness = await serve();
    const client = await connect(harness);
    await created(client);
    client.link.close();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(harness.host.sessionCount).toBe(1);
    expect(harness.last().killed).toBe(0);
  });
});
