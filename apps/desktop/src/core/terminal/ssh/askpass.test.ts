/**
 * The askpass protocol, end to end.
 *
 * The Rust module can only unit-test its environment and its refusal, because
 * its helper is a second mode of a binary a test cannot exec. This helper is a
 * generated script, so the interesting half — does `sh` + `curl` actually
 * reach the socket, present the token, carry the prompt and print exactly the
 * one line `ssh` reads — is runnable, and is run here.
 *
 * The cases that need `sh` and `curl` skip themselves on a machine without
 * them rather than failing; every platform Armadra targets except Windows has
 * both, and Windows does not start the service at all.
 */

import { execFile } from "node:child_process";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  AskpassService,
  HELPER_WAIT_SECONDS,
  HOST_ENV,
  SOCKET_ENV,
  TOKEN_ENV,
  askpassOptions,
  environment,
  escapeConfigValue,
  helperPath,
  helperScript,
  socketPath,
} from "./askpass";
import type { SshPrompt } from "./prompts";

const run = promisify(execFile);

/** `sh` and `curl` are on every platform this service starts on. */
const RUNNABLE = process.platform !== "win32";
const shell = RUNNABLE ? it : it.skip;

let services: AskpassService[] = [];

function service(onPrompt: (prompt: SshPrompt) => void): {
  readonly service: AskpassService;
  readonly dataDir: string;
} {
  const dataDir = mkdtempSync(join(tmpdir(), "armadra-askpass-"));
  const created = new AskpassService({ dataDir, onPrompt });
  services.push(created);
  return { service: created, dataDir };
}

afterEach(async () => {
  for (const created of services) await created.stop();
  services = [];
});

describe("the options and the environment", () => {
  /**
   * Prompting has to be re-enabled for the helper to be consulted at all, and
   * a wrong answer must cost one dialog rather than three.
   */
  it("enables exactly one prompt", () => {
    const options = askpassOptions();
    expect(
      options.some((value, index) => value === "-o" && options[index + 1] === "BatchMode=no"),
    ).toBe(true);
    expect(
      options.some(
        (value, index) =>
          value === "-o" && options[index + 1] === "NumberOfPasswordPrompts=1",
      ),
    ).toBe(true);
  });

  /**
   * The forced require is what makes this work without a display; the
   * `DISPLAY` placeholder is the fallback for OpenSSH before 8.4, which
   * ignores `SSH_ASKPASS` entirely without one.
   */
  it("forces the helper on both old and new OpenSSH", () => {
    const pairs = new Map(environment("/opt/armadra/askpass", "/s.sock", "t", "box"));
    expect(pairs.get("SSH_ASKPASS_REQUIRE")).toBe("force");
    expect(pairs.get("DISPLAY")).toBeDefined();
    expect(pairs.get("SSH_ASKPASS")).toBe("/opt/armadra/askpass");
    expect(pairs.get(TOKEN_ENV)).toBe("t");
    expect(pairs.get(HOST_ENV)).toBe("box");
    expect(pairs.get(SOCKET_ENV)).toBe("/s.sock");
  });

  it("hands out nothing before the socket is bound", () => {
    const { service: created } = service(() => {});
    expect(created.childEnvironment("box")).toBeUndefined();
  });
});

describe("the curl config escaping", () => {
  it("escapes the two characters a quoted value understands", () => {
    expect(escapeConfigValue('say "hi"')).toBe('say \\"hi\\"');
    expect(escapeConfigValue("back\\slash")).toBe("back\\\\slash");
    expect(escapeConfigValue("plain")).toBe("plain");
  });

  /**
   * The script does the same escaping in `sed`, and the two must agree: a
   * prompt whose quoting ends early could add a `--output` line to the config.
   */
  shell("agrees with the sed the generated script runs", async () => {
    for (const value of ['say "hi"', "back\\slash", "plain", '"\\"']) {
      const { stdout } = await run("/bin/sh", [
        "-c",
        `printf '%s' "$1" | sed -e 's/\\\\/\\\\\\\\/g' -e 's/"/\\\\"/g'`,
        "sh",
        value,
      ]);
      expect(stdout).toBe(escapeConfigValue(value));
    }
  });
});

describe("the generated helper", () => {
  it("names the socket, the route and the wait", () => {
    const script = helperScript("/tmp/x.sock");
    expect(script.startsWith("#!/bin/sh\n")).toBe(true);
    expect(script).toContain(`--max-time ${HELPER_WAIT_SECONDS}`);
    expect(script).toContain("/tmp/x.sock");
    // The token and the prompt are inside the heredoc, never on the command
    // line: `ps` and /proc/<pid>/cmdline are globally readable.
    const commandLine = script
      .split("\n")
      .find((line) => line.startsWith("exec curl"));
    expect(commandLine).toBeDefined();
    expect(commandLine).not.toContain(TOKEN_ENV);
    expect(commandLine).not.toContain("$prompt");
  });

  shell("is a script sh will parse", async () => {
    const { service: created, dataDir } = service(() => {});
    await created.start();
    await run("/bin/sh", ["-n", helperPath(dataDir)]);
  });

  shell("is written 0700 and the socket 0600", async () => {
    const { service: created, dataDir } = service(() => {});
    await created.start();
    // eslint-disable-next-line no-bitwise -- reading the mode is the point
    expect(statSync(helperPath(dataDir)).mode & 0o777).toBe(0o700);
    // eslint-disable-next-line no-bitwise -- reading the mode is the point
    expect(statSync(socketPath(dataDir)).mode & 0o777).toBe(0o600);
  });

  /**
   * Without the environment the core sets, the helper is some other program's
   * child and must not open a dialog. All three values are required: a token
   * without a socket is as meaningless as neither.
   */
  shell("refuses when it was not started by this core", async () => {
    const { service: created, dataDir } = service(() => {
      throw new Error("no prompt may be opened");
    });
    await created.start();
    const helper = helperPath(dataDir);
    const socket = socketPath(dataDir);
    const token = created.mint();
    for (const env of [
      {},
      { [SOCKET_ENV]: socket },
      { [SOCKET_ENV]: socket, [TOKEN_ENV]: token },
      { [TOKEN_ENV]: token, [HOST_ENV]: "box" },
      { [SOCKET_ENV]: socket, [TOKEN_ENV]: "", [HOST_ENV]: "box" },
    ]) {
      await expect(
        run(helper, ["password: "], { env: { PATH: process.env.PATH ?? "", ...env } }),
      ).rejects.toMatchObject({ code: expect.anything() });
    }
  });

  /** The whole round trip: prompt out, secret back, exactly one line. */
  shell("carries the prompt out and the one-line answer back", async () => {
    let seen: SshPrompt | undefined;
    const { service: created, dataDir } = service((prompt) => {
      seen = prompt;
      // Answered as soon as it is announced, which is what the page does when
      // a person types into the dialog.
      setTimeout(() => {
        created.prompts.answer(prompt.promptId, prompt.hostId, "hunter2");
      }, 10);
    });
    await created.start();
    const env = created.childEnvironment("box");
    expect(env).toBeDefined();
    const { stdout } = await run(helperPath(dataDir), ['ada@box\'s "password": '], {
      env: { PATH: process.env.PATH ?? "", ...Object.fromEntries(env ?? []) },
    });
    // One line, exactly as `ssh` reads it.
    expect(stdout).toBe("hunter2\n");
    expect(seen?.hostId).toBe("box");
    // The quote survived the config escaping rather than truncating the prompt.
    expect(seen?.prompt).toBe('ada@box\'s "password": ');
    void dataDir;
  });

  /**
   * A token is spent on first use. A helper that replayed one could open a
   * second dialog for a connection attempt that is already over.
   */
  shell("spends a token on the first request", async () => {
    let prompts = 0;
    const { service: created, dataDir } = service((prompt) => {
      prompts += 1;
      created.prompts.answer(prompt.promptId, prompt.hostId, "once");
    });
    await created.start();
    const env = {
      PATH: process.env.PATH ?? "",
      ...Object.fromEntries(created.childEnvironment("box") ?? []),
    };
    const { stdout } = await run(helperPath(dataDir), ["password: "], { env });
    expect(stdout).toBe("once\n");
    await expect(
      run(helperPath(dataDir), ["password: "], { env }),
    ).rejects.toMatchObject({ code: expect.anything() });
    expect(prompts).toBe(1);
  });

  /**
   * A prompt nobody answers must make the helper exit non-zero with nothing on
   * stdout. Printing a guess would turn "nobody was there" into an
   * authentication failure, which is a different and more confusing thing to
   * debug.
   */
  shell("exits non-zero and prints nothing when the prompt is cancelled", async () => {
    const { service: created, dataDir } = service((prompt) => {
      setTimeout(() => created.prompts.close(prompt.promptId), 10);
    });
    await created.start();
    const env = {
      PATH: process.env.PATH ?? "",
      ...Object.fromEntries(created.childEnvironment("box") ?? []),
    };
    const failure = await run(helperPath(dataDir), ["password: "], {
      env,
    }).catch((error: { code?: number; stdout?: string }) => error);
    expect(failure).toMatchObject({ code: expect.anything() });
    expect((failure as { stdout?: string }).stdout ?? "").toBe("");
  });
});
