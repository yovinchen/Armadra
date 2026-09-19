import { describe, expect, it } from "vitest";
import { join } from "node:path";

import {
  STAGING_MAX_AGE_MS,
  expiredStagedFiles,
  uniqueDownloadPath,
  userDownloadName,
} from "./downloads";

/**
 * The two rules that decide what a person's own download is called and where
 * it goes, and the one that stops the agent's staging directory from growing
 * forever. All three are pure, so none of this needs a session or a clock.
 */

describe("the name a person's download keeps", () => {
  it("keeps the characters a person reads", () => {
    expect(userDownloadName("报告 2026.pdf")).toBe("报告 2026.pdf");
    expect(userDownloadName("Q4 report (final).xlsx")).toBe(
      "Q4 report (final).xlsx",
    );
  });

  it("is only ever a filename", () => {
    // A suggested name is a string from a page; a page that suggests a path
    // is suggesting where this process should write.
    expect(userDownloadName("../../etc/passwd")).toBe("passwd");
    expect(userDownloadName("/etc/shadow")).toBe("shadow");
    expect(userDownloadName("C:\\Windows\\System32\\evil.dll")).toBe(
      "evil.dll",
    );
    expect(userDownloadName("..")).toBe("download");
  });

  it("drops NUL and the other control characters", () => {
    expect(userDownloadName("report\u0000.pdf")).toBe("report.pdf");
    expect(userDownloadName("re\u001bport.pdf")).toBe("report.pdf");
  });

  it("never hides the file behind a leading dot", () => {
    expect(userDownloadName(".hidden")).toBe("hidden");
  });

  it("falls back rather than producing an empty name", () => {
    for (const value of ["", "   ", "...", 42, null, undefined])
      expect(userDownloadName(value), JSON.stringify(value)).toBe("download");
  });

  it("bounds the length", () => {
    expect(userDownloadName("a".repeat(400))).toHaveLength(120);
  });
});

describe("where a person's download lands", () => {
  const taken = (...paths: string[]) => {
    const set = new Set(paths);
    return (path: string) => set.has(path);
  };

  it("is the plain name when nothing is in the way", () => {
    expect(uniqueDownloadPath("/downloads", "report.pdf", () => false)).toBe(
      join("/downloads", "report.pdf"),
    );
  });

  it("numbers before the extension, so the file still opens", () => {
    expect(
      uniqueDownloadPath(
        "/downloads",
        "report.pdf",
        taken(join("/downloads", "report.pdf")),
      ),
    ).toBe(join("/downloads", "report (1).pdf"));
  });

  it("keeps counting past the first collision", () => {
    expect(
      uniqueDownloadPath(
        "/downloads",
        "report.pdf",
        taken(
          join("/downloads", "report.pdf"),
          join("/downloads", "report (1).pdf"),
          join("/downloads", "report (2).pdf"),
        ),
      ),
    ).toBe(join("/downloads", "report (3).pdf"));
  });

  it("numbers a name that has no extension", () => {
    expect(
      uniqueDownloadPath(
        "/downloads",
        "archive",
        taken(join("/downloads", "archive")),
      ),
    ).toBe(join("/downloads", "archive (1)"));
  });

  it("never returns a path that is already taken", () => {
    // The loop has a bound; what must not happen at the bound is overwriting.
    const everything = () => true;
    const answer = uniqueDownloadPath("/downloads", "report.pdf", everything);
    expect(answer).not.toBe(join("/downloads", "report.pdf"));
    expect(answer.endsWith(".pdf")).toBe(true);
  });
});

describe("the staging sweep", () => {
  const now = 1_000 * STAGING_MAX_AGE_MS;

  it("drops what is older than a day and keeps the rest", () => {
    const expired = expiredStagedFiles(
      [
        { name: "old", modifiedAtMs: now - STAGING_MAX_AGE_MS - 1 },
        { name: "exactly", modifiedAtMs: now - STAGING_MAX_AGE_MS },
        { name: "fresh", modifiedAtMs: now - 5_000 },
      ],
      now,
    );
    expect(expired).toEqual(["old"]);
  });

  it("keeps a file whose timestamp is in the future", () => {
    // A clock that moved backwards must not delete something just written.
    expect(
      expiredStagedFiles([{ name: "ahead", modifiedAtMs: now + 60_000 }], now),
    ).toEqual([]);
  });

  it("sweeps nothing out of an empty directory", () => {
    expect(expiredStagedFiles([], now)).toEqual([]);
  });
});
