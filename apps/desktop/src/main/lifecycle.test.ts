import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HOST_ENDPOINT,
  type HostLaunchConfig,
  MAX_CLI_TIMEOUT_MS,
} from "../shell-core/host/config";
import {
  DesktopLifecycle,
  quitFailureDialog,
  runQuitSequence,
} from "./lifecycle";
import type { RuntimeProcess } from "./runtime-process";

/**
 * The quit orchestration: Host first, then the Runtime, and no exit unless
 * both confirmed. Ported from the Rust shell's lifecycle suite and its
 * `request_quit` sequence.
 */

const unix = process.platform !== "win32";
const directories: string[] = [];

afterEach(() => {
  for (const path of directories.splice(0))
    rmSync(path, { recursive: true, force: true });
});

function scriptFixture(body: string): string {
  const directory = mkdtempSync(join(tmpdir(), "armadra-lifecycle-test-"));
  directories.push(directory);
  const path = join(directory, "host");
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o700);
  return path;
}

function config(binary: string): HostLaunchConfig {
  return {
    binary,
    dataDir: undefined,
    browserOrigin: "http://127.0.0.1:54321",
    // The production budget. macOS scans each freshly written executable
    // before it first runs, which costs up to ~2s here; only the "will not
    // stop" case below is about the timeout, and a tight budget for the rest
    // would measure Gatekeeper instead of the shell.
    cliTimeoutMs: MAX_CLI_TIMEOUT_MS,
    endpointsDir: undefined,
    expectedHttpEndpoint: HOST_ENDPOINT,
  };
}

/** A Runtime stand-in: it records what was asked of it and answers as told. */
function fakeRuntime(
  behaviour: "ok" | "fail",
): RuntimeProcess & { stopped: number } {
  let stopped = 0;
  return {
    get stopped() {
      return stopped;
    },
    async stop() {
      stopped += 1;
      if (behaviour === "fail")
        throw new Error("Runtime failed to stop all managed sessions");
    },
  } as unknown as RuntimeProcess & { stopped: number };
}

describe("a quit that was requested before startup", () => {
  it("prevents a late Host launch", async () => {
    const lifecycle = new DesktopLifecycle();
    lifecycle.configureHost(
      config(join(tmpdir(), "missing-host-that-must-not-launch")),
    );
    expect(lifecycle.state.beginQuit()).toBe(true);
    // The Host binary does not exist; if startHost tried to run it, this would
    // reject rather than return.
    await expect(lifecycle.startHost()).resolves.toBeUndefined();
    expect(lifecycle.observedHost()).toBeNull();
  });
});

describe.runIf(unix)("the quit sequence", () => {
  it("stops the Host, then the Runtime, and permits exit", async () => {
    const lifecycle = new DesktopLifecycle();
    lifecycle.configureHost(config(scriptFixture("printf '\\022\\000'")));
    const runtime = fakeRuntime("ok");
    lifecycle.state.beginQuit();
    expect(await runQuitSequence(lifecycle, runtime)).toEqual({ ok: true });
    expect(runtime.stopped).toBe(1);
    expect(lifecycle.state.canExit()).toBe(true);
  });

  it("does not exit when the Host will not stop", async () => {
    const lifecycle = new DesktopLifecycle();
    // A Host that never answers: the same shape as one stopped with SIGSTOP.
    lifecycle.configureHost({
      ...config(scriptFixture("exec sleep 30")),
      cliTimeoutMs: 1_000,
    });
    const runtime = fakeRuntime("ok");
    lifecycle.state.beginQuit();
    const outcome = await runQuitSequence(lifecycle, runtime);
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toMatch(/timed out/);
    // The application stays open and usable.
    expect(lifecycle.state.canExit()).toBe(false);
    expect(lifecycle.state.isQuitting()).toBe(false);
    expect(lifecycle.state.reveal()).toBe(true);
    // The Runtime is still stopped: leaving it running would be a second
    // orphan on top of the one the user already has to deal with.
    expect(runtime.stopped).toBe(1);
  });

  it("does not exit when the Runtime will not confirm", async () => {
    const lifecycle = new DesktopLifecycle();
    lifecycle.configureHost(config(scriptFixture("printf '\\022\\000'")));
    const runtime = fakeRuntime("fail");
    lifecycle.state.beginQuit();
    const outcome = await runQuitSequence(lifecycle, runtime);
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toMatch(/managed sessions/);
    expect(lifecycle.state.canExit()).toBe(false);
  });

  it("reports both failures rather than only the first", async () => {
    const lifecycle = new DesktopLifecycle();
    lifecycle.configureHost(config(scriptFixture("printf '\\012\\000'")));
    const outcome = await runQuitSequence(lifecycle, fakeRuntime("fail"));
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toMatch(/still running/);
    expect(outcome.message).toMatch(/managed sessions/);
  });

  it("succeeds with no Host configured at all", async () => {
    const lifecycle = new DesktopLifecycle();
    const runtime = fakeRuntime("ok");
    expect(await runQuitSequence(lifecycle, runtime)).toEqual({ ok: true });
    expect(runtime.stopped).toBe(1);
  });
});

describe("the failure dialog", () => {
  it("says the application has not exited, and why", () => {
    const text = quitFailureDialog("Host is still running");
    expect(text.title).toBe("Armadra 退出未完成");
    expect(text.body).toContain("应用尚未退出");
    expect(text.body).toContain("Host is still running");
  });
});
