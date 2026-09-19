import { describe, expect, it } from "vitest";
import {
  badRequest,
  coreError,
  forbidden,
  internal,
  methodNotAllowed,
  notFound,
  notImplemented,
} from "./errors";

describe("the error envelope", () => {
  it("has exactly two keys, always", () => {
    // Contract §5.1. A third key is a break, however harmless it looks.
    for (const answer of [
      coreError(400, "bad_request", "x"),
      notFound("/api/x"),
      methodNotAllowed("DELETE", "/api/x"),
      badRequest("x"),
      forbidden("x"),
      internal("x"),
      notImplemented("终端会话", 2),
    ]) {
      expect(Object.keys(answer.body).sort()).toEqual(["code", "message"]);
      expect(typeof answer.body.code).toBe("string");
      expect(typeof answer.body.message).toBe("string");
    }
  });

  it("uses snake_case codes and never an empty one", () => {
    for (const answer of [
      notFound("/x"),
      methodNotAllowed("GET", "/x"),
      badRequest("x"),
      forbidden("x"),
      internal("x"),
      notImplemented("x", 1),
    ]) {
      expect(answer.body.code).toMatch(/^[a-z][a-z_]*$/);
    }
  });

  it("carries the status the code means", () => {
    expect(notFound("/x").status).toBe(404);
    expect(methodNotAllowed("GET", "/x").status).toBe(405);
    expect(badRequest("x").status).toBe(400);
    expect(forbidden("x").status).toBe(403);
    expect(internal("x").status).toBe(500);
    expect(notImplemented("x", 1).status).toBe(501);
  });

  it("names the feature and the phase in a 501", () => {
    expect(notImplemented("终端会话", 2).body).toEqual({
      code: "not_implemented",
      message: "终端会话（R2）",
    });
  });

  it("names the path in a 404, so a typo is visible", () => {
    expect(notFound("/api/workspacse").body.message).toContain(
      "/api/workspacse",
    );
  });
});
