import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type Endpoint, parse, read, render, write } from "./endpoint";
import { tempDir } from "../testing/temp-dir";

function fixture(): Endpoint {
  return {
    port: 43119,
    socket: "/tmp/armadra/hook.sock",
    token: "V4uYb0Q",
    nodeTokenDir: "/tmp/armadra/node-tokens",
  };
}

describe("the hook endpoint file", () => {
  it("renders the documented shape", () => {
    const rendered = render(fixture());
    expect(rendered).toContain("ARMADRA_HOOK_VERSION='1'\n");
    expect(rendered).toContain("ARMADRA_HOOK_PORT='43119'\n");
    expect(rendered).toContain("ARMADRA_HOOK_SOCK='/tmp/armadra/hook.sock'\n");
    expect(rendered).toContain("ARMADRA_HOOK_TOKEN='V4uYb0Q'\n");
    expect(rendered).toContain(
      "ARMADRA_NODE_TOKEN_DIR='/tmp/armadra/node-tokens'\n",
    );
    // Comments are prefixed so a `.`-sourcing shell ignores them.
    for (const line of rendered.split("\n").filter(Boolean)) {
      expect(line.startsWith("#") || line.includes("='")).toBe(true);
    }
  });

  it("round-trips a path containing a quote", () => {
    const awkward = { ...fixture(), socket: "/tmp/it's here/hook.sock" };
    const parsed = parse(render(awkward));
    expect(parsed.get("ARMADRA_HOOK_SOCK")).toBe("/tmp/it's here/hook.sock");
    expect(parsed.get("ARMADRA_HOOK_TOKEN")).toBe("V4uYb0Q");
  });

  it.skipIf(process.platform === "win32")(
    "agrees with /bin/sh about that same file",
    () => {
      // The agreement is with `sh`: the file exists to be `.`-sourced by one,
      // and Windows has no shell that reads this dialect.
      const awkward = { ...fixture(), socket: "/tmp/it's here/hook.sock" };
      const script = `${render(awkward)}\nprintf '%s' "$ARMADRA_HOOK_SOCK"`;
      const stdout = execFileSync("/bin/sh", ["-c", script], {
        encoding: "utf8",
      });
      expect(stdout).toBe("/tmp/it's here/hook.sock");
    },
  );

  it("yields nothing rather than an error for a missing or broken file", () => {
    expect(read("/definitely/not/here.env").size).toBe(0);
    const parsed = parse("# only a comment\nnot-an-assignment\n=novalue\n");
    expect(parsed.size).toBe(0);
  });

  it.skipIf(process.platform === "win32")("writes a private file", () => {
    const directory = tempDir("armadra-hook-endpoint-");
    const path = join(directory, "nested", "hook-endpoint.env");
    write(path, fixture());
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(read(path).get("ARMADRA_HOOK_PORT")).toBe("43119");
  });

  it("omits the port key entirely for a core without one", () => {
    // A client that read `ARMADRA_HOOK_PORT='0'` would try to connect to it.
    const rendered = render({ ...fixture(), port: undefined });
    expect(rendered).not.toContain("ARMADRA_HOOK_PORT");
    const parsed = parse(rendered);
    expect(parsed.has("ARMADRA_HOOK_PORT")).toBe(false);
    expect(parsed.get("ARMADRA_HOOK_SOCK")).toBe("/tmp/armadra/hook.sock");
  });
});
