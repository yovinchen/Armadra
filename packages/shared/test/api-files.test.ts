import { describe, expect, it } from "vitest";
import {
  fileContentSchema,
  watchRegistrationSchema,
  writeFileRequestSchema,
  writeFileResponseSchema,
} from "../src/index.js";

describe("runtime files API", () => {
  it("writes files with content versions and literal paths", () => {
    expect(
      writeFileRequestSchema.parse({ path: "src/a.ts", content: "x" }),
    ).toEqual({ path: "src/a.ts", content: "x" });
    expect(
      writeFileRequestSchema.parse({
        path: "src/a.ts",
        content: "",
        expectedSize: 0,
      }).expectedSize,
    ).toBe(0);
    // An empty path or a negative size never reaches the runtime.
    expect(
      writeFileRequestSchema.safeParse({ path: "", content: "" }).success,
    ).toBe(false);
    expect(
      writeFileRequestSchema.safeParse({
        path: "a",
        content: "",
        expectedSize: -1,
      }).success,
    ).toBe(false);
    const sha256 = "a".repeat(64);
    expect(
      writeFileRequestSchema.parse({
        path: "  ",
        content: "",
        expectedSha256: sha256,
      }),
    ).toEqual({ path: "  ", content: "", expectedSha256: sha256 });
    expect(
      writeFileRequestSchema.safeParse({
        path: "a",
        content: "",
        expectedSha256: "bad",
      }).success,
    ).toBe(false);
    expect(
      writeFileResponseSchema.parse({ path: "a", size: 3, sha256 }).sha256,
    ).toBe(sha256);
    expect(
      writeFileResponseSchema.safeParse({ path: "a", size: 3 }).success,
    ).toBe(false);
  });

  it("carries encoding, BOM and EOL, and drops the version for non-UTF-8 files", () => {
    const utf8 = fileContentSchema.parse({
      path: "a.txt",
      mimeType: "text/plain",
      content: "hello\n",
      size: 6,
      sha256: "a".repeat(64),
      encoding: "utf-8",
      bom: true,
      eol: "crlf",
      readonly: false,
    });
    expect(utf8.bom).toBe(true);
    expect(utf8.eol).toBe("crlf");

    // No content version is exactly how a lossy read stays read-only.
    const lossy = fileContentSchema.parse({
      path: "a.txt",
      mimeType: "text/plain",
      content: "he\uFFFDlo",
      size: 6,
      encoding: "unknown",
      bom: false,
      eol: "lf",
      readonly: false,
    });
    expect(lossy.sha256).toBeUndefined();

    // An older runtime answers without any of the new fields.
    expect(
      fileContentSchema.safeParse({
        path: "a.txt",
        mimeType: "text/plain",
        content: "hi",
        size: 2,
        sha256: "b".repeat(64),
      }).success,
    ).toBe(true);
    expect(
      fileContentSchema.safeParse({
        path: "a.txt",
        mimeType: "text/plain",
        content: "hi",
        size: 2,
        eol: "cr",
      }).success,
    ).toBe(false);

    // The BOM travels back on the save so the file keeps it.
    expect(
      writeFileRequestSchema.parse({ path: "a.txt", content: "x", bom: true })
        .bom,
    ).toBe(true);
  });

  it("says how a watch delivers changes, defaulting to events", () => {
    const version = { path: "a.txt", exists: true };
    expect(
      watchRegistrationSchema.parse({ status: "watching", version }).mode,
    ).toBe("events");
    expect(
      watchRegistrationSchema.parse({
        status: "watching",
        mode: "poll",
        reason: "This execution host polls for changes every 2s",
        version,
      }).mode,
    ).toBe("poll");
  });
});
