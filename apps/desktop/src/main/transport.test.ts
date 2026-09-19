import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  endpointsSnapshot,
  fallbackEndpoints,
  publishEndpoints,
  readRuntimeBases,
  resetEndpoints,
  resolveEndpoints,
} from "./transport";

/**
 * The page's bases. The Runtime's port is kernel-assigned, so `endpoints.json`
 * is the only thing that knows it — and the page reads the answer before its
 * first `await`, which is why a snapshot exists at all.
 */

const HOST = "http://127.0.0.1:43121";
const EXTERNAL = "http://127.0.0.1:43120";
let directory = "";

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "armadra-transport-"));
  resetEndpoints();
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
  resetEndpoints();
});

function publish(document: unknown): void {
  writeFileSync(join(directory, "endpoints.json"), JSON.stringify(document));
}

describe("resolving the page's bases", () => {
  it("takes the kernel-assigned port out of endpoints.json", async () => {
    publish({
      runtime: {
        http: "http://127.0.0.1:52341",
        websocket: "ws://127.0.0.1:52341",
      },
    });
    expect(await resolveEndpoints(directory, EXTERNAL, HOST)).toEqual({
      httpBase: "http://127.0.0.1:52341",
      wsBase: "ws://127.0.0.1:52341",
      hostBase: HOST,
      dataDir: directory,
    });
  });

  it("falls back to the documented port when nothing is published", async () => {
    expect(await resolveEndpoints(directory, EXTERNAL, HOST)).toEqual(
      fallbackEndpoints(EXTERNAL, HOST, directory),
    );
    expect(fallbackEndpoints(EXTERNAL, HOST, directory).wsBase).toBe(
      "ws://127.0.0.1:43120",
    );
  });

  it("refuses a record that points anywhere but loopback", async () => {
    for (const http of [
      "http://192.168.1.20:43120",
      "https://armadra.example",
      "not a url",
    ]) {
      publish({ runtime: { http } });
      expect(await readRuntimeBases(directory), http).toBeUndefined();
      // The page is given the fallback rather than an address nobody asked
      // for: pointing it at another machine is the one failure that would
      // look like it worked.
      expect((await resolveEndpoints(directory, EXTERNAL, HOST)).httpBase).toBe(
        EXTERNAL,
      );
    }
  });

  it("survives a truncated or absent document", async () => {
    expect(await readRuntimeBases(directory)).toBeUndefined();
    writeFileSync(join(directory, "endpoints.json"), '{"runtime":');
    expect(await readRuntimeBases(directory)).toBeUndefined();
  });
});

describe("the snapshot the page reads before its first await", () => {
  it("answers the published value, and the fallback until there is one", () => {
    const fallback = fallbackEndpoints(EXTERNAL, HOST, directory);
    // Never a hang and never a throw: a pending promise here would look to the
    // front end exactly like a dead Runtime.
    expect(endpointsSnapshot(() => fallback)).toEqual(fallback);

    const resolved = { ...fallback, httpBase: "http://127.0.0.1:52341" };
    publishEndpoints(resolved);
    expect(endpointsSnapshot(() => fallback)).toEqual(resolved);
  });
});
