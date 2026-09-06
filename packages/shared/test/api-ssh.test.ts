import { describe, expect, it } from "vitest";
import {
  executionHostRefusalSchema,
  openRemoteWorkspaceRequestSchema,
  sshHostKeyScanSchema,
  sshHostSchema,
  sshPromptListSchema,
  switchExecutionHostRequestSchema,
  trustSshHostKeyRequestSchema,
} from "../src/index.js";

describe("runtime SSH and execution host API", () => {
  it("keeps an SSH execution host's remote paths out of the login shell's hands", () => {
    const base = { id: "box", name: "Box", host: "example.invalid" };
    // No `worker` at all is a host that runs terminals and nothing else.
    expect(sshHostSchema.parse(base).worker).toBeUndefined();
    expect(
      sshHostSchema.parse({
        ...base,
        worker: { path: "/opt/armadra/armadra-runtime" },
      }).worker?.path,
    ).toBe("/opt/armadra/armadra-runtime");
    // `ssh` joins the remote command with spaces and the login shell splits it
    // again, so any of these would arrive as several arguments, not one path.
    for (const path of [
      "relative/armadra",
      "/opt/armadra runtime",
      "/opt/$(id)",
      "/opt/a;rm",
    ]) {
      expect(
        sshHostSchema.safeParse({ ...base, worker: { path } }).success,
      ).toBe(false);
    }
    expect(
      sshHostSchema.safeParse({
        ...base,
        worker: { path: "/opt/armadra", stateDir: "../state" },
      }).success,
    ).toBe(false);
  });

  it("requires a remote workspace to name a host and an absolute remote path", () => {
    expect(
      openRemoteWorkspaceRequestSchema.parse({
        name: "Remote project",
        executionHostId: "box",
        rootPath: "/srv/project",
      }).rootPath,
    ).toBe("/srv/project");
    for (const request of [
      { name: "x", executionHostId: "", rootPath: "/srv/project" },
      { name: "x", executionHostId: "box", rootPath: "srv/project" },
      { name: "", executionHostId: "box", rootPath: "/srv/project" },
    ]) {
      expect(openRemoteWorkspaceRequestSchema.safeParse(request).success).toBe(
        false,
      );
    }
  });

  it("keeps a host key scan comparable and never trusts one by default", () => {
    const scan = sshHostKeyScanSchema.parse({
      keys: [
        {
          keyType: "ssh-ed25519",
          fingerprint: "SHA256:abc",
          line: "box ssh-ed25519 AAAA",
          trusted: false,
        },
      ],
      changed: true,
    });
    // The old fingerprints are what the new one has to be compared against;
    // an absent list is empty, not "nothing was on record".
    expect(scan.known).toEqual([]);
    expect(scan.keys[0]?.trusted).toBe(false);
    // A first trust must not carry `replace`: the field is a decision.
    expect(
      trustSshHostKeyRequestSchema.parse({ line: "box ssh-ed25519 AAAA" })
        .replace,
    ).toBeUndefined();
    expect(
      trustSshHostKeyRequestSchema.parse({ line: "x", replace: true }).replace,
    ).toBe(true);
  });

  it("carries a waiting prompt outward without a field for its answer", () => {
    const [prompt] = sshPromptListSchema.parse([
      {
        promptId: "p-1",
        hostId: "box",
        kind: "password",
        prompt: "me@box's password:",
        answer: "hunter2",
      },
    ]);
    expect(prompt).toEqual({
      promptId: "p-1",
      hostId: "box",
      kind: "password",
      prompt: "me@box's password:",
    });
    expect(
      sshPromptListSchema.safeParse([{ ...prompt, kind: "otp" }]).success,
    ).toBe(false);
  });

  it("models an execution-host switch and the structured refusal it can get", () => {
    // An empty host id means this machine, whose paths may contain spaces.
    expect(
      switchExecutionHostRequestSchema.parse({
        executionHostId: "",
        rootPath: "/Users/me/My Project",
      }).force,
    ).toBeUndefined();
    expect(
      switchExecutionHostRequestSchema.safeParse({
        executionHostId: "box",
        rootPath: "srv/project",
      }).success,
    ).toBe(false);
    const refusal = executionHostRefusalSchema.parse({
      code: "root_mismatch",
      message:
        "The directory on the new execution host is not the same project",
      from: { head: "abc", entries: "d1", entryCount: 12 },
      to: { head: "", entries: "d2", entryCount: 3 },
    });
    expect(refusal.blockers).toEqual([]);
    expect(refusal.to?.entryCount).toBe(3);
    expect(
      executionHostRefusalSchema.parse({
        code: "switch_blocked",
        message: "Close what is still using this execution host",
        blockers: [{ kind: "editorDraft", detail: "src/main.rs" }],
      }).blockers[0]?.kind,
    ).toBe("editorDraft");
    expect(
      executionHostRefusalSchema.safeParse({ code: "nope", message: "" })
        .success,
    ).toBe(false);
  });
});
