import { describe, expect, it } from "vitest";
import {
  badRequest,
  isHexColor,
  isRfc3339,
  isUuid,
  jsonObject,
  rfc3339,
  uuidV7,
} from "./support";

describe("the shared domain vocabulary", () => {
  it("spells a timestamp the way chrono's to_rfc3339 does", () => {
    // A numeric offset, never `Z` — the front end compares the string it was
    // given byte for byte when it saves.
    expect(rfc3339(Date.UTC(2026, 8, 19, 12, 34, 56, 789))).toBe(
      "2026-09-19T12:34:56.789+00:00",
    );
    // `SecondsFormat::AutoSi` drops the fraction when it is zero.
    expect(rfc3339(Date.UTC(2030, 0, 1, 0, 0, 0, 0))).toBe(
      "2030-01-01T00:00:00+00:00",
    );
    expect(isRfc3339(rfc3339())).toBe(true);
    expect(isRfc3339("2026-09-19T12:34:56Z")).toBe(true);
    expect(isRfc3339("2026-09-19 12:34:56")).toBe(false);
    expect(isRfc3339("yesterday")).toBe(false);
  });

  it("never issues the same timestamp twice", () => {
    // The board's `updated_at` is its revision: a repeat would let a client
    // holding a stale token win a CAS it should have lost.
    const issued = Array.from({ length: 50 }, () => rfc3339());
    expect(new Set(issued).size).toBe(issued.length);
    expect([...issued].sort()).toEqual(issued);
  });

  it("mints time-ordered v7 identifiers", () => {
    const early = uuidV7(Date.UTC(2020, 0, 1));
    const late = uuidV7(Date.UTC(2030, 0, 1));
    expect(isUuid(early)).toBe(true);
    expect(early < late).toBe(true);
    // Version 7, variant 1.
    expect(early[14]).toBe("7");
    expect("89ab").toContain(early[19]);
    expect(new Set(Array.from({ length: 100 }, () => uuidV7())).size).toBe(100);
  });

  it("accepts only #RRGGBB", () => {
    expect(isHexColor("#0a84ff")).toBe(true);
    expect(isHexColor("#0A84FF")).toBe(true);
    expect(isHexColor("#0a84f")).toBe(false);
    expect(isHexColor("0a84ff")).toBe(false);
    expect(isHexColor("red")).toBe(false);
  });

  it("turns a malformed body into a 400 rather than a crash", () => {
    expect(jsonObject(Buffer.from('{"a":1}'))).toEqual({ a: 1 });
    expect(jsonObject(Buffer.alloc(0))).toEqual({});
    expect(() => jsonObject(Buffer.from("{"))).toThrowError(/valid JSON/);
    expect(() => jsonObject(Buffer.from("[]"))).toThrowError(/JSON object/);
  });

  it("answers with the code the Rust Runtime answers with", () => {
    expect(badRequest("nope").response()).toEqual({
      status: 400,
      body: { code: "bad_request", message: "nope" },
    });
  });
});
