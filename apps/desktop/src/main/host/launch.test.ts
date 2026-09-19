import { afterEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  HostManagementResultSchema,
  type HostStatus,
  HostStatusSchema,
  create,
  toBinary,
} from "@armadra/protocol";
import {
  HOST_ENDPOINT,
  type HostLaunchConfig,
} from "../../shell-core/host/config";
import { hostErrorOf } from "../../shell-core/host/errors";
import { readLimited, runStart } from "./launch";
import { startRunning, stopHost } from "./index";

/**
 * The assertion list of `src-tauri/src/host/tests.rs` that runs a real CLI:
 * bounded readers, stderr that is never echoed, the timeout that reaps only
 * the CLI parent, and the portless-Host replacement.
 */

const unix = process.platform !== "win32";
const directories: string[] = [];

afterEach(() => {
  for (const path of directories.splice(0))
    rmSync(path, { recursive: true, force: true });
});

/** A shell script standing in for `armadra-host`. */
function scriptFixture(body: string): string {
  const directory = mkdtempSync(join(tmpdir(), "armadra-launch-test-"));
  directories.push(directory);
  chmodSync(directory, 0o700);
  const path = join(directory, "host");
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o700);
  return path;
}

function config(binary: string): HostLaunchConfig {
  return {
    binary,
    dataDir: undefined,
    browserOrigin: "tauri://localhost",
    cliTimeoutMs: 15_000,
    endpointsDir: undefined,
    expectedHttpEndpoint: HOST_ENDPOINT,
  };
}

function status(overrides: Partial<HostStatus> = {}): HostStatus {
  return create(HostStatusSchema, {
    hostId: "host-1",
    hostInstanceId: "instance-1",
    httpEndpoint: HOST_ENDPOINT,
    startedAtUnixMs: 1_780_000_000_000n,
    processId: 123,
    ...overrides,
  });
}

function management(value: HostStatus): Uint8Array {
  return toBinary(
    HostManagementResultSchema,
    create(HostManagementResultSchema, { state: { case: "running", value } }),
  );
}

/** The bytes as an octal `printf` argument, so `/bin/sh` can emit them. */
function escape(wire: Uint8Array): string {
  return [...wire]
    .map((byte) => `\\${byte.toString(8).padStart(3, "0")}`)
    .join("");
}

async function kindOf(work: Promise<unknown>): Promise<string | undefined> {
  try {
    await work;
    return undefined;
  } catch (thrown) {
    return hostErrorOf(thrown)?.kind;
  }
}

describe("bounded readers", () => {
  it("stop at the limit, and never retain what they do not keep", async () => {
    expect([
      ...(await readLimited(Readable.from([Buffer.from("abcd")]), 4, true)),
    ]).toEqual([...Buffer.from("abcd")]);
    expect(
      await kindOf(readLimited(Readable.from([Buffer.from("abcde")]), 4, true)),
    ).toBe("cliOutputLimit");
    // stderr is drained but never retained.
    expect(
      await readLimited(Readable.from([Buffer.from("secret")]), 6, false),
    ).toHaveLength(0);
    expect(
      await kindOf(
        readLimited(Readable.from([Buffer.from("secret")]), 5, false),
      ),
    ).toBe("cliOutputLimit");
  });
});

describe.runIf(unix)("the real CLI", () => {
  it("returns protobuf stdout and never echoes stderr on failure", async () => {
    const wire = management(status());
    const ok = config(scriptFixture(`printf '${escape(wire)}'`));
    expect([...(await runStart(ok))]).toEqual([...wire]);

    const failing = config(
      scriptFixture("printf 'private-credential' >&2; exit 7"),
    );
    let message = "";
    try {
      await runStart(failing);
      expect.unreachable("a failing CLI must not resolve");
    } catch (thrown) {
      const detail = hostErrorOf(thrown);
      expect(detail?.kind).toBe("cliExit");
      if (detail?.kind === "cliExit") expect(detail.code).toBe(7);
      message = (thrown as Error).message;
    }
    expect(message).not.toContain("private");

    expect(
      await kindOf(
        runStart(config(join(tmpdir(), "missing-armadra-host-binary"))),
      ),
    ).toBe("binaryUnavailable");
  });

  it("stops reading when stdout or stderr overflow", async () => {
    for (const script of [
      "exec head -c 1048577 /dev/zero",
      "exec head -c 65537 /dev/zero >&2",
    ]) {
      expect(
        await kindOf(runStart(config(scriptFixture(script)))),
        script,
      ).toBe("cliOutputLimit");
    }
  });

  it("times out, and reaps only the CLI parent", async () => {
    const slow: HostLaunchConfig = {
      ...config(scriptFixture("exec sleep 30")),
      cliTimeoutMs: 1_000,
    };
    let pid: number | undefined;
    expect(await kindOf(runStart(slow, (spawned) => (pid = spawned)))).toBe(
      "cliTimeout",
    );
    expect(pid, "the CLI process was spawned").toBeDefined();
    // `kill -0` on a reaped pid throws: the parent is gone.
    expect(() => process.kill(pid as number, 0)).toThrow();
  });

  it("replaces a portless Host from an older shell exactly once", async () => {
    const old = escape(management(status({ httpEndpoint: "" })));
    const fresh = escape(management(status()));
    const marker = join(
      mkdtempSync(join(tmpdir(), "armadra-host-marker-")),
      "replaced",
    );
    directories.push(marker);

    // `start` answers with the portless instance until `stop` has been called.
    const fixture = scriptFixture(
      `case "$1" in stop) touch '${marker}'; printf '${old}';; ` +
        `start) if [ -e '${marker}' ]; then printf '${fresh}'; else printf '${old}'; fi;; esac`,
    );
    expect([...(await startRunning(config(fixture)))]).toEqual([
      ...management(status()),
    ]);
    expect(existsSync(marker), "the old Host was stopped").toBe(true);
    rmSync(marker, { force: true });

    // A Host on another port was configured by someone else: no stop is sent.
    const elsewhere = escape(
      management(status({ httpEndpoint: "http://127.0.0.1:12345" })),
    );
    const foreign = scriptFixture(
      `case "$1" in stop) touch '${marker}';; start) printf '${elsewhere}';; esac`,
    );
    expect(await kindOf(startRunning(config(foreign)))).toBe(
      "endpointMismatch",
    );
    expect(existsSync(marker), "a foreign Host is never stopped").toBe(false);
  });
});

describe.runIf(unix)("stopping the Host", () => {
  it("requires a stopped protobuf and does not echo errors", async () => {
    // `\022\000` is the two-byte `stopped` oneof.
    await expect(
      stopHost(config(scriptFixture("printf '\\022\\000'"))),
    ).resolves.toBeUndefined();

    // `\012\000` is `running` with an empty status: not a stop confirmation.
    await expect(
      stopHost(config(scriptFixture("printf '\\012\\000'"))),
    ).rejects.toThrow(/still running/);

    await expect(
      stopHost(config(scriptFixture("printf 'private-token' >&2; exit 7"))),
    ).rejects.toThrow(/did not confirm/);
    await stopHost(
      config(scriptFixture("printf 'private-token' >&2; exit 7")),
    ).catch((error: Error) =>
      expect(error.message).not.toContain("private-token"),
    );

    // A result larger than a stop result could ever be is refused outright.
    await expect(
      stopHost(config(scriptFixture("exec head -c 4097 /dev/zero"))),
    ).rejects.toThrow(/did not confirm/);
  });

  it("reports a Host that will not stop, rather than giving up quietly", async () => {
    const stuck: HostLaunchConfig = {
      ...config(scriptFixture("exec sleep 30")),
      cliTimeoutMs: 1_000,
    };
    await expect(stopHost(stuck)).rejects.toThrow(/timed out/);
  });

  it("passes the data directory through as one argument", async () => {
    const directory = mkdtempSync(join(tmpdir(), "host data with spaces-"));
    directories.push(directory);
    const seen = join(directory, "args");
    const fixture = scriptFixture(
      `printf '%s' "$1 $2 $3 $4 $5" > '${seen}'; printf '\\022\\000'`,
    );
    await stopHost({ ...config(fixture), dataDir: directory });
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(seen, "utf8")).toBe(
      `stop --output protobuf --data-dir ${directory}`,
    );
  });
});
