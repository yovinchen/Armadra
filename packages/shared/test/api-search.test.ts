import { describe, expect, it } from "vitest";
import {
  fileIndexSchema,
  fileSearchRequestSchema,
  fileSearchResultSchema,
} from "../src/index.js";

describe("runtime search API", () => {
  it("keeps search answers honest about truncation and paging", () => {
    const index = fileIndexSchema.parse({
      entries: [{ path: "src/a.ts", name: "a.ts", size: 12 }],
      truncated: true,
      scanned: 40000,
    });
    expect(index.truncated).toBe(true);

    expect(fileSearchRequestSchema.safeParse({ query: "" }).success).toBe(
      false,
    );
    const request = fileSearchRequestSchema.parse({
      query: "needle",
      regex: true,
      caseSensitive: true,
      wholeWord: true,
      include: "*.ts,src/**/*.tsx",
      exclude: "**/*.d.ts",
      limit: 20,
      offset: 20,
    });
    expect(request.include).toBe("*.ts,src/**/*.tsx");

    const page = fileSearchResultSchema.parse({
      files: [
        {
          path: "src/a.ts",
          matches: [
            {
              line: 3,
              column: 7,
              length: 6,
              preview: "const needle = 1;",
              previewTruncated: false,
            },
          ],
          truncated: true,
        },
      ],
      totalMatches: 1,
      truncated: true,
      timedOut: false,
      skipped: 2,
      scanned: 120,
      nextOffset: 20,
    });
    expect(page.nextOffset).toBe(20);
    // The last page says so with a null rather than an absent field.
    expect(
      fileSearchResultSchema.parse({
        files: [],
        totalMatches: 0,
        truncated: false,
        timedOut: false,
        skipped: 0,
        scanned: 3,
        nextOffset: null,
      }).nextOffset,
    ).toBeNull();
    // Lines and columns are 1-based; a zero would misplace every jump.
    expect(
      fileSearchResultSchema.safeParse({
        files: [
          {
            path: "a",
            matches: [
              {
                line: 0,
                column: 1,
                length: 1,
                preview: "",
                previewTruncated: false,
              },
            ],
            truncated: false,
          },
        ],
        totalMatches: 1,
        truncated: false,
        timedOut: false,
        skipped: 0,
        scanned: 1,
      }).success,
    ).toBe(false);
  });
});
