/**
 * The remote domain's unit cases: the Node probe, the handshake, the
 * supervisor's backoff, the frame codec, the validation's four answers, and
 * the switch's fingerprint and refusal logic.
 *
 * Every Rust test module this file ports is named above the `describe` that
 * carries its cases.
 */

import { describe, expect, it } from "vitest";
import { FrameDecoder, MAX_FRAME, encodeFrame } from "./frames";
import {
  CONTRACT_VERSION,
  HandshakeRefused,
  PROTOCOL_MAJOR,
  REMOTE_CAPABILITY,
  accept,
  missingCapability,
  parseHello,
  type WorkerHello,
} from "./handshake";
import {
  MINIMUM_NODE_MAJOR,
  parseNodeVersion,
  readNodeProbe,
  unsupportedMessage,
} from "./node-probe";
import {
  COOLDOWN_MS,
  MAX_CONNECT_ATTEMPTS,
  RECONNECT_BACKOFF_MS,
  Supervisor,
} from "./supervisor";
import {
  SwitchError,
  decide,
  digest,
  fingerprintOf,
  matches,
  validateRequest,
  type RootFingerprint,
} from "./switch";
import { validateExecutionHost, ValidationRefused } from "./validate";
import type { SshHost } from "../settings/ssh-hosts";

const VERSION = "0.1.0";

function host(worker = true): SshHost {
  return {
    id: "box",
    name: "Box",
    host: "example.com",
    user: "ada",
    ...(worker ? { worker: { path: "/opt/armadra/armadra-core" } } : {}),
  };
}

/* ------------------------------- node probe -------------------------------- */

describe("the node probe", () => {
  it("reads the major out of a version banner", () => {
    expect(parseNodeVersion("v22.11.0\n")).toBe(22);
    expect(parseNodeVersion("v26.5.1")).toBe(26);
    expect(parseNodeVersion("")).toBeUndefined();
    expect(parseNodeVersion("bash: node: command not found")).toBeUndefined();
    expect(parseNodeVersion("22.11.0")).toBeUndefined();
  });

  /**
   * The whole point of the degradation: a reachable host with no Node is
   * `missing`, not a handshake failure, so the person is told what to install.
   */
  it("calls a host with no node missing rather than broken", () => {
    const probe = readNodeProbe(1, "", "sh: node: command not found");
    expect(probe.usable).toBe(false);
    expect(probe.reason).toBe("missing");
    expect(unsupportedMessage(host(), probe)).toContain(
      String(MINIMUM_NODE_MAJOR),
    );
  });

  /** A zero exit with no banner is still a host without Node. */
  it("treats a silent success as missing", () => {
    expect(readNodeProbe(0, "\n", "").reason).toBe("missing");
  });

  it("separates a node that is too old from one that is absent", () => {
    const probe = readNodeProbe(0, "v18.20.4\n", "");
    expect(probe.usable).toBe(false);
    expect(probe.reason).toBe("tooOld");
    expect(probe.version).toBe("v18.20.4");
    expect(unsupportedMessage(host(), probe)).toContain("v18.20.4");
  });

  it("accepts a node at or above the floor", () => {
    const probe = readNodeProbe(0, `v${MINIMUM_NODE_MAJOR}.0.0\n`, "");
    expect(probe.usable).toBe(true);
    expect(probe.major).toBe(MINIMUM_NODE_MAJOR);
    expect(probe.detail).toBe("");
  });

  /** A killed probe never ran, and must not be reported as "no node". */
  it("calls a probe that never exited unreachable", () => {
    expect(readNodeProbe(undefined, "", "").reason).toBe("unreachable");
  });

  /** A server's diagnostics can quote anything, so they are redacted. */
  it("redacts what the far side printed", () => {
    const probe = readNodeProbe(1, "", "password=hunter2 not found");
    expect(probe.detail).not.toContain("hunter2");
  });
});

/* -------------------------------- handshake -------------------------------- */

/** Ports the pre-merge implementation's test module. */
describe("the handshake", () => {
  function hello(): WorkerHello {
    return {
      protocol: { major: PROTOCOL_MAJOR, minor: 0 },
      instanceId: "abcdef0123456789abcdef0123456789",
      runtimeVersion: VERSION,
      serviceContractVersion: CONTRACT_VERSION,
      capabilities: [REMOTE_CAPABILITY],
      platform: "linux",
      architecture: "arm64",
    };
  }

  /**
   * The point of the contract version: two patch releases that agree about the
   * payloads may talk, and the difference becomes a badge.
   */
  it("accepts a different patch release with the same contract, with a badge", () => {
    const accepted = accept("Box", VERSION, {
      ...hello(),
      runtimeVersion: "99.99.99",
    });
    expect(accepted.versionBadge).toBe("99.99.99");
  });

  it("shows no badge for a matching build", () => {
    expect(accept("Box", VERSION, hello()).versionBadge).toBeUndefined();
  });

  /**
   * Nothing negotiates the JSON payloads, so a contract mismatch is not a
   * degraded mode; it is a refusal.
   */
  it("refuses a different service contract", () => {
    expect(() =>
      accept("Box", VERSION, {
        ...hello(),
        serviceContractVersion: CONTRACT_VERSION + 1,
      }),
    ).toThrow(HandshakeRefused);
  });

  /**
   * A Worker from before the field must not become *more* permissive by
   * reporting zero: it keeps the exact-version rule it was built under.
   */
  it("still needs an identical build from a worker that predates the contract", () => {
    const old = { ...hello(), serviceContractVersion: 0 };
    expect(accept("Box", VERSION, old).instanceId).toBe(old.instanceId);
    expect(() =>
      accept("Box", VERSION, { ...old, runtimeVersion: "0.0.1" }),
    ).toThrow(HandshakeRefused);
  });

  it("refuses a worker without remote execution whatever its version", () => {
    expect(() =>
      accept("Box", VERSION, { ...hello(), capabilities: [] }),
    ).toThrow(HandshakeRefused);
  });

  it("refuses a foreign protocol major before anything else is read", () => {
    expect(() =>
      accept("Box", VERSION, {
        ...hello(),
        protocol: { major: PROTOCOL_MAJOR + 1, minor: 0 },
      }),
    ).toThrow(HandshakeRefused);
    expect(() =>
      accept("Box", VERSION, { ...hello(), protocol: undefined }),
    ).toThrow(HandshakeRefused);
  });

  /**
   * The Rust Runtime's Worker speaks protocol major 1 and Protobuf payloads.
   * A controller of this build must not mistake it for a peer.
   */
  it("refuses the rust runtime's own protocol major", () => {
    expect(() =>
      accept("Box", VERSION, { ...hello(), protocol: { major: 1, minor: 0 } }),
    ).toThrow(HandshakeRefused);
  });

  it("names the capability a missing group needs", () => {
    expect(missingCapability("Box", "git.v1")).toContain("git.v1");
  });

  it("reads a hello off the wire, or says it is not one", () => {
    expect(parseHello(hello())?.instanceId).toBe(hello().instanceId);
    expect(parseHello(null)).toBeUndefined();
    expect(parseHello({ instanceId: "x" })).toBeUndefined();
    // Absent capabilities are none, not a parse failure.
    expect(
      parseHello({
        instanceId: "x",
        runtimeVersion: "1",
        serviceContractVersion: 1,
      })?.capabilities,
    ).toEqual([]);
  });
});

/* ------------------------------- supervisor -------------------------------- */

/** Ports the pre-merge implementation's test module. */
describe("the reconnect policy", () => {
  class Fake {
    closed = false;
    close(): void {
      this.closed = true;
    }
  }

  /**
   * The budget is what stops an unreachable host from becoming an `ssh` storm,
   * so it has to park after exactly as many failures as it claims.
   */
  it("parks the host after the attempt budget and a probe releases it", () => {
    const supervisor = new Supervisor<Fake>();
    expect(supervisor.parked()).toBe(false);
    expect(supervisor.backoffMs()).toBeUndefined();
    for (let attempt = 0; attempt < MAX_CONNECT_ATTEMPTS; attempt += 1) {
      supervisor.failed();
    }
    expect(supervisor.parked()).toBe(true);
    supervisor.resume();
    expect(supervisor.parked()).toBe(false);
    expect(supervisor.backoffMs()).toBeUndefined();
  });

  it("waits longer after each failure, up to the budget", () => {
    const supervisor = new Supervisor<Fake>();
    const waits: (number | undefined)[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      supervisor.failed();
      waits.push(supervisor.backoffMs());
    }
    expect(waits.slice(0, 3)).toEqual([...RECONNECT_BACKOFF_MS]);
    // Past the budget the wait stops growing rather than running off the table.
    expect(waits[3]).toBe(RECONNECT_BACKOFF_MS[2]);
    expect(waits[4]).toBe(RECONNECT_BACKOFF_MS[2]);
  });

  /**
   * The first retry waits the table's *first* entry. Indexing by the failure
   * count itself would skip 250 ms and make the cheapest case — one dropped
   * session, immediately reconnectable — wait a full second.
   */
  it("makes the first retry the cheapest one", () => {
    const supervisor = new Supervisor<Fake>();
    supervisor.failed();
    expect(supervisor.backoffMs()).toBe(250);
  });

  it("lets the park expire on its own", () => {
    let now = 0;
    const supervisor = new Supervisor<Fake>(() => now);
    for (let attempt = 0; attempt < MAX_CONNECT_ATTEMPTS; attempt += 1) {
      supervisor.failed();
    }
    expect(supervisor.parked()).toBe(true);
    now += COOLDOWN_MS;
    expect(supervisor.parked()).toBe(false);
    expect(supervisor.failures).toBe(0);
  });

  it("drops the live connection when a user asks directly", () => {
    const supervisor = new Supervisor<Fake>();
    const connection = new Fake();
    supervisor.succeeded(connection, "9.9.9");
    supervisor.resume();
    expect(connection.closed).toBe(true);
    expect(supervisor.connection).toBeUndefined();
  });
});

/* --------------------------------- frames ---------------------------------- */

describe("the frame codec", () => {
  it("round-trips a frame split across arbitrary chunk boundaries", () => {
    const frame = encodeFrame({ requestId: "a", instanceId: "i" });
    for (const at of [1, 2, 3, 4, 5, frame.byteLength - 1]) {
      const decoder = new FrameDecoder();
      expect(decoder.push(frame.subarray(0, at))).toEqual([]);
      expect(decoder.push(frame.subarray(at))).toEqual([
        { requestId: "a", instanceId: "i" },
      ]);
    }
  });

  it("returns two frames that arrived in one chunk", () => {
    const decoder = new FrameDecoder();
    const chunk = Buffer.concat([encodeFrame({ a: 1 }), encodeFrame({ b: 2 })]);
    expect(decoder.push(chunk)).toEqual([{ a: 1 }, { b: 2 }]);
  });

  /**
   * A length that cannot be right means the stream cannot be resynchronised.
   * Skipping ahead to whatever looks like a prefix next would be reading
   * somebody else's bytes as frames.
   */
  it("gives up rather than resynchronising on an impossible length", () => {
    for (const length of [0, MAX_FRAME + 1]) {
      const decoder = new FrameDecoder();
      const prefix = Buffer.allocUnsafe(4);
      prefix.writeUInt32BE(length, 0);
      decoder.push(prefix);
      expect(decoder.broken).toBe(true);
    }
  });

  it("gives up on a frame that is the right length and not json", () => {
    const decoder = new FrameDecoder();
    const prefix = Buffer.allocUnsafe(4);
    prefix.writeUInt32BE(3, 0);
    decoder.push(Buffer.concat([prefix, Buffer.from("{{{")]));
    expect(decoder.broken).toBe(true);
  });
});

/* -------------------------------- validation ------------------------------- */

describe("validating an execution host", () => {
  const base = {
    dataDir: "/tmp/armadra-validate",
    worker: () => {
      throw new Error("the worker must not be reached");
    },
  };

  it("refuses an id that names no configured host", async () => {
    await expect(
      validateExecutionHost("gone", { ...base, host: undefined }),
    ).rejects.toThrow(ValidationRefused);
  });

  /** Unreachable is answered without ever asking about Node or the Worker. */
  it("reports unreachable and stops there", async () => {
    const result = await validateExecutionHost("box", {
      ...base,
      host: host(),
      probe: async () => ({ ok: false, output: "Connection refused" }),
      node: async () => {
        throw new Error("node must not be probed for an unreachable host");
      },
    });
    expect(result).toMatchObject({
      reachable: false,
      workerOk: false,
      reason: "unreachable",
      detail: "Connection refused",
    });
  });

  /**
   * Reachable and usable for terminals, but no workspace can execute on it.
   * Saying so is the whole point of a separate flag.
   */
  it("separates a reachable host with no worker configured", async () => {
    const result = await validateExecutionHost("box", {
      ...base,
      host: host(false),
      probe: async () => ({ ok: true, output: "" }),
    });
    expect(result).toMatchObject({
      reachable: true,
      workerOk: false,
      reason: "noWorkerConfigured",
    });
  });

  /**
   * The capability degradation, reported as its own thing. Calling this
   * `handshakeRefused` would send the person looking for an Armadra install
   * that was never the problem.
   */
  it("separates a reachable host with no node from a refused handshake", async () => {
    const result = await validateExecutionHost("box", {
      ...base,
      host: host(),
      probe: async () => ({ ok: true, output: "" }),
      node: async () => readNodeProbe(1, "", "sh: node: command not found"),
    });
    expect(result).toMatchObject({
      reachable: true,
      workerOk: false,
      reason: "nodeMissing",
    });
    expect(result.detail).toContain(String(MINIMUM_NODE_MAJOR));
  });

  it("reports a refused handshake with the reason redacted", async () => {
    const result = await validateExecutionHost("box", {
      ...base,
      host: host(),
      probe: async () => ({ ok: true, output: "" }),
      node: async () => readNodeProbe(0, "v24.0.0\n", ""),
      worker: () =>
        ({
          probe: async () => {
            throw new HandshakeRefused("token=abc contract mismatch");
          },
        }) as never,
    });
    expect(result).toMatchObject({
      reachable: true,
      workerOk: false,
      reason: "handshakeRefused",
      nodeVersion: "v24.0.0",
    });
    expect(result.detail).not.toContain("abc");
  });

  it("reports the platform, architecture and capabilities on success", async () => {
    const result = await validateExecutionHost("box", {
      ...base,
      host: host(),
      probe: async () => ({ ok: true, output: "" }),
      node: async () => readNodeProbe(0, "v24.0.0\n", ""),
      worker: () =>
        ({
          probe: async () => ({
            instanceId: "i",
            capabilities: new Set([REMOTE_CAPABILITY]),
            platform: "linux",
            architecture: "arm64",
            runtimeVersion: VERSION,
          }),
        }) as never,
    });
    expect(result).toMatchObject({
      reachable: true,
      workerOk: true,
      platform: "linux",
      architecture: "arm64",
      runtimeVersion: VERSION,
      capabilities: [REMOTE_CAPABILITY],
    });
    expect(result.reason).toBeUndefined();
  });
});

/* ---------------------------------- switch --------------------------------- */

/** Ports the pre-merge implementation's test module. */
describe("the execution host switch", () => {
  function print(head: string, entries: string): RootFingerprint {
    return { head, entries, entryCount: 1 };
  }

  /**
   * Two checkouts of the same commit with the same top level are the same
   * project; either half differing is enough to refuse.
   */
  it("matches only when both the commit and the listing agree", () => {
    expect(matches(print("abc", "d1"), print("abc", "d1"))).toBe(true);
    expect(matches(print("abc", "d1"), print("abd", "d1"))).toBe(false);
    expect(matches(print("abc", "d1"), print("abc", "d2"))).toBe(false);
  });

  /**
   * A directory that is not a repository has no commit, and two unrelated
   * empty directories must not therefore look identical — the listing is what
   * separates them.
   */
  it("compares directories that are not repositories by their contents", () => {
    const one = fingerprintOf("", [{ name: "a", kind: "file" }]);
    const other = fingerprintOf("", [{ name: "b", kind: "file" }]);
    expect(matches(one, other)).toBe(false);
    expect(matches(one, { ...one })).toBe(true);
  });

  /** Order must not matter: two hosts can list a directory differently. */
  it("does not depend on the order entries arrived in", () => {
    expect(
      fingerprintOf("", [
        { name: "b", kind: "file" },
        { name: "a", kind: "directory" },
      ]).entries,
    ).toBe(
      fingerprintOf("", [
        { name: "a", kind: "directory" },
        { name: "b", kind: "file" },
      ]).entries,
    );
  });

  /** Separators matter: `ab` + `c` must not digest the same as `a` + `bc`. */
  it("keeps entry names from running into each other in the digest", () => {
    expect(digest(["ab", "c"])).not.toBe(digest(["a", "bc"]));
  });

  /** A file and a directory of the same name are not the same entry. */
  it("digests the kind as well as the name", () => {
    expect(fingerprintOf("", [{ name: "a", kind: "file" }]).entries).not.toBe(
      fingerprintOf("", [{ name: "a", kind: "directory" }]).entries,
    );
  });

  /**
   * Copying a project between machines behind a settings toggle would be a
   * data operation disguised as a preference.
   */
  it("refuses to migrate the files", () => {
    expect(() =>
      validateRequest(
        { executionHostId: "box", rootPath: "/srv/p", migrateFiles: true },
        true,
      ),
    ).toThrow(SwitchError);
  });

  it("requires an absolute root on the other machine", () => {
    for (const rootPath of ["relative/path", "", "/".padEnd(5_000, "x")]) {
      expect(() =>
        validateRequest({ executionHostId: "box", rootPath }, true),
      ).toThrow(SwitchError);
    }
  });

  it("requires the write grant before it will force", () => {
    const request = {
      executionHostId: "box",
      rootPath: "/srv/p",
      force: true,
    };
    expect(() => validateRequest(request, false)).toThrow(SwitchError);
    expect(() => validateRequest(request, true)).not.toThrow();
  });

  /**
   * Anything that survived being stopped still refuses the switch, so
   * `stopBlockers` can never turn into "switch anyway".
   */
  it("refuses while anything is still bound, and says what it already stopped", () => {
    const refusal = decide({
      remaining: [{ kind: "editorDraft", detail: "/srv/p/a.ts" }],
      stopped: [{ kind: "terminal", detail: "node-1" }],
      from: undefined,
      to: undefined,
      force: false,
    });
    expect(refusal?.code).toBe("switch_blocked");
    expect(refusal?.blockers).toHaveLength(1);
    expect(refusal?.stopped).toEqual([{ kind: "terminal", detail: "node-1" }]);
  });

  it("refuses a root that is not the same project, and shows both prints", () => {
    const refusal = decide({
      remaining: [],
      stopped: [],
      from: print("abc", "d1"),
      to: print("abd", "d2"),
      force: false,
    });
    expect(refusal?.code).toBe("root_mismatch");
    expect(refusal?.from?.head).toBe("abc");
    expect(refusal?.to?.head).toBe("abd");
  });

  it("lets force past a mismatch but never past a blocker", () => {
    expect(
      decide({
        remaining: [],
        stopped: [],
        from: print("abc", "d1"),
        to: print("abd", "d2"),
        force: true,
      }),
    ).toBeUndefined();
    expect(
      decide({
        remaining: [{ kind: "gitOperation", detail: "op-1" }],
        stopped: [],
        from: print("abc", "d1"),
        to: print("abc", "d1"),
        force: true,
      })?.code,
    ).toBe("switch_blocked");
  });

  it("allows a switch when nothing is bound and the roots agree", () => {
    expect(
      decide({
        remaining: [],
        stopped: [],
        from: print("abc", "d1"),
        to: print("abc", "d1"),
        force: false,
      }),
    ).toBeUndefined();
  });
});
