/**
 * The Rust `known_hosts/tests.rs` module, case for case, plus the read/write
 * cases that file cannot have because its trust file is a process global.
 */

import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SshHost } from "../../settings/ssh-hosts";
import {
  ScanFailed,
  acceptedOverride,
  armadraKnownHosts,
  entryHost,
  forget,
  identificationChanged,
  options,
  trust,
  trustedLines,
} from "./known-hosts";

const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleExampleExampleExample";

function host(): SshHost {
  return { id: "box", name: "Box", host: "example.com", user: "ada" };
}

let directories: string[] = [];

function dataDir(): string {
  const path = mkdtempSync(join(tmpdir(), "armadra-known-hosts-"));
  directories.push(path);
  return path;
}

afterEach(() => {
  directories = [];
});

describe("the ssh options", () => {
  /**
   * The options are the whole mechanism: without them `ssh` consults its own
   * files and decides for itself, which is exactly what this module exists to
   * prevent.
   */
  it("pins strict checking and names Armadra's own file", () => {
    const data = dataDir();
    const given = options(data, {});
    expect(
      given.some(
        (value, index) =>
          value === "-o" && given[index + 1] === "StrictHostKeyChecking=yes",
      ),
    ).toBe(true);
    const files = given.find((value) =>
      value.startsWith("UserKnownHostsFile="),
    );
    expect(files).toBe(`UserKnownHostsFile=${data}/ssh/known_hosts`);
  });

  /** A user with no HOME gets one file, not a path ending in `undefined`. */
  it("names only Armadra's file when the user has no home", () => {
    const given = options(dataDir(), { HOME: "" });
    const files = given.find((value) =>
      value.startsWith("UserKnownHostsFile="),
    );
    expect(files).not.toContain(" ");
  });
});

describe("the entry name", () => {
  /**
   * A non-default port is part of the identity of a host key. Writing the
   * entry without it would trust the same key on port 22, which is a different
   * server.
   */
  it("carries a non-default port", () => {
    expect(entryHost(host())).toBe("example.com");
    expect(entryHost({ ...host(), port: 22 })).toBe("example.com");
    expect(entryHost({ ...host(), port: 2222 })).toBe("[example.com]:2222");
    expect(entryHost({ ...host(), host: "[fe80::1]", port: 2222 })).toBe(
      "[fe80::1]:2222",
    );
  });
});

describe("trusting a key", () => {
  /**
   * A client that echoed back a line for some other host must not be able to
   * append trust for it: the confirmation the person gave was about this host.
   */
  it("refuses a line that names a different host", () => {
    const data = dataDir();
    expect(() =>
      trust(data, host(), `other.example.com ${KEY}`, false),
    ).toThrow(ScanFailed);
    // And two lines at once, which would smuggle a second entry past one
    // confirmation.
    expect(() =>
      trust(
        data,
        host(),
        `example.com ${KEY}\nevil.example.com ssh-rsa AAAA`,
        false,
      ),
    ).toThrow(ScanFailed);
  });

  it("writes the line at 0600 and reads it back", () => {
    const data = dataDir();
    trust(data, host(), `example.com ${KEY}`, false);
    const path = armadraKnownHosts(data);
    expect(readFileSync(path, "utf8")).toBe(`example.com ${KEY}\n`);
    if (process.platform !== "win32") {
      // eslint-disable-next-line no-bitwise -- reading the mode is the point
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
    expect(trustedLines(data, "example.com", {})).toEqual([
      `example.com ${KEY}`,
    ]);
  });

  /** Trusting the same line twice must not append it twice. */
  it("is idempotent for an identical line", () => {
    const data = dataDir();
    trust(data, host(), `example.com ${KEY}`, false);
    trust(data, host(), `example.com ${KEY}`, false);
    expect(trustedLines(data, "example.com", {})).toHaveLength(1);
  });

  /**
   * A first trust must not remove what is already there, and a replace must.
   * That difference is the whole reason `replace` is a parameter rather than
   * inferred from a key having changed.
   */
  it("keeps the old entry unless replace was asked for", () => {
    const data = dataDir();
    trust(data, host(), `example.com ssh-rsa AAAAold`, false);
    trust(data, host(), `example.com ${KEY}`, false);
    expect(trustedLines(data, "example.com", {})).toHaveLength(2);

    trust(data, host(), `example.com ssh-rsa AAAAnewest`, true);
    expect(trustedLines(data, "example.com", {})).toEqual([
      "example.com ssh-rsa AAAAnewest",
    ]);
  });

  /** Another host's entries are not touched by either write. */
  it("leaves other hosts alone", () => {
    const data = dataDir();
    trust(data, host(), `example.com ${KEY}`, false);
    trust(
      data,
      { ...host(), id: "other", host: "other.example.com" },
      `other.example.com ${KEY}`,
      false,
    );
    forget(data, host());
    expect(trustedLines(data, "example.com", {})).toHaveLength(0);
    expect(trustedLines(data, "other.example.com", {})).toHaveLength(1);
  });

  it("forgetting a host with no file is not an error", () => {
    expect(() => forget(dataDir(), host())).not.toThrow();
  });

  /**
   * A hashed entry (`|1|…`) cannot be matched by name. It is left alone rather
   * than guessed at, which at worst asks for one extra confirmation.
   */
  it("does not match a hashed entry by name", () => {
    const data = dataDir();
    mkdirSync(join(data, "ssh"), { recursive: true });
    writeFileSync(
      armadraKnownHosts(data),
      `|1|abc=|def= ${KEY}\n# a comment\n\nexample.com ${KEY}\n`,
    );
    expect(trustedLines(data, "example.com", {})).toEqual([
      `example.com ${KEY}`,
    ]);
  });

  /** A comma-separated pattern list is how OpenSSH writes aliases. */
  it("matches one name out of a comma-separated pattern list", () => {
    const data = dataDir();
    mkdirSync(join(data, "ssh"), { recursive: true });
    writeFileSync(armadraKnownHosts(data), `example.com,10.0.0.7 ${KEY}\n`);
    expect(trustedLines(data, "10.0.0.7", {})).toHaveLength(1);
    expect(trustedLines(data, "example.co", {})).toHaveLength(0);
  });
});

describe("ssh diagnostics", () => {
  /**
   * OpenSSH's own wording for a changed key. Recognising it is what turns an
   * unreadable failure into the replace-or-refuse decision a person has to
   * make.
   */
  it("recognises a changed identification", () => {
    expect(
      identificationChanged(
        "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\n" +
          "@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\n",
      ),
    ).toBe(true);
    expect(
      identificationChanged("ada@example.com: Permission denied (publickey)."),
    ).toBe(false);
  });
});

describe("the keyscan override", () => {
  /**
   * Only an absolute path with no whitespace replaces the program: a bare name
   * would resolve through `PATH`, and an argument smuggled through a space
   * would become part of the command line.
   */
  it("is ignored unless it is an absolute program", () => {
    expect(acceptedOverride(undefined)).toBeUndefined();
    expect(acceptedOverride("ssh-keyscan")).toBeUndefined();
    expect(acceptedOverride("/usr/bin/env ssh-keyscan")).toBeUndefined();
    expect(acceptedOverride("/usr/bin/ssh-keyscan")).toBe(
      "/usr/bin/ssh-keyscan",
    );
  });
});
