import { describe, expect, it } from "vitest";
import {
  estimateTokens,
  formatClock,
  formatElapsed,
  formatTokens,
  guessLanguage,
  hasHunks,
  hostnameTitle,
  normalizeUrl,
  parsePatch,
} from "./helpers";

const PATCH = `diff --git a/src/auth/login.ts b/src/auth/login.ts
--- a/src/auth/login.ts
+++ b/src/auth/login.ts
@@ -12,6 +12,9 @@ import { Router } from "express"
 import { Router } from "express"
+import { rateLimit } from "./rateLimit"
-export const login = router.post("/login", async (req, res) => {
+export const login = router.post(
\\ No newline at end of file
@@ -40,0 +43,1 @@
+  it("returns 429", () => {})
`;

describe("parsePatch", () => {
  it("drops the preamble and numbers lines from the hunk header", () => {
    const hunks = parsePatch(PATCH);
    expect(hunks).toHaveLength(2);
    expect(hunks[0]!.header).toContain("@@ -12,6 +12,9 @@");
    expect(hunks[0]!.lines).toEqual([
      { no: "12", sign: " ", text: 'import { Router } from "express"' },
      { no: "13", sign: "+", text: 'import { rateLimit } from "./rateLimit"' },
      {
        no: "13",
        sign: "-",
        text: 'export const login = router.post("/login", async (req, res) => {',
      },
      { no: "14", sign: "+", text: "export const login = router.post(" },
    ]);
    // The trailing newline of the patch must not become an empty context row.
    expect(hunks[1]!.lines).toEqual([
      { no: "43", sign: "+", text: '  it("returns 429", () => {})' },
    ]);
  });

  it("returns nothing for an empty or preamble-only patch", () => {
    expect(parsePatch("")).toEqual([]);
    expect(parsePatch("diff --git a/x b/x\n--- a/x\n+++ b/x")).toEqual([]);
  });
});

describe("hostnameTitle / normalizeUrl", () => {
  it("uses the hostname and keeps the fallback for blank addresses", () => {
    expect(hostnameTitle("https://developer.mozilla.org/zh-CN", "浏览器")).toBe(
      "developer.mozilla.org",
    );
    expect(hostnameTitle("example.com/a", "浏览器")).toBe("example.com");
    expect(hostnameTitle("https://", "浏览器")).toBe("浏览器");
    expect(hostnameTitle("   ", "浏览器")).toBe("浏览器");
  });

  it("adds https:// only when no scheme is present", () => {
    expect(normalizeUrl("example.com")).toBe("https://example.com");
    expect(normalizeUrl("http://example.com")).toBe("http://example.com");
    expect(normalizeUrl("  ")).toBe("");
  });
});

describe("formatting", () => {
  it("estimates tokens at ~4 bytes each", () => {
    expect(estimateTokens(0)).toBe(0);
    expect(estimateTokens(-10)).toBe(0);
    expect(estimateTokens(24_800)).toBe(6_200);
  });

  it("abbreviates thousands and formats the elapsed clock", () => {
    expect(formatTokens(840)).toBe("840");
    expect(formatTokens(12_480)).toBe("12.5k");
    expect(formatElapsed(48)).toBe("0:48");
    expect(formatElapsed(605)).toBe("10:05");
    expect(formatElapsed(-3)).toBe("0:00");
  });

  it("degrades an unparseable log timestamp", () => {
    expect(formatClock("not-a-date")).toBe("--:--:--");
    expect(formatClock(new Date(2026, 0, 2, 14, 2, 11).toISOString())).toBe(
      "14:02:11",
    );
  });

  it("guesses a language from the extension only", () => {
    expect(guessLanguage("src/auth/login.ts")).toBe("TypeScript");
    expect(guessLanguage("Cargo.toml")).toBe("TOML");
    expect(guessLanguage("Makefile")).toBeUndefined();
  });
});

describe("hasHunks", () => {
  it("separates a real unified diff from the runtime's no-preview placeholder", () => {
    expect(hasHunks(PATCH)).toBe(true);
    expect(hasHunks("(未预览：二进制文件)")).toBe(false);
    expect(hasHunks("")).toBe(false);
  });
});
