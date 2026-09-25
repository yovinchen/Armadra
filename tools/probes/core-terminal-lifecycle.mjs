#!/usr/bin/env node
/**
 * The R2a acceptance path, against a real built core.
 *
 * `core-terminal-smoke.mjs` proves one terminal's bytes go round. This proves
 * the four things that only exist once the *rest* of R2 is there, and each of
 * them needs a process boundary that no unit test can stand in for:
 *
 *   1. **Kill the core, start another one.** The tmux pane is adopted, the row
 *      goes back to `detached` at the same generation, and a socket reattached
 *      to it sees what the first core typed (`sawEarlierOutput`).
 *   2. **The same sequence on the direct backend.** The session is simply gone
 *      — and gone *without an error*: a create that answers 200 and a next core
 *      that settles the row as `failed` rather than hanging on a pane nothing
 *      is holding.
 *   3. **An attach does not reset the idle clock.** `#{window_activity}` is the
 *      GC's judgement precisely because `session_activity` moves on every
 *      client attach; if it did not hold, a reattached-but-silent session would
 *      never be reclaimed. Read off the private socket, by hand.
 *   4. **The rest of the routes answer for real**: capture, paste, scroll,
 *      recycle and `GET /api/terminals/backend`.
 *
 * ```sh
 * pnpm --filter @armadra/desktop build     # produces out/core/main.js
 * node tools/probes/core-terminal-lifecycle.mjs
 * node tools/probes/core-terminal-lifecycle.mjs --backend direct
 * ```
 *
 * No Electron and no browser: the acceptance surface is the protocol, and the
 * page's own state machine is exercised by its own tests against these frames.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  WORKSPACE,
  collect,
  openSocket,
  seedWorkspace,
  startCore,
} from "./core-terminal-smoke.mjs";

const require = createRequire(
  join(
    fileURLToPath(new URL("../..", import.meta.url)),
    "apps/desktop/package.json",
  ),
);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/**
 * Pins `terminal.backend` before the core starts.
 *
 * The local half of the settings document, because that is where the backend
 * choice lives: it is a property of this machine, not of the person.
 */
function pinBackend(dataDir, backend) {
  writeFileSync(
    join(dataDir, "worker-settings.json"),
    JSON.stringify({ terminal: { backend } }, null, 2),
    "utf8",
  );
}

async function createTerminal(core, body) {
  const answer = await fetch(`${core.base}/api/terminals`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspaceId: WORKSPACE, ...body }),
  });
  const session = await answer.json();
  assert(answer.ok, `create failed: ${JSON.stringify(session)}`);
  return session;
}

async function row(core, sessionId) {
  const answer = await fetch(`${core.base}/api/terminals/${sessionId}`);
  const body = await answer.json();
  assert(answer.ok, `GET terminal failed: ${JSON.stringify(body)}`);
  return body;
}

/** Types into a socket and waits for the echo, so the pane really has it. */
async function type(socket, frames, text, inputId) {
  socket.send(JSON.stringify({ type: "input", data: `${text}\r`, inputId }));
  await frames.waitFor(
    (frame) => frame.type === "ack" && frame.inputId === inputId,
  );
}

/* ------------------------------- the scenarios ----------------------------- */

/** 1 and 2: what a restart does, per backend. */
async function survivesARestart(dataDir, backend) {
  console.log(`\n== ${backend}: a session across two cores ==`);
  pinBackend(dataDir, backend);
  const first = await startCore({ dataDir });
  seedWorkspace(dataDir);

  let sessionId;
  let marker;
  try {
    const reported = await (
      await fetch(`${first.base}/api/terminals/backend`)
    ).json();
    assert(
      reported.effective === backend,
      `effective backend was ${reported.effective}, expected ${backend}`,
    );

    const session = await createTerminal(first, {
      cwd: dataDir,
      shell: "/bin/sh",
    });
    sessionId = session.id;
    assert(session.backend === backend, `row said ${session.backend}`);

    const socket = openSocket(first.ws, sessionId, "probe");
    const frames = collect(socket);
    await new Promise((resolve) => socket.once("open", resolve));
    const hello = await frames.waitFor((frame) => frame.type === "hello");
    assert(hello.alive === true, "the first socket did not attach");
    assert(
      hello.acknowledgedInput === 0,
      `a fresh writer was told ${hello.acknowledgedInput}`,
    );

    marker = `restart-${Date.now()}`;
    await type(socket, frames, `echo ${marker}`, 1);
    await frames.waitFor(
      (frame) => frame.type === "output" && frame.data.includes(marker),
    );

    // The ledger outlives the connection: the socket that sent that keystroke
    // is the one that is about to go.
    socket.close();
    await delay(300);
    const again = openSocket(first.ws, sessionId, "probe");
    const againFrames = collect(again);
    await new Promise((resolve) => again.once("open", resolve));
    const second = await againFrames.waitFor((frame) => frame.type === "hello");
    assert(
      second.acknowledgedInput === 1,
      `a reconnecting writer was told ${second.acknowledgedInput}, expected 1`,
    );
    console.log("acknowledgedInput survives the connection");
    again.close();
    await delay(200);
  } finally {
    // SIGTERM, the way the shell stops it.
    await first.stop();
  }

  await delay(500);
  const second = await startCore({ dataDir });
  try {
    const after = await row(second, sessionId);
    if (backend === "direct") {
      // A direct session died with the core that owned it. The row says so,
      // and nothing about the sequence is an error.
      assert(
        after.status !== "running",
        `a direct session claimed to still be ${after.status}`,
      );
      console.log(`direct: the session is gone, status ${after.status}`);
      return;
    }

    assert(after.status === "running", `adopted row said ${after.status}`);
    assert(
      after.attachState === "detached",
      `adopted row was ${after.attachState}`,
    );
    assert(after.generation === 1, `generation moved to ${after.generation}`);

    const socket = openSocket(second.ws, sessionId, "probe-2");
    const frames = collect(socket);
    await new Promise((resolve) => socket.once("open", resolve));
    const greeting = await frames.waitFor((frame) => frame.type === "hello");
    assert(
      greeting.alive === true,
      `the adopted session did not attach:\n${second.stderr().slice(-2000)}`,
    );
    await frames.waitFor(
      (frame) =>
        (frame.type === "output" || frame.type === "snapshot") &&
        frame.data.includes(marker),
    );
    console.log(
      "sawEarlierOutput: the adopted pane still has what core #1 typed",
    );
    socket.close();

    await fetch(`${second.base}/api/terminals/${sessionId}/terminate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "session" }),
    });
  } finally {
    await second.stop();
  }
}

/** 3: an attach alone must not look like activity. */
async function attachDoesNotResetIdle(dataDir) {
  console.log("\n== the GC's idle judgement ==");
  pinBackend(dataDir, "tmux");
  const core = await startCore({ dataDir });
  const socketPath = join(dataDir, "tmux.sock");
  try {
    seedWorkspace(dataDir);
    const session = await createTerminal(core, {
      cwd: dataDir,
      shell: "/bin/sh",
    });

    const activity = () => {
      const output = execFileSync(
        "tmux",
        [
          "-S",
          socketPath,
          "list-sessions",
          "-F",
          "#{session_name} #{session_activity} #{window_activity}",
        ],
        { encoding: "utf8" },
      );
      const line = output
        .split("\n")
        .find((entry) => entry.startsWith("armadra-"));
      assert(line !== undefined, `no armadra session in:\n${output}`);
      const parts = line.split(/\s+/);
      return { session: Number(parts[1]), window: Number(parts[2]) };
    };

    const before = activity();
    // Far enough that a one-second clock would visibly move.
    await delay(2_500);

    const socket = openSocket(core.ws, session.id, "idle-probe");
    const frames = collect(socket);
    await new Promise((resolve) => socket.once("open", resolve));
    await frames.waitFor((frame) => frame.type === "hello");
    socket.close();
    await delay(500);

    const after = activity();
    assert(
      after.window === before.window,
      `an attach moved window_activity from ${before.window} to ${after.window}`,
    );
    console.log(
      `window_activity held at ${after.window} across an attach` +
        (after.session === before.session
          ? " (session_activity did too, on this tmux)"
          : `, while session_activity moved to ${after.session}`),
    );

    await fetch(`${core.base}/api/terminals/${session.id}/terminate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "session" }),
    });
  } finally {
    await core.stop();
    try {
      execFileSync("tmux", ["-S", socketPath, "kill-server"], {
        stdio: "ignore",
      });
    } catch {
      // `exit-empty on` usually got there first.
    }
  }
}

/** 4: the routes this batch claimed, answering for real. */
async function theRestOfTheRoutes(dataDir, backend) {
  console.log(`\n== ${backend}: capture, paste, scroll, recycle ==`);
  pinBackend(dataDir, backend);
  const core = await startCore({ dataDir });
  try {
    seedWorkspace(dataDir);
    const session = await createTerminal(core, {
      cwd: dataDir,
      shell: "/bin/sh",
    });
    const socket = openSocket(core.ws, session.id, "routes");
    const frames = collect(socket);
    await new Promise((resolve) => socket.once("open", resolve));
    await frames.waitFor((frame) => frame.type === "hello");

    const marker = `capture-${Date.now()}`;
    await type(socket, frames, `echo ${marker}`, 1);
    await frames.waitFor(
      (frame) => frame.type === "output" && frame.data.includes(marker),
    );

    const captured = await (
      await fetch(
        `${core.base}/api/terminals/${session.id}/capture?lines=50&escapes=false`,
      )
    ).json();
    assert(
      captured.data.includes(marker),
      `capture missed the marker: ${JSON.stringify(captured).slice(0, 300)}`,
    );
    assert(
      captured.generation === 1,
      `capture said generation ${captured.generation}`,
    );
    console.log(`capture: ${captured.lines} lines, marker present`);

    const pasteMarker = `paste-${Date.now()}`;
    const pasted = await fetch(
      `${core.base}/api/terminals/${session.id}/paste`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: `echo ${pasteMarker}`, enter: true }),
      },
    );
    assert(pasted.ok, `paste failed: ${await pasted.text()}`);
    await frames.waitFor(
      (frame) => frame.type === "output" && frame.data.includes(pasteMarker),
      15_000,
    );
    console.log("paste: ran as one paste event and produced its output");

    const scrolled = await fetch(
      `${core.base}/api/terminals/${session.id}/scroll`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ lines: 3 }),
      },
    );
    assert(scrolled.status === 204, `scroll answered ${scrolled.status}`);
    // Typing always wins over scrollback: the next keystroke has to reach the
    // application rather than being eaten as a copy-mode command.
    const afterScroll = `after-scroll-${Date.now()}`;
    await type(socket, frames, `echo ${afterScroll}`, 2);
    await frames.waitFor(
      (frame) => frame.type === "output" && frame.data.includes(afterScroll),
      15_000,
    );
    console.log("scroll: 204, and typing left copy-mode by itself");

    const recycled = await (
      await fetch(`${core.base}/api/terminals/${session.id}/recycle`, {
        method: "POST",
      })
    ).json();
    assert(recycled.generation === 2, `recycle said ${recycled.generation}`);
    assert(recycled.sessionKey === session.sessionKey, "the logical key moved");
    // The socket attached to generation 1 is told to clear and reconnect.
    const stale = await frames.waitFor(
      (frame) => frame.type === "stale",
      15_000,
    );
    assert(stale.generation === 2, `stale named ${stale.generation}`);
    console.log("recycle: generation 2, and the old socket got `stale`");
    socket.close();

    await fetch(`${core.base}/api/terminals/${session.id}/terminate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "session" }),
    });
  } finally {
    await core.stop();
  }
}

/* ---------------------------------- driver --------------------------------- */

async function main() {
  const wanted = process.argv.includes("--backend")
    ? process.argv[process.argv.indexOf("--backend") + 1]
    : undefined;
  const backends = wanted ? [wanted] : ["tmux", "direct"];

  for (const backend of backends) {
    const dataDir = mkdtempSync(
      join(tmpdir(), `armadra-lifecycle-${backend}-`),
    );
    try {
      await survivesARestart(dataDir, backend);
      await theRestOfTheRoutes(dataDir, backend);
      if (backend === "tmux") await attachDoesNotResetIdle(dataDir);
    } finally {
      try {
        execFileSync(
          "tmux",
          ["-S", join(dataDir, "tmux.sock"), "kill-server"],
          {
            stdio: "ignore",
          },
        );
      } catch {
        // Nothing of ours was left running.
      }
      // A shell the core just killed may still hold the directory for a
      // moment (and on Windows an open handle refuses the delete outright):
      // retry, then leave it to the OS rather than turn a pass into a throw.
      try {
        rmSync(dataDir, { recursive: true, force: true, maxRetries: 20 });
      } catch {
        // Left for the OS.
      }
    }
  }
  console.log("\nOK");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(String(error.stack ?? error));
    process.exit(1);
  });
}

// Referenced so the resolver is exercised even when nothing below needs it.
void require;
