import { afterEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signHello } from "../core/terminal/session-host/auth";
import { type LinkEvent, Link } from "../core/terminal/session-host/link";
import {
  RequestIds,
  createMessage,
  pipeEndpoint,
} from "../core/terminal/session-host/protocol";
import { loadNodePty } from "../core/terminal/pty";
import { AlreadyServing, SessionHost } from "./server";

/**
 * The half that only a Windows machine can answer: a **real** ConPTY behind a
 * **real** named pipe.
 *
 * Everything else about this host is proven in `server.test.ts` against a
 * Unix socket and a fake console, because the wire, the fence, the replay and
 * the flow gate are the same code on every platform. Four things are not, and
 * they are the four things here:
 *
 *   1. `node-pty` actually opening a pseudo console, and the shell inside it
 *      producing output.
 *   2. The Windows pipe namespace — `\\.\pipe\…` — accepting the derived name.
 *   3. `FILE_FLAG_FIRST_PIPE_INSTANCE`: a second host on the same name must
 *      fail rather than serve a competing session table. This is the
 *      concurrency gate the Rust host got from `first_pipe_instance(true)`,
 *      and the whole reason `lock.ts` exists is that it is libuv's behaviour
 *      rather than a documented Node guarantee. If this test ever fails, the
 *      lock file is what is still holding the line.
 *   4. The close handshake against a console that really has to be released.
 *
 * Runs in the CI Windows matrix job, which already runs
 * `pnpm -r --if-present test`. Expect it to add roughly ten seconds: every
 * case starts a shell and waits for it to say something.
 */

/**
 * Windows, **and** a `node-pty` this process can actually load.
 *
 * The second half is not defensive padding: `pretest` restores the module's
 * prebuild rather than compiling it, so a CI image without a matching
 * prebuild would turn this suite from "not applicable" into a wall of
 * identical load failures that say nothing about ConPTY. A skip with a
 * printed reason is the honest outcome — a run that skipped everything must
 * not look like a run that passed everything.
 */
function conptyAvailable(): boolean {
  if (process.platform !== "win32") return false;
  try {
    loadNodePty();
    return true;
  } catch (error) {
    process.stderr.write(
      `session-host integration tests skipped: node-pty did not load (${
        error instanceof Error ? error.message : String(error)
      })\n`,
    );
    return false;
  }
}

const windows = conptyAvailable();
const scrap: (() => void)[] = [];

afterEach(() => {
  for (const undo of scrap.splice(0).reverse()) undo();
});

interface Harness {
  readonly host: SessionHost;
  readonly endpoint: string;
  readonly key: Buffer;
}

async function serve(): Promise<Harness> {
  const dataDir = mkdtempSync(join(tmpdir(), "armadra-conpty-"));
  const key = randomBytes(32);
  // A name in the real pipe namespace, derived the way production derives it,
  // with a random component so two runs of this suite cannot collide.
  const endpoint = pipeEndpoint(
    `S-1-5-21-test-${randomBytes(4).toString("hex")}`,
    dataDir,
  );
  const host = new SessionHost({
    dataDir,
    endpoint,
    key,
    version: "armadra-session-host/integration",
    tickMs: 60_000,
  });
  await host.listen();
  scrap.push(() => {
    void host.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  return { host, endpoint, key };
}

async function connect(
  harness: Harness,
): Promise<{ link: Link; events: LinkEvent[]; ids: RequestIds }> {
  const events: LinkEvent[] = [];
  const link = await Link.connect(harness.endpoint, (event) =>
    events.push(event),
  );
  scrap.push(() => link.close());
  await link.handshake(
    "armadra-core/integration",
    signHello(harness.key, harness.endpoint),
  );
  return { link, events, ids: new RequestIds() };
}

async function until(
  check: () => boolean,
  label: string,
  ms = 15_000,
): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function text(
  events: readonly LinkEvent[],
  kind: "snapshot" | "output",
): string {
  return events
    .filter((event) => event.type === kind)
    .map((event) => (event as { payload: Buffer }).payload.toString("utf8"))
    .join("");
}

const SPEC = {
  sessionKey: "node-a",
  generation: 1,
  workspaceId: "ws",
  cwd: process.env.TEMP ?? "C:\\Windows\\Temp",
  shell: "cmd.exe",
  command: null,
  args: [] as const,
  env: [
    ["PATH", process.env.PATH ?? ""],
    ["SystemRoot", process.env.SystemRoot ?? "C:\\Windows"],
    ["COMSPEC", process.env.COMSPEC ?? "C:\\Windows\\System32\\cmd.exe"],
  ] as const,
  size: { cols: 100, rows: 30 },
};

describe.skipIf(!windows)("a real ConPTY behind a real named pipe", () => {
  it("creates a session, runs a command in it, and shows the output", async () => {
    const harness = await serve();
    const client = await connect(harness);
    const id = client.ids.issue();
    const answer = await client.link.request(id, createMessage(id, SPEC));
    expect(answer.type, JSON.stringify(answer)).toBe("ok");
    expect(answer.type === "ok" && answer.session?.pid).toBeGreaterThan(0);

    const attacher = await connect(harness);
    attacher.link.expectOutput(1);
    const attachId = attacher.ids.issue();
    await attacher.link.request(attachId, {
      type: "attach",
      id: attachId,
      sessionKey: "node-a",
      generation: 1,
      size: { cols: 100, rows: 30 },
    });

    const writeId = attacher.ids.issue();
    await attacher.link.request(writeId, {
      type: "write",
      id: writeId,
      sessionKey: "node-a",
      data: Buffer.from("echo armadra-marker\r", "utf8").toString("base64"),
    });
    await until(
      () => text(attacher.events, "output").includes("armadra-marker"),
      "the console to echo the marker",
    );
  });

  /**
   * The promise the whole process exists for: the connection goes, the
   * session stays, and what it said while nobody was listening is still there
   * when somebody comes back.
   */
  it("keeps the session across a detach, and replays it on re-attach", async () => {
    const harness = await serve();
    const client = await connect(harness);
    const id = client.ids.issue();
    await client.link.request(id, createMessage(id, SPEC));

    const first = await connect(harness);
    first.link.expectOutput(1);
    const attachId = first.ids.issue();
    await first.link.request(attachId, {
      type: "attach",
      id: attachId,
      sessionKey: "node-a",
      generation: 1,
      size: { cols: 100, rows: 30 },
    });
    const writeId = first.ids.issue();
    await first.link.request(writeId, {
      type: "write",
      id: writeId,
      sessionKey: "node-a",
      data: Buffer.from("echo before-detach\r", "utf8").toString("base64"),
    });
    await until(
      () => text(first.events, "output").includes("before-detach"),
      "the marker before the detach",
    );
    // Closing the connection is the detach. The session must not notice.
    first.link.close();

    const second = await connect(harness);
    second.link.expectOutput(1);
    const again = second.ids.issue();
    const reattached = await second.link.request(again, {
      type: "attach",
      id: again,
      sessionKey: "node-a",
      generation: 1,
      size: { cols: 100, rows: 30 },
    });
    expect(reattached.type).toBe("ok");
    await until(
      () => second.events.some((event) => event.type === "snapshotEnd"),
      "the replay to end",
    );
    expect(text(second.events, "snapshot")).toContain("before-detach");
  });

  /**
   * The gate. libuv opens the first instance with
   * `FILE_FLAG_FIRST_PIPE_INSTANCE`, so this must be `EADDRINUSE` rather than
   * a second host quietly serving the same name.
   */
  it("refuses to be the second host on one pipe name", async () => {
    const harness = await serve();
    const second = new SessionHost({
      dataDir: harness.endpoint,
      endpoint: harness.endpoint,
      key: harness.key,
      version: "second",
    });
    await expect(second.listen()).rejects.toBeInstanceOf(AlreadyServing);
  });

  /**
   * §4.3: the console has to be *proven* released, and a real one is the only
   * thing that can prove it.
   */
  it("destroys a session and confirms the console was released", async () => {
    const harness = await serve();
    const client = await connect(harness);
    const id = client.ids.issue();
    await client.link.request(id, createMessage(id, SPEC));
    const destroyId = client.ids.issue();
    const answer = await client.link.request(destroyId, {
      type: "destroy",
      id: destroyId,
      sessionKey: "node-a",
    });
    expect(answer.type, JSON.stringify(answer)).toBe("ok");
    expect(harness.host.sessionCount).toBe(0);
  });

  /** A shell that exits by itself is an `exit`, not a silence. */
  it("reports a console whose process ended", async () => {
    const harness = await serve();
    const client = await connect(harness);
    const id = client.ids.issue();
    await client.link.request(
      id,
      createMessage(id, {
        ...SPEC,
        command: "cmd.exe",
        args: ["/c", "exit 3"],
      }),
    );
    const attacher = await connect(harness);
    const attachId = attacher.ids.issue();
    await attacher.link.request(attachId, {
      type: "attach",
      id: attachId,
      sessionKey: "node-a",
      generation: 1,
      size: { cols: 100, rows: 30 },
    });
    await until(
      () => attacher.events.some((event) => event.type === "exit"),
      "the exit notice",
    );
  });

  /**
   * The host outliving the client is the point; the host *not* outliving its
   * own shutdown is the other half, and is what stands in for the Job
   * Object.
   */
  it("closes every console it holds when it stops", async () => {
    const harness = await serve();
    const client = await connect(harness);
    const id = client.ids.issue();
    await client.link.request(id, createMessage(id, SPEC));
    await expect(harness.host.close()).resolves.toBeUndefined();
    expect(harness.host.sessionCount).toBe(1);
  });
});
