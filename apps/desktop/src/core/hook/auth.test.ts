import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HookAuth, validNodeId } from "./auth";
import { tempDir } from "../testing/temp-dir";

function temporary(): string {
  return tempDir("armadra-hook-auth-");
}

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

describe("hook credentials", () => {
  it("rejects node ids that could escape the token directory", () => {
    expect(validNodeId("0199aa11-bbbb-7ccc-8ddd-eeeeeeeeeeee")).toBe(true);
    expect(validNodeId("node_1")).toBe(true);
    expect(validNodeId("")).toBe(false);
    expect(validNodeId("..")).toBe(false);
    expect(validNodeId("a/b")).toBe(false);
    expect(validNodeId("a\\b")).toBe(false);
    expect(validNodeId("a b")).toBe(false);
    expect(validNodeId("a".repeat(81))).toBe(false);
  });

  it("keeps the secret across a reload and reuses the bearer", () => {
    const directory = temporary();
    const first = HookAuth.load(directory);
    const second = HookAuth.load(directory, first.bearer);
    expect(second.kid).toBe(first.kid);
    expect(second.bearer).toBe(first.bearer);
    expect(second.nodeToken("node-a")).toBe(first.nodeToken("node-a"));
    // A bearer that is missing or obviously truncated is replaced.
    const third = HookAuth.load(directory, "short");
    expect(third.bearer).not.toBe(first.bearer);
    expect(third.kid).toBe(first.kid);
  });

  it("distinguishes the three verdicts", () => {
    const directory = temporary();
    const auth = HookAuth.load(directory);
    const token = auth.nodeToken("node-a");
    expect(token.startsWith(`${auth.kid}.`)).toBe(true);

    expect(auth.verdict("node-a", token)).toBe("verified");
    // Right shape, wrong node: our kid, so this is an attack, not a relic.
    expect(auth.verdict("node-b", token)).toBe("forged");
    expect(auth.verdict("node-a", `${auth.kid}.garbage`)).toBe("forged");
    // Foreign kid and no token at all are both merely legacy.
    expect(auth.verdict("node-a", "aaaaaaaa.bbb")).toBe("legacy");
    expect(auth.verdict("node-a", "no-dot")).toBe("legacy");
    expect(auth.verdict("node-a", "  ")).toBe("legacy");
    expect(auth.verdict("node-a", undefined)).toBe("legacy");

    // A different install must not be able to impersonate this one.
    const other = HookAuth.ephemeral();
    expect(other.kid).not.toBe(auth.kid);
    expect(auth.verdict("node-a", other.nodeToken("node-a"))).toBe("legacy");
  });

  it("rejects prefixes and absences when comparing the bearer", () => {
    const auth = HookAuth.ephemeral();
    expect(auth.bearerMatches(auth.bearer)).toBe(true);
    expect(auth.bearerMatches(auth.bearer.slice(0, -1))).toBe(false);
    expect(auth.bearerMatches("")).toBe(false);
    expect(auth.bearerMatches(undefined)).toBe(false);
  });

  it.skipIf(process.platform === "win32")(
    "writes token files private and named after the node",
    () => {
      const directory = temporary();
      const auth = HookAuth.load(directory);
      const tokens = join(directory, "node-tokens");
      const token = auth.writeNodeToken(tokens, "node-a");
      expect(readFileSync(join(tokens, "node-a"), "utf8")).toBe(token);
      expect(mode(join(tokens, "node-a"))).toBe(0o600);
      expect(mode(tokens)).toBe(0o700);
      expect(mode(join(directory, "hook-secret"))).toBe(0o600);
      expect(() => auth.writeNodeToken(tokens, "../escape")).toThrow();
      // Rewriting is idempotent, and leaves no temporary file behind.
      auth.writeNodeToken(tokens, "node-a");
      const leftovers = readdirSync(tokens).filter((name) =>
        name.startsWith("."),
      );
      expect(leftovers).toHaveLength(0);
    },
  );
});
