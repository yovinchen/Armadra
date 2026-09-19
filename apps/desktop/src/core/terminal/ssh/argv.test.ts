/**
 * The Rust `argv.rs` test module, case for case.
 *
 * Seven of the eight are direct ports; the eighth covers the Node probe, which
 * has no Rust counterpart because the Rust Worker is a static binary.
 */

import { describe, expect, it } from "vitest";
import type { SshHost, SshWorker } from "../../settings/ssh-hosts";
import {
  languageLinkArgv,
  nodeProbeArgv,
  probeArgv,
  sshArgv,
  workerArgv,
} from "./argv";

const DATA = "/tmp/armadra-argv";

function host(): SshHost {
  return { id: "box", name: "Box", host: "example.com", user: "ada" };
}

function worker(): SshWorker {
  return { path: "/opt/armadra/armadra-core" };
}

/** `argv.windows(2).any(|pair| pair == [a, b])`. */
function hasPair(argv: readonly string[], a: string, b: string): boolean {
  return argv.some((value, index) => value === a && argv[index + 1] === b);
}

describe("the ssh command lines", () => {
  /**
   * The one assertion that matters for every line Armadra builds: `ssh` is
   * told to refuse an unknown key rather than prompt for it or accept it, and
   * to look for trust in the file Armadra owns.
   */
  it("pins strict host key checking on every command line", () => {
    for (const argv of [
      sshArgv(DATA, host()),
      probeArgv(DATA, host()),
      workerArgv(DATA, host(), worker()),
      nodeProbeArgv(DATA, host()),
    ]) {
      expect(hasPair(argv, "-o", "StrictHostKeyChecking=yes")).toBe(true);
      expect(
        argv.some((argument) => argument.startsWith("UserKnownHostsFile=")),
      ).toBe(true);
    }
  });

  it("gives a terminal session a tty and the worker none", () => {
    expect(sshArgv(DATA, host())).toContain("-t");
    expect(workerArgv(DATA, host(), worker())).not.toContain("-t");
    expect(probeArgv(DATA, host())).not.toContain("-t");
  });

  /**
   * The Worker connection has no TTY, so prompting has to reach the askpass
   * helper. `BatchMode=yes` here would make every password-authenticated host
   * unusable rather than merely awkward.
   */
  it("lets the worker prompt through the helper while the probe stays batch", () => {
    const argv = workerArgv(DATA, host(), worker());
    expect(hasPair(argv, "-o", "BatchMode=no")).toBe(true);
    expect(hasPair(argv, "-o", "NumberOfPasswordPrompts=1")).toBe(true);
    // A reachability check must not open a dialog: it answers whether the host
    // is there with what is already available.
    expect(hasPair(probeArgv(DATA, host()), "-o", "BatchMode=yes")).toBe(true);
  });

  it("keeps port, identity and extra arguments as separate elements", () => {
    const argv = sshArgv(DATA, {
      ...host(),
      port: 2222,
      identityFile: "/home/ada/.ssh/id_ed25519",
      extraArgs: ["-4"],
    });
    expect(hasPair(argv, "-p", "2222")).toBe(true);
    expect(hasPair(argv, "-i", "/home/ada/.ssh/id_ed25519")).toBe(true);
    expect(argv).toContain("-4");
    expect(argv.at(-1)).toBe("ada@example.com");
  });

  it("strips the brackets of an ipv6 literal in the destination", () => {
    const argv = sshArgv(DATA, {
      id: "v6",
      name: "V6",
      host: "[fe80::1]",
    });
    expect(argv.at(-1)).toBe("fe80::1");
  });

  it("ends the worker command in the remote program and its mode", () => {
    const argv = workerArgv(
      DATA,
      { ...host(), port: 2222 },
      { path: "/opt/armadra/armadra-core", stateDir: "/var/lib/armadra/worker" },
    );
    expect(argv.slice(-8)).toEqual([
      "-p",
      "2222",
      "ada@example.com",
      "/opt/armadra/armadra-core",
      "worker",
      "--stdio",
      "--state-dir",
      "/var/lib/armadra/worker",
    ]);
  });

  it("makes the state directory two arguments and only when configured", () => {
    expect(workerArgv(DATA, host(), worker()).at(-1)).toBe("--stdio");
    const argv = workerArgv(DATA, host(), {
      path: "/opt/armadra/armadra-core",
      stateDir: "/var/lib/armadra/worker",
    });
    expect(argv.slice(-2)).toEqual(["--state-dir", "/var/lib/armadra/worker"]);
  });

  /**
   * The language link is the Worker line plus one flag, and nothing else. A
   * link that still said `BatchMode=yes` would leave a password-authenticated
   * host able to run a Worker but never a language server.
   */
  it("makes the language link the worker line plus one flag", () => {
    const configured: SshWorker = {
      path: "/opt/armadra/armadra-core",
      stateDir: "/var/lib/armadra/worker",
    };
    const base = workerArgv(DATA, host(), configured);
    const link = languageLinkArgv(DATA, host(), configured);
    expect(link.filter((argument) => argument !== "--language-link")).toEqual(
      base,
    );
    // Directly after `--stdio`, so the state directory still trails the line
    // the way `workerArgv` promises.
    expect(link[link.indexOf("--stdio") + 1]).toBe("--language-link");
    expect(link.slice(-2)).toEqual(["--state-dir", "/var/lib/armadra/worker"]);
  });

  it("ends the probe in true", () => {
    const argv = probeArgv(DATA, host());
    expect(hasPair(argv, "-o", "ConnectTimeout=5")).toBe(true);
    expect(argv.at(-1)).toBe("true");
  });

  /**
   * The Node probe is the reachability line with a different remote word, so
   * it inherits `BatchMode=yes`: asking whether a machine has Node must not
   * open a password dialog.
   */
  it("asks for the node version on the batch line", () => {
    const argv = nodeProbeArgv(DATA, host());
    expect(hasPair(argv, "-o", "BatchMode=yes")).toBe(true);
    expect(argv.at(-1)).toContain("node --version");
    expect(argv).not.toContain("true");
    // Everything before the remote word is the reachability line, unchanged.
    expect(argv.slice(0, -1)).toEqual(probeArgv(DATA, host()).slice(0, -1));
  });

  /**
   * The user's file is read so a host they already trust is not asked about
   * twice — Armadra's own file first, because that is the one it writes.
   */
  it("names both known_hosts files when the user has one", () => {
    const argv = sshArgv(DATA, host());
    const option = argv.find((value) =>
      value.startsWith("UserKnownHostsFile="),
    );
    const files = (option ?? "").slice("UserKnownHostsFile=".length).split(" ");
    expect(files[0]).toBe(`${DATA}/ssh/known_hosts`);
    expect(files).toHaveLength(process.env.HOME === undefined ? 1 : 2);
    if (process.env.HOME !== undefined) {
      expect(files[1]).toBe(`${process.env.HOME}/.ssh/known_hosts`);
    }
  });
});
