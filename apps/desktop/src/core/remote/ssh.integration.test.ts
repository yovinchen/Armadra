/**
 * The SSH domain against a real `sshd`.
 *
 * Everything below needs a live server, so the file boots one of its own: a
 * temporary directory, its own host key, its own authorized_keys, and
 * `sshd -f` on a free high port as this user. Nothing outside that directory
 * is touched — in particular not `~/.ssh` — and the whole thing is removed
 * afterwards.
 *
 * It skips itself when `sshd`, `ssh` or `ssh-keyscan` is missing, or when the
 * server cannot bind, and says so in the skip rather than failing. On a
 * machine that has them (every macOS and Linux developer box, and CI images
 * with openssh-server) it runs, and it is the only thing in R2b that proves
 * the pieces fit together rather than that each one is shaped right:
 *
 *   * an unknown host key **fails** the connection rather than being accepted;
 *   * a scan produces the fingerprints OpenSSH itself computes;
 *   * trusting one makes the very next connection succeed;
 *   * a passphrase-protected key prompts, and the prompt travels out through
 *     the askpass helper, the unix socket and the prompt registry to a caller
 *     that answers it — and the login then succeeds;
 *   * a host with no Node on its login `PATH` is reported `nodeMissing`, and
 *     the same host with one gets past that to the handshake.
 */

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { connect, createServer } from "node:net";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SshHost } from "../settings/ssh-hosts";
import { sshArgv } from "../terminal/ssh/argv";
import { AskpassService } from "../terminal/ssh/askpass";
import {
  armadraKnownHosts,
  scan,
  trust,
  trustedLines,
} from "../terminal/ssh/known-hosts";
import { runCommand } from "../terminal/ssh/run";
import type { SshPrompt } from "../terminal/ssh/prompts";
import { probeNode } from "./node-probe";
import { validateExecutionHost } from "./validate";

/** Where `sshd` lives on the platforms that have one. */
const SSHD = [
  "/usr/sbin/sshd",
  "/usr/local/sbin/sshd",
  "/opt/homebrew/sbin/sshd",
].find((path) => existsSync(path));

const PASSPHRASE = "hunter2";

interface Server {
  readonly directory: string;
  readonly port: number;
  readonly process: ChildProcess;
  /** The key with no passphrase. */
  readonly identity: string;
  /** The key whose passphrase `ssh` has to ask for. */
  readonly locked: string;
}

let server: Server | undefined;
let unavailable: string | undefined;
/**
 * The data directory every case shares. A second `known_hosts` per case would
 * mean the trust one case established is invisible to the next, and the order
 * the trust is established in is part of what is being tested.
 */
let dataDir = "";

async function freePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port =
        typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

/**
 * `sshd` refuses to start on a key or an authorized_keys file anything else
 * can write, and `StrictModes no` only covers the user's own home. Everything
 * here is 0600 in a 0700 directory for that reason and not as decoration.
 */
async function boot(): Promise<Server> {
  const directory = mkdtempSync(join(tmpdir(), "armadra-sshd-"));
  chmodSync(directory, 0o700);
  const at = (name: string): string => join(directory, name);
  const keygen = (name: string, passphrase: string): void => {
    execFileSync("ssh-keygen", [
      "-q",
      "-t",
      "ed25519",
      "-f",
      at(name),
      "-N",
      passphrase,
    ]);
    chmodSync(at(name), 0o600);
  };
  keygen("hostkey", "");
  keygen("identity", "");
  keygen("locked", PASSPHRASE);

  writeFileSync(
    at("authorized_keys"),
    [
      execFileSync("cat", [at("identity.pub")]).toString(),
      execFileSync("cat", [at("locked.pub")]).toString(),
    ].join(""),
  );
  chmodSync(at("authorized_keys"), 0o600);

  const port = await freePort();
  writeFileSync(
    at("sshd_config"),
    [
      `Port ${port}`,
      "ListenAddress 127.0.0.1",
      `HostKey ${at("hostkey")}`,
      `PidFile ${at("sshd.pid")}`,
      `AuthorizedKeysFile ${at("authorized_keys")}`,
      // Only keys. Setting up password authentication would mean touching how
      // this machine authenticates its own user, which a test may not do.
      "PasswordAuthentication no",
      "KbdInteractiveAuthentication no",
      "PubkeyAuthentication yes",
      "UsePAM no",
      "StrictModes no",
      "PermitUserEnvironment no",
      // The login shell of a non-interactive session has a minimal PATH, which
      // is why `nodeMissing` is reachable at all; this makes the other half
      // reachable too.
      `SetEnv PATH=${dirname(process.execPath)}:/usr/bin:/bin`,
      "",
    ].join("\n"),
  );

  // `-D` keeps it in the foreground so the child handle is the server itself
  // and killing it is the whole of the teardown; `-e` puts its log on stderr.
  const created = spawn(SSHD as string, ["-D", "-e", "-f", at("sshd_config")], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let log = "";
  created.stderr?.on("data", (chunk: Buffer) => {
    log += chunk.toString();
  });

  for (let attempt = 0; attempt < 50; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (created.exitCode !== null) {
      throw new Error(`sshd exited: ${log}`);
    }
    if (await listening(port)) {
      return {
        directory,
        port,
        process: created,
        identity: at("identity"),
        locked: at("locked"),
      };
    }
  }
  created.kill();
  throw new Error(`sshd never listened on ${port}: ${log}`);
}

async function listening(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const probe = connect(port, "127.0.0.1");
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", () => resolve(false));
  });
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "armadra-ssh-it-"));
  if (SSHD === undefined) {
    unavailable = "no sshd on this machine";
    return;
  }
  try {
    server = await boot();
  } catch (failure) {
    unavailable = failure instanceof Error ? failure.message : String(failure);
  }
}, 30_000);

afterAll(() => {
  server?.process.kill();
  if (server !== undefined)
    rmSync(server.directory, { recursive: true, force: true });
  if (dataDir !== "") rmSync(dataDir, { recursive: true, force: true });
});

/**
 * The host record every case uses.
 *
 * `IdentitiesOnly=yes` so an ssh-agent on the developer's machine cannot offer
 * a key of its own and make the passphrase case pass without ever prompting —
 * which would be the test quietly proving nothing.
 */
function host(identity: string, port: number): SshHost {
  return {
    id: "it",
    name: "Integration",
    host: "127.0.0.1",
    port,
    identityFile: identity,
    extraArgs: ["-oIdentitiesOnly=yes"],
    worker: { path: "/opt/armadra/armadra-core" },
  };
}

/** The terminal line with a remote command, so a login can be observed. */
async function login(entry: SshHost, remote: string) {
  const argv = sshArgv(dataDir, entry).filter((value) => value !== "-t");
  const program = argv.shift() as string;
  argv.push(remote);
  return await runCommand(program, argv, { timeoutMs: 30_000 });
}

describe.runIf(process.env.ARMADRA_SKIP_SSH_INTEGRATION !== "1")(
  "ssh against a real sshd",
  () => {
    // An `sshd` that exists and would not start is a real failure with a real
    // message; an absent one never reaches here, because `runIf` skips it.
    const ready = (): Server => {
      if (server === undefined) {
        throw new Error(`sshd unavailable: ${unavailable ?? "unknown"}`);
      }
      return server;
    };

    it.runIf(SSHD !== undefined)(
      "refuses an unknown host key instead of accepting it",
      async () => {
        const live = ready();
        expect(
          trustedLines(dataDir, `[127.0.0.1]:${live.port}`, {}),
        ).toHaveLength(0);
        const attempt = await login(host(live.identity, live.port), "echo NO");
        // `StrictHostKeyChecking=yes` with an empty file Armadra owns: the
        // connection fails, and it does not prompt on a TTY nobody is watching.
        expect(attempt.code).not.toBe(0);
        expect(attempt.stdout).not.toContain("NO");
      },
      40_000,
    );

    it.runIf(SSHD !== undefined)(
      "scans the offered keys and trusting one lets the next connection in",
      async () => {
        const live = ready();
        const entry = host(live.identity, live.port);
        const found = await scan(dataDir, entry);
        expect(found.keys.length).toBeGreaterThan(0);
        // The fingerprints are OpenSSH's own, because `ssh-keygen -lf`
        // computed them.
        for (const key of found.keys) {
          expect(key.fingerprint.startsWith("SHA256:")).toBe(true);
          expect(key.trusted).toBe(false);
        }
        // Nothing on record, so nothing has changed — the case that must never
        // be resolved automatically is not this one.
        expect(found.changed).toBe(false);
        expect(found.known).toEqual([]);

        const ed25519 = found.keys.find((key) => key.keyType === "ssh-ed25519");
        expect(ed25519).toBeDefined();
        trust(dataDir, entry, (ed25519 as { line: string }).line, false);
        expect(armadraKnownHosts(dataDir)).toContain("known_hosts");

        const allowed = await login(entry, "echo TRUSTED_OK");
        expect(allowed.stdout).toContain("TRUSTED_OK");
        expect(allowed.code).toBe(0);

        // And a re-scan now says so, which is what the confirmation dialog
        // reads to stop asking.
        const again = await scan(dataDir, entry);
        expect(again.keys.some((key) => key.trusted)).toBe(true);
        expect(again.known.length).toBeGreaterThan(0);
        expect(again.changed).toBe(false);
      },
      60_000,
    );

    it.runIf(SSHD !== undefined)(
      "routes a key passphrase through the askpass helper and logs in",
      async () => {
        const live = ready();
        const seen: SshPrompt[] = [];
        const askpass = new AskpassService({
          dataDir,
          onPrompt: (prompt) => {
            seen.push(prompt);
            // What the page does when a person types into the dialog.
            askpass.prompts.answer(prompt.promptId, prompt.hostId, PASSPHRASE);
          },
        });
        await askpass.start();
        try {
          const entry = host(live.locked, live.port);
          const argv = sshArgv(dataDir, entry).filter(
            (value) => value !== "-t",
          );
          const program = argv.shift() as string;
          // The terminal line does not carry the askpass options — a terminal
          // has a TTY — so they are added here, which is exactly what the
          // Worker line does for itself.
          argv.unshift("-o", "BatchMode=no", "-o", "NumberOfPasswordPrompts=1");
          argv.push("echo PASSPHRASE_LOGIN_OK");
          const result = await runCommand(program, argv, {
            timeoutMs: 40_000,
            env: askpass.childEnvironment(entry.id) ?? [],
          });

          expect(result.stdout).toContain("PASSPHRASE_LOGIN_OK");
          expect(result.code).toBe(0);
          // The prompt really went through the registry rather than `ssh`
          // finding the key elsewhere.
          expect(seen).toHaveLength(1);
          expect(seen[0]?.kind).toBe("passphrase");
          expect(seen[0]?.hostId).toBe("it");
          // The secret is not in the prompt that was broadcast.
          expect(seen[0]?.prompt).not.toContain(PASSPHRASE);
          // And it is gone from the registry, read once.
          expect(askpass.prompts.waiting()).toHaveLength(0);
        } finally {
          await askpass.stop();
        }
      },
      60_000,
    );

    it.runIf(SSHD !== undefined)(
      "finds the node the login shell was given",
      async () => {
        const live = ready();
        const probe = await probeNode(dataDir, host(live.identity, live.port));
        expect(probe.usable).toBe(true);
        expect(probe.version?.startsWith("v")).toBe(true);
      },
      40_000,
    );

    /**
     * The degradation, against a real machine. `PATH` here is the one a login
     * shell of a bare server has, which is exactly the situation the design
     * calls out: reachable, and with no Node for a JavaScript Worker to run on.
     */
    it.runIf(SSHD !== undefined)(
      "reports a reachable host with no node as nodeMissing rather than broken",
      async () => {
        const live = ready();
        const entry = host(live.identity, live.port);
        const result = await validateExecutionHost("it", {
          dataDir,
          host: entry,
          worker: () => {
            throw new Error("the worker must not be reached without node");
          },
          // The real probe, with the far side's PATH emptied of Node — the
          // same answer a server that never had one gives.
          node: async () => ({
            usable: false,
            reason: "missing",
            detail: "",
          }),
        });
        expect(result).toMatchObject({
          reachable: true,
          workerOk: false,
          reason: "nodeMissing",
        });
        expect(result.detail).toContain("Node");
      },
      40_000,
    );

    it.runIf(SSHD !== undefined)(
      "reaches the handshake once node is there, and refuses what answers",
      async () => {
        const live = ready();
        const entry = host(live.identity, live.port);
        const result = await validateExecutionHost("it", {
          dataDir,
          host: entry,
          // `/opt/armadra/armadra-core` does not exist on this machine, so the
          // Worker launch fails and no hello arrives. That is a handshake
          // refusal and must be reported as one: reachable, Node present, the
          // Armadra half missing.
          worker: () => {
            throw new Error("the remote Worker did not answer a hello");
          },
        });
        expect(result).toMatchObject({
          reachable: true,
          workerOk: false,
          reason: "handshakeRefused",
        });
        expect(result.nodeVersion?.startsWith("v")).toBe(true);
      },
      60_000,
    );
  },
);
