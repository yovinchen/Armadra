import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BootstrapTicketResponseSchema,
  type HostStatus,
  HostStatusSchema,
  create,
  toBinary,
} from "@armadra/protocol";
import {
  HOST_ENDPOINT,
  type HostLaunchConfig,
  resolveBinary,
} from "../../shell-core/host/config";
import { runtimeExecutable } from "../runtime-process";
import {
  NativeTicketError,
  type NativeTicketReason,
  decodeTicket,
  pairArguments,
  ticketShape,
} from "../../shell-core/host/ticket";
import { deviceName, issueNativeTicket } from "./ticket";

/**
 * The ticket assertions of `src-tauri/src/host/tests.rs:199-380`, carried
 * across: the exact `pair` line, what a ticket has to match before it is
 * believed, and that neither the secret nor the CLI's stderr ever reaches
 * anything the page or a log can read.
 */

const unix = process.platform !== "win32";
const directories: string[] = [];

afterEach(() => {
  for (const path of directories.splice(0))
    rmSync(path, { recursive: true, force: true });
});

function scriptFixture(body: string): string {
  const directory = mkdtempSync(join(tmpdir(), "armadra-ticket-test-"));
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

const SECRET = `${"a".repeat(32)}.${"B".repeat(43)}`;

function ticketWire(
  overrides: Partial<{
    hostId: string;
    hostInstanceId: string;
    ticket: string;
    origin: string;
    expiresAtUnixMs: bigint;
  }> = {},
): Uint8Array {
  return toBinary(
    BootstrapTicketResponseSchema,
    create(BootstrapTicketResponseSchema, {
      hostId: "host-1",
      hostInstanceId: "instance-1",
      ticket: SECRET,
      origin: "tauri://localhost",
      expiresAtUnixMs: 2_000_000n,
      ...overrides,
    }),
  );
}

function escape(wire: Uint8Array): string {
  return [...wire]
    .map((byte) => `\\${byte.toString(8).padStart(3, "0")}`)
    .join("");
}

async function reasonOf(work: Promise<unknown>): Promise<string | undefined> {
  try {
    await work;
    return undefined;
  } catch (thrown) {
    return thrown instanceof NativeTicketError
      ? thrown.reason
      : "not-a-ticket-error";
  }
}

describe("where a packaged shell looks for its Host", () => {
  it("is the one directory `extraResources` actually stages into", () => {
    const resources = "/Applications/Armadra.app/Contents/Resources";
    // The Host and the Runtime must agree: electron-builder stages all four
    // binaries into `process.resourcesPath`, and resolving one of them beside
    // `process.execPath` is how a double-clicked application ends up with a
    // Runtime but no Host.
    expect(
      resolveBinary(false, resources, "/repo", undefined, undefined, "darwin"),
    ).toEqual({ ok: true, binary: join(resources, "armadra-host") });
    expect(runtimeExecutable(true, {}, resources, "/repo")).toBe(
      join(resources, "armadra-runtime"),
    );
  });
});

describe("the pair line", () => {
  it("binds the shell's own origin and the device name", () => {
    const directory = join(tmpdir(), "host data with spaces");
    expect(
      pairArguments({ ...config("/bin/true"), dataDir: directory }, "本机桌面"),
    ).toEqual([
      "pair",
      "--output",
      "protobuf",
      "--origin",
      "tauri://localhost",
      "--device-name",
      "本机桌面",
      "--data-dir",
      directory,
    ]);
    expect(pairArguments(config("/bin/true"), "This desktop")).toHaveLength(7);
    // The Electron shell's origin is its static server's, carried verbatim
    // including the port the kernel chose.
    expect(
      pairArguments(
        { ...config("/bin/true"), browserOrigin: "http://127.0.0.1:54321" },
        "本机桌面",
      )[4],
    ).toBe("http://127.0.0.1:54321");
  });

  it("labels the device by the shell's locale", () => {
    expect(deviceName("zh-CN")).toBe("本机桌面");
    expect(deviceName("zh")).toBe("本机桌面");
    expect(deviceName("en-US")).toBe("This desktop");
    expect(deviceName("")).toBe("This desktop");
  });
});

describe("what a ticket has to prove", () => {
  it("accepts one for the observed Host, this origin and a future expiry", () => {
    const ticket = decodeTicket(
      ticketWire(),
      status(),
      "tauri://localhost",
      1_000_000,
    );
    expect(ticket.hostId).toBe("host-1");
    expect(ticket.origin).toBe("tauri://localhost");
    // A decimal string, never a bigint: the page compares it as one.
    expect(ticket.expiresAtUnixMs).toBe("2000000");
    expect(JSON.parse(JSON.stringify(ticket)).expiresAtUnixMs).toBe("2000000");

    // The same flow on the Electron shell's loopback HTTP origin.
    const loopback = decodeTicket(
      ticketWire({ origin: "http://127.0.0.1:54321" }),
      status(),
      "http://127.0.0.1:54321",
      1_000_000,
    );
    expect(loopback.ticket).toBe(SECRET);
  });

  it("refuses everything that is not exactly that", () => {
    const cases: [string, Uint8Array, string, number][] = [
      [
        "other host",
        ticketWire({ hostId: "host-2" }),
        "tauri://localhost",
        1e6,
      ],
      [
        "other instance",
        ticketWire({ hostInstanceId: "instance-2" }),
        "tauri://localhost",
        1e6,
      ],
      ["other origin", ticketWire(), "http://127.0.0.1:1420", 1e6],
      // A port is part of the origin: the same host on another port is not us.
      [
        "other port",
        ticketWire({ origin: "http://127.0.0.1:54321" }),
        "http://127.0.0.1:54322",
        1e6,
      ],
      ["expired", ticketWire(), "tauri://localhost", 2_000_000],
      ["empty ticket", ticketWire({ ticket: "" }), "tauri://localhost", 1e6],
      [
        "malformed ticket",
        ticketWire({ ticket: "not a ticket" }),
        "tauri://localhost",
        1e6,
      ],
      ["garbage", new Uint8Array([0x0a, 0xff]), "tauri://localhost", 1e6],
    ];
    for (const [name, wire, origin, now] of cases) {
      expect(
        () => decodeTicket(wire, status(), origin, now),
        name,
      ).toThrowError(/malformed/);
    }
  });

  it("checks the secret's shape without ever comparing its value", () => {
    expect(ticketShape(SECRET)).toBe(true);
    for (const bad of [
      "",
      "no-dot",
      `${"A".repeat(32)}.${"B".repeat(43)}`, // uppercase id
      `${"a".repeat(31)}.${"B".repeat(43)}`,
      `${"a".repeat(32)}.${"B".repeat(42)}`,
      `${"a".repeat(32)}.${"B".repeat(44)}`,
      `${"a".repeat(32)}.${"B".repeat(42)}+`,
      `${"a".repeat(32)}.${"B".repeat(43)}.extra`,
    ]) {
      expect(ticketShape(bad), bad).toBe(false);
    }
  });
});

describe("issuing a ticket", () => {
  it("refuses an origin no shell presents, and a Host with no listener", async () => {
    const browser = {
      ...config("/bin/true"),
      browserOrigin: "https://armadra.example",
    };
    expect(
      await reasonOf(issueNativeTicket(browser, status(), "本机桌面")),
    ).toBe("originUnsupported");
    expect(
      await reasonOf(
        issueNativeTicket(
          config("/bin/true"),
          status({ httpEndpoint: "" }),
          "本机桌面",
        ),
      ),
    ).toBe("hostUnavailable");
    expect(
      await reasonOf(issueNativeTicket(config("/bin/true"), null, "本机桌面")),
    ).toBe("hostUnavailable");
    expect(
      await reasonOf(issueNativeTicket(config("/bin/true"), status(), " ")),
    ).toBe("hostUnavailable");
    // A missing binary is a Host that cannot be reached, not a CLI failure.
    expect(
      await reasonOf(
        issueNativeTicket(
          config(join(tmpdir(), "missing-armadra-host")),
          status(),
          "本机桌面",
        ),
      ),
    ).toBe("hostUnavailable");
  });

  it("accepts a loopback HTTP page origin, which is what the Electron shell has", async () => {
    // The shell's static server binds a kernel-assigned port, so the check
    // cannot be a constant — it is the same rule the Host applies in
    // `native.go:loopbackHTTPOrigin` and the page in `host-client`.
    const shell = {
      ...config(join(tmpdir(), "missing-armadra-host")),
      browserOrigin: "http://127.0.0.1:54321",
    };
    // Past the origin gate (it would say originUnsupported otherwise) and
    // stopped only by the absent binary.
    expect(await reasonOf(issueNativeTicket(shell, status(), "本机桌面"))).toBe(
      "hostUnavailable",
    );
  });
});

describe.runIf(unix)("issuing a ticket against a real CLI", () => {
  it("returns the ticket, bounded, and never echoes stderr", async () => {
    const wire = ticketWire({ expiresAtUnixMs: 9_223_372_036_854_775_807n });
    const fixture = scriptFixture(
      `test "$1 $2 $3 $4 $5 $6 $7" = 'pair --output protobuf --origin tauri://localhost --device-name 本机桌面' || exit 9\n` +
        `printf '${escape(wire)}'`,
    );
    const ticket = await issueNativeTicket(
      config(fixture),
      status(),
      "本机桌面",
    );
    expect(ticket.hostInstanceId).toBe("instance-1");
    expect(ticket.ticket).toHaveLength(32 + 1 + 43);

    const cases: [string, NativeTicketReason][] = [
      ["printf 'private-credential' >&2; exit 7", "cliFailed"],
      ["exec head -c 65537 /dev/zero", "malformed"],
      ["printf 'not protobuf at all'", "malformed"],
    ];
    for (const [script, expected] of cases) {
      let message = "";
      const reason = await reasonOf(
        issueNativeTicket(
          config(scriptFixture(script)),
          status(),
          "本机桌面",
        ).catch((error: Error) => {
          message = error.message;
          throw error;
        }),
      );
      expect(reason, script).toBe(expected);
      expect(message).not.toContain("private");
    }
  });

  it("times out rather than waiting on a CLI that never answers", async () => {
    const slow = {
      ...config(scriptFixture("exec sleep 30")),
      cliTimeoutMs: 1_000,
    };
    expect(await reasonOf(issueNativeTicket(slow, status(), "本机桌面"))).toBe(
      "timeout",
    );
  });

  it("never lets the secret into an error message or a stringified failure", async () => {
    const error = new NativeTicketError("malformed");
    expect(`${error}`).not.toContain("B".repeat(8));
    expect(JSON.stringify({ reason: error.reason })).toBe(
      '{"reason":"malformed"}',
    );
  });
});
