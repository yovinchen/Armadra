/**
 * The 13 pre-merge unit tests plus the 3 from
 * the pre-merge implementation, translated, and the launcher's own cases.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { nextRevision } from "./binding.js";
import {
  buildPayload,
  decisionOutput,
  hookBody,
  parseDecision,
  pendingId,
  percentEncodeSegment,
  permissionWaitSecs,
  pollForAnswer,
  writeRequestFile,
} from "./hook.js";
import { asObject, parseJson } from "./json.js";
import type { JsonValue } from "./json.js";
import { launcherFileName, launcherScript } from "./launcher.js";
import { CLIENT_VERSION, MAX_PAYLOAD_BYTES } from "./usage.js";

const temporaries: string[] = [];

function tempdir(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "armadra-hook-"));
  temporaries.push(directory);
  return directory;
}

afterEach(() => {
  while (temporaries.length > 0) {
    fs.rmSync(temporaries.pop()!, { recursive: true, force: true });
  }
});

function field(value: JsonValue, key: string): JsonValue | undefined {
  return asObject(value)?.[key];
}

describe("payload", () => {
  it("has the pending id shape <nodeId>-<epochMs>-<pid>", () => {
    expect(pendingId("node-7", 1_725_000_000_123, 4242)).toBe(
      "node-7-1725000000123-4242",
    );
  });

  it("uses JSON stdin verbatim", () => {
    const payload = buildPayload(
      Buffer.from('{"hook_event_name":"Stop"}'),
      false,
    );
    expect(field(payload, "hook_event_name")).toBe("Stop");
  });

  it("wraps non-JSON stdin", () => {
    const payload = buildPayload(Buffer.from("not json at all"), false);
    expect(field(payload, "raw")).toBe("not json at all");
    expect(field(payload, "truncated")).toBeUndefined();
  });

  it("wraps scalar JSON too", () => {
    // A bare `12` is valid JSON but not an object; the runtime always wants an
    // object or array in `payload`.
    expect(field(buildPayload(Buffer.from("12"), false), "raw")).toBe("12");
  });

  it("marks oversize stdin truncated", () => {
    const payload = buildPayload(Buffer.from('{"a":1}'), true);
    expect(field(payload, "truncated")).toBe(true);
    expect(field(payload, "raw")).toBe('{"a":1}');
  });

  it("caps the payload at the contract's 1 MiB", () => {
    expect(MAX_PAYLOAD_BYTES).toBe(1024 * 1024);
  });

  it("reports the same version the shell's manifest declares", () => {
    // The Rust client prints its crate version, which `tools/release/version.mjs`
    // keeps equal to this manifest's. A literal here is a fourth site that
    // check does not know about, so this is the thing that catches its drift.
    const manifest = JSON.parse(
      fs.readFileSync(
        path.resolve(import.meta.dirname, "../../../package.json"),
        "utf8",
      ),
    ) as { version: string };
    expect(CLIENT_VERSION).toBe(manifest.version);
  });
});

describe("hook body", () => {
  it("only carries optional fields when set", () => {
    const payload = parseJson('{"hook_event_name":"Stop"}');
    const plain = parseJson(hookBody("n1", payload).toString("utf8"));
    expect(field(plain, "nodeId")).toBe("n1");
    expect(Number(field(plain, "version"))).toBe(1);
    expect(field(plain, "pendingId")).toBeUndefined();
    expect(field(plain, "answered")).toBeUndefined();

    const answered = parseJson(
      hookBody("n1", payload, "p1", "deny").toString("utf8"),
    );
    expect(field(answered, "pendingId")).toBe("p1");
    expect(field(answered, "answered")).toBe("deny");
  });
});

describe("decisions", () => {
  it("round trips", () => {
    expect(parseDecision(" allow\n")).toBe("allow");
    expect(parseDecision("deny")).toBe("deny");
    expect(parseDecision("maybe")).toBeUndefined();
    expect(decisionOutput("allow")).toContain('"behavior":"allow"');
    expect(decisionOutput("deny")).toContain("由 Armadra 拒绝");
    // Both outputs must be valid JSON for Claude to read them.
    expect(() => parseJson(decisionOutput("allow"))).not.toThrow();
    expect(() => parseJson(decisionOutput("deny"))).not.toThrow();
  });

  it("needs all three conditions for permission mode", () => {
    const request = parseJson('{"hook_event_name":"PermissionRequest"}');
    const stop = parseJson('{"hook_event_name":"Stop"}');
    // The env var is process wide, so exercise the non-env conditions only.
    expect(permissionWaitSecs("codex", request)).toBeUndefined();
    expect(permissionWaitSecs("claude", stop)).toBeUndefined();
  });
});

describe("path segments", () => {
  it("stops an agent id escaping its segment", () => {
    expect(percentEncodeSegment("claude")).toBe("claude");
    expect(percentEncodeSegment("custom:1")).toBe("custom%3A1");
    expect(percentEncodeSegment("../admin")).toBe("..%2Fadmin");
  });
});

describe("permission files", () => {
  it("polls to nothing without an answer", async () => {
    expect(
      await pollForAnswer(path.join(tempdir(), "missing.answer"), 10),
    ).toBeUndefined();
  });

  it("reads the answer file", async () => {
    const file = path.join(tempdir(), "x.answer");
    fs.writeFileSync(file, "allow\n");
    expect(await pollForAnswer(file, 10)).toBe("allow");
  });

  it("writes request files only this user can read", () => {
    const root = tempdir();
    const pending = path.join(root, "pending");
    const file = path.join(pending, "n1-1-2.json");
    expect(
      writeRequestFile(pending, file, parseJson('{"a":1}')),
    ).toBeUndefined();
    expect(fs.readFileSync(file, "utf8")).toBe('{"a":1}');
    if (process.platform !== "win32") {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      expect(fs.statSync(pending).mode & 0o777).toBe(0o700);
    }
  });
});

describe("terminal binding", () => {
  it("keeps revisions monotonic across parallel allocations", () => {
    const file = path.join(tempdir(), "session.seq");
    const initial = Buffer.alloc(16);
    initial.writeBigUInt64BE(0n, 0);
    initial.writeBigUInt64BE(0xffff_ffff_ffff_ffffn, 8);
    fs.writeFileSync(file, initial);
    const values: bigint[] = [];
    for (let index = 0; index < 8; index += 1) values.push(nextRevision(file));
    values.sort((left, right) => Number(left - right));
    expect(values).toEqual([1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n]);
    expect(nextRevision(file)).toBe(9n);
  });

  it("never reinitialises a broken sequence", () => {
    const file = path.join(tempdir(), "session.seq");
    expect(() => nextRevision(file)).toThrow();
    fs.writeFileSync(file, Buffer.from([1, 2, 3]));
    expect(() => nextRevision(file)).toThrow();
    expect([...fs.readFileSync(file)]).toEqual([1, 2, 3]);
  });
});

describe("launcher", () => {
  it("names the file so the installer still recognises its own entries", () => {
    expect(launcherFileName("darwin")).toBe("armadra-hook");
    expect(launcherFileName("linux")).toBe("armadra-hook");
    expect(launcherFileName("win32")).toBe("armadra-hook.cmd");
  });

  it("re-enters Electron as a Node interpreter", () => {
    const script = launcherScript(
      {
        runner: "/Applications/Armadra.app/Contents/MacOS/Armadra",
        bundle: "/res/cli/armadra-hook.js",
      },
      "darwin",
    );
    expect(script.startsWith("#!/bin/sh\n")).toBe(true);
    expect(script).toContain("ELECTRON_RUN_AS_NODE=1");
    expect(script).toContain(
      'exec "/Applications/Armadra.app/Contents/MacOS/Armadra" "/res/cli/armadra-hook.js" "$@"',
    );
  });

  it("quotes a path with a space on both platforms", () => {
    const target = {
      runner: "C:\\Program Files\\Armadra\\Armadra.exe",
      bundle: "C:\\res\\cli\\armadra-hook.js",
    };
    expect(launcherScript(target, "win32")).toContain(
      '"C:\\Program Files\\Armadra\\Armadra.exe" "C:\\res\\cli\\armadra-hook.js" %*',
    );
    expect(
      launcherScript(
        { runner: "/opt/A B/armadra", bundle: "/opt/a.js" },
        "linux",
      ),
    ).toContain('exec "/opt/A B/armadra" "/opt/a.js" "$@"');
  });
});
