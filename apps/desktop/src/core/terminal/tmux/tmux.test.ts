import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { SESSION_PREFIX, sessionKey } from "../backend";
import { childEnvironment } from "../environment";
import {
  MINIMUM_VERSION,
  defaultTerminal,
  detect,
  ensureConf,
  parseVersion,
  renderedConf,
} from "./config";
import {
  LIST_ALIVE_FORMAT,
  enterOnly,
  parseAliveLine,
  pastePlan,
} from "./control";
import { TmuxBackend } from "./backend";

/**
 * The tmux backend's specification, ported one for one from
 * the pre-merge implementation.
 *
 * Everything that needs a live tmux server is guarded the same way the Rust
 * suite guards it — skipped when `tmux >= 3.2` is not on PATH — and binds its
 * socket under a tempdir it owns. That is not hygiene for its own sake: this
 * repository is developed from inside its own tmux-backed terminals, and a
 * test that reached for the real data directory would be driving the
 * developer's live sessions.
 */

const temporaries: string[] = [];

function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "armadra-tmux-"));
  temporaries.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaries.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("version detection", () => {
  it("compares against the floor", () => {
    expect(parseVersion("3.2a")).toEqual([3, 2]);
    expect(parseVersion("3.7b")).toEqual([3, 7]);
    expect(parseVersion("tmux 2.8")).toEqual([2, 8]);
    expect(parseVersion("3")).toEqual([3, 0]);
    expect(parseVersion("master")).toBeUndefined();
    expect(parseVersion("3.2a")?.[1]).toBeGreaterThanOrEqual(
      MINIMUM_VERSION[1],
    );
  });

  it("refuses on Windows without looking for a binary", () => {
    const detection = detect("win32");
    expect(detection.usable).toBe(false);
    expect(detection.reason).toContain("Windows");
  });
});

describe("the generated configuration", () => {
  it("is written once and then left alone", () => {
    const directory = tempDir();
    const conf = join(directory, "tmux.conf");
    ensureConf(conf);
    const written = statSync(conf).mtimeMs;
    expect(readFileSync(conf, "utf8")).toContain("prefix None");

    ensureConf(conf);
    expect(statSync(conf).mtimeMs).toBe(written);

    // A conf from an older build is replaced, not merged.
    writeFileSync(conf, "set -g status on\n");
    ensureConf(conf);
    expect(readFileSync(conf, "utf8")).toBe(renderedConf());
  });

  it.skipIf(process.platform === "win32")(
    "locks the directory to 0700 and the file to 0600",
    () => {
      const directory = tempDir();
      const conf = join(directory, "tmux.conf");
      ensureConf(conf);
      expect(statSync(conf).mode & 0o777).toBe(0o600);
      expect(statSync(directory).mode & 0o777).toBe(0o700);
    },
  );

  /**
   * Contract §18.3: true colour and the "resize to the smallest *attached*
   * client, not the smallest that ever attached" rule both live in the conf.
   */
  it("carries the compatibility options", () => {
    const conf = renderedConf();
    expect(conf).toContain('set -ga terminal-overrides ",*:Tc"');
    expect(conf).toContain('set -ga terminal-features ",xterm-256color:RGB"');
    expect(conf).toContain("set -g aggressive-resize on");
    expect(conf).toContain("set -g window-size latest");
    expect(conf).not.toContain("{terminal}");
  });

  /**
   * Contract §18.3 amendment: the client must never be put into mouse mode,
   * focus-reporting mode or the alternate screen, or the page loses native
   * selection and starts typing `\e[<0;8;3M` into whatever is running.
   */
  it("keeps selection, scrollback and the clipboard", () => {
    const conf = renderedConf();
    expect(conf).toContain("set -g mouse off");
    expect(conf).toContain("set -g focus-events off");
    expect(conf).not.toContain("set -g mouse on");
    expect(conf).not.toContain("set -g focus-events on");
    expect(conf).toContain('set -ga terminal-overrides ",*:smcup@:rmcup@"');
    expect(conf).toContain("set -g set-clipboard on");
    expect(conf).toContain('set -as terminal-features ",xterm*:clipboard"');
    expect(conf).toContain("set -g allow-passthrough on");
  });

  it("probes the default terminal and falls back", () => {
    const terminal = defaultTerminal();
    expect(["tmux-256color", "screen-256color"]).toContain(terminal);
    expect(renderedConf()).toContain(`set -g default-terminal "${terminal}"`);
  });
});

describe("listing", () => {
  /**
   * `session_activity` is bumped to `now` by every client attach, independent
   * of pane output, and is therefore useless as an idle judgement.
   */
  it("reads window_activity, not session_activity", () => {
    expect(LIST_ALIVE_FORMAT).toContain("#{window_activity}");
    expect(LIST_ALIVE_FORMAT).not.toContain("#{session_activity}");
  });

  it("ignores sessions that are not ours", () => {
    expect(
      parseAliveLine("armadra-a-b-1 1 1770000000", SESSION_PREFIX),
    ).toEqual({ name: "armadra-a-b-1", attached: true });
    expect(
      parseAliveLine("armadra-a-b-1 0 1770000000", SESSION_PREFIX),
    ).toEqual({ name: "armadra-a-b-1", attached: false });
    expect(
      parseAliveLine("someones-own-session 1 1", SESSION_PREFIX),
    ).toBeUndefined();
    expect(parseAliveLine("", SESSION_PREFIX)).toBeUndefined();
  });
});

describe("the paste plan", () => {
  /**
   * The copy-mode guard and the paste itself must be one tmux invocation, and
   * `-r` must be present so embedded newlines survive as `\n`.
   */
  it("guards copy-mode in the same call and keeps newlines", () => {
    const plan = pastePlan(
      "armadra-buf",
      "/tmp/armadra-buf.txt",
      "armadra-session",
      true,
    );
    expect(plan).toHaveLength(3);
    expect(plan[0]).toEqual([
      "load-buffer",
      "-b",
      "armadra-buf",
      "/tmp/armadra-buf.txt",
    ]);
    expect(plan[1]).toEqual([
      "if-shell",
      "-F",
      "#{pane_in_mode}",
      "send-keys -X cancel",
      ";",
      "paste-buffer",
      "-p",
      "-r",
      "-d",
      "-b",
      "armadra-buf",
      "-t",
      "armadra-session",
    ]);
    expect(plan[2]).toEqual(["send-keys", "-t", "armadra-session", "Enter"]);
  });

  it("skips Enter when it was not requested", () => {
    expect(
      pastePlan("armadra-buf", "/tmp/armadra-buf.txt", "s", false),
    ).toHaveLength(2);
  });

  /**
   * The Enter of an empty paste is the whole request. `load-buffer` of an
   * empty file creates no buffer, so the `paste-buffer -b` behind it used to
   * fail with "no buffer" and the route answered 500 — for "press Enter".
   */
  it("presses Enter on its own, with no buffer to load", () => {
    expect(enterOnly("armadra-session")).toEqual([
      "send-keys",
      "-t",
      "armadra-session",
      "Enter",
    ]);
  });
});

/* ------------------------- test server isolation -------------------------- */

describe("isolation", () => {
  /**
   * The production path, not a fixture: `childEnvironment` is what every tmux
   * child is spawned through, so this asserts what a real session inherits.
   * `TMUX`/`TMUX_PANE` simulate a suite launched from inside a live tmux pane
   * — the normal case for this repository's own development — and must not
   * survive the filter.
   */
  it("strips an ambient tmux client from the child environment", () => {
    const env = childEnvironment({
      ambient: {
        ...process.env,
        TMUX: "/tmp/tmux-0/default,1234,0",
        TMUX_PANE: "%0",
      },
    });
    expect(env.map(([key]) => key)).not.toContain("TMUX");
    expect(env.map(([key]) => key)).not.toContain("TMUX_PANE");
  });

  it("binds its socket under its own tempdir", () => {
    const directory = tempDir();
    const backend = new TmuxBackend({ dataDir: directory, version: "test" });
    expect(backend.socket.startsWith(directory)).toBe(true);
    expect(resolve(backend.socket)).not.toContain("Application Support");
  });

  /**
   * By review: prove the pattern matches the construction it is meant to
   * catch, and not its neighbours, before trusting it to scan anything.
   */
  it("has a pattern that catches a bare -L socket and nothing else", () => {
    const bareSocket = /["']-L["']/;
    expect(bareSocket.test('args(["-L", "armadra"])')).toBe(true);
    expect(bareSocket.test('["-L", name]')).toBe(true);
    expect(bareSocket.test('args(["-S", socketPath])')).toBe(false);
    expect(bareSocket.test("// production binds -S, never -L")).toBe(false);
  });

  /**
   * Scans every source file of this directory — this guard excepted, since it
   * is the one file allowed to spell the pattern out — for a bare `-L`
   * socket, the shared per-user default that an absolute `-S <path>` exists to
   * avoid needing. It cannot stop a new offender being written, but it makes
   * writing one a decision that fails CI rather than one nobody noticed.
   */
  it("finds no bare -L socket in this directory", () => {
    const bareSocket = /["']-L["']/;
    // `pathname`, not `fileURLToPath`, would hand Windows "/D:/…" — a string
    // no `existsSync` will ever agree with.
    const directory = fileURLToPath(new URL(".", import.meta.url));
    const files = ["backend.ts", "config.ts", "control.ts"];
    const offenders = files.filter((name) => {
      const path = join(directory, name);
      expect(existsSync(path)).toBe(true);
      return bareSocket.test(readFileSync(path, "utf8"));
    });
    expect(offenders).toEqual([]);
  });
});

/* -------------------------- a real tmux server ---------------------------- */

const tmuxAvailable = detect().usable;

describe.skipIf(!tmuxAvailable)("against a real tmux", () => {
  it("binds the socket file under the tempdir and destroys what it made", async () => {
    const directory = tempDir();
    const backend = new TmuxBackend({ dataDir: directory, version: "test" });
    const key = sessionKey("isolation-guard");
    await backend.create({
      sessionKey: key,
      workspaceId: "isolation-guard-workspace",
      generation: 1,
      cwd: directory,
      shell: "/bin/sh",
      args: [],
      env: [],
      size: { cols: 80, rows: 24 },
    });
    expect(existsSync(join(directory, "tmux.sock"))).toBe(true);

    const alive = await backend.list();
    expect(alive.map((entry) => entry.name)).toContain(
      // `isolatio` is the workspace head, `on-guard` the key TAIL.
      "armadra-isolatio-on-guard-1",
    );

    await backend.terminate(key, "session");
    expect(await backend.list()).toEqual([]);
    // Leave nothing running behind us.
    try {
      execFileSync(
        "tmux",
        ["-S", join(directory, "tmux.sock"), "kill-server"],
        {
          stdio: "ignore",
        },
      );
    } catch {
      // Already gone; `exit-empty on` does this for us.
    }
  }, 30_000);

  it("refuses an attach that carries a stale generation", async () => {
    const directory = tempDir();
    const backend = new TmuxBackend({ dataDir: directory, version: "test" });
    const key = sessionKey("generation-guard");
    await backend.create({
      sessionKey: key,
      workspaceId: "generation-guard-workspace",
      generation: 1,
      cwd: directory,
      shell: "/bin/sh",
      args: [],
      env: [],
      size: { cols: 80, rows: 24 },
    });
    await expect(
      backend.attach(key, 0, { cols: 80, rows: 24 }),
    ).rejects.toMatchObject({ status: 409 });
    await backend.terminate(key, "session");
  }, 30_000);
});
