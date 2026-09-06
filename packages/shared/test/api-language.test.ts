import { describe, expect, it } from "vitest";
import {
  createFileEntryRequestSchema,
  fileEntryResultSchema,
  languageServiceStatusSchema,
  trashEntrySchema,
} from "../src/index.js";

const timestamp = "2026-08-13T00:00:00.000Z";

describe("runtime language API", () => {
  it("describes file work and refuses a language service that claims to work", () => {
    expect(
      createFileEntryRequestSchema.parse({ path: "src/new.ts", kind: "file" })
        .kind,
    ).toBe("file");
    expect(
      createFileEntryRequestSchema.safeParse({ path: "src", kind: "folder" })
        .success,
    ).toBe(false);
    expect(
      fileEntryResultSchema.parse({ path: "src/new.ts", kind: "file" }).path,
    ).toBe("src/new.ts");
    expect(
      trashEntrySchema.parse({
        id: "0198f000-0000-7000-8000-000000000000",
        originalPath: "src/old.ts",
        name: "old.ts",
        kind: "file",
        deletedAt: timestamp,
      }).originalPath,
    ).toBe("src/old.ts");

    // The probe answer widened (language service design §2.9), but it is still
    // a closed set: a status nobody defined is refused rather than shown.
    const probe = languageServiceStatusSchema.parse({ status: "unavailable" });
    expect(probe.status).toBe("unavailable");
    expect(probe.executionHostId).toBe("local");
    expect(probe.servers).toEqual([]);
    expect(
      languageServiceStatusSchema.safeParse({ status: "ready" }).success,
    ).toBe(false);
  });
});
