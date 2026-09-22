/**
 * The 15 pre-merge unit tests, translated. Same names,
 * same assertions: a divergence here is a divergence a runtime would see.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  KEY_PORT,
  KEY_SOCK,
  KEY_TOKEN,
  KEY_VERSION,
  MAX_CANDIDATES,
  discoverCandidatesFrom,
  isValidNodeId,
  loadEndpoint,
  parseEndpointFile,
  pendingDir,
} from "./endpoint.js";

const temporaries: string[] = [];

function tempdir(): string {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "armadra-hook-endpoint-"),
  );
  temporaries.push(directory);
  return directory;
}

afterEach(() => {
  while (temporaries.length > 0) {
    fs.rmSync(temporaries.pop()!, { recursive: true, force: true });
  }
});

describe("endpoint file parsing", () => {
  it("parses single quoted values", () => {
    const map = parseEndpointFile(
      "ARMADRA_HOOK_PORT='43120'\nARMADRA_HOOK_TOKEN='abc.def'\nARMADRA_HOOK_VERSION='3'\n",
    );
    expect(map.get(KEY_PORT)).toBe("43120");
    expect(map.get(KEY_TOKEN)).toBe("abc.def");
    expect(map.get(KEY_VERSION)).toBe("3");
  });

  it("unescapes embedded single quotes", () => {
    // A path such as `/tmp/o'brien/hook.sock` round-trips through the POSIX
    // `'\''` escape.
    const map = parseEndpointFile(
      "ARMADRA_HOOK_SOCK='/tmp/o'\\''brien/hook.sock'\n",
    );
    expect(map.get(KEY_SOCK)).toBe("/tmp/o'brien/hook.sock");
  });

  it("keeps inner characters verbatim", () => {
    const map = parseEndpointFile(
      "A='a=b=c'\nB='  spaced  '\nC='#not a comment'\n",
    );
    expect(map.get("A")).toBe("a=b=c");
    expect(map.get("B")).toBe("  spaced  ");
    expect(map.get("C")).toBe("#not a comment");
  });

  it("skips blank, comment and malformed lines", () => {
    const map = parseEndpointFile(
      "\n# comment\ngarbage\n=novalue\nexport A='1'\n",
    );
    expect(map.size).toBe(1);
    expect(map.get("A")).toBe("1");
  });

  it("accepts bare and double quoted values", () => {
    const map = parseEndpointFile('A=bare\nB="quoted"\n');
    expect(map.get("A")).toBe("bare");
    expect(map.get("B")).toBe("quoted");
  });
});

describe("node id gate", () => {
  it("only accepts filesystem-safe ids of at most 80 characters", () => {
    expect(isValidNodeId("node-1_A")).toBe(true);
    expect(isValidNodeId("")).toBe(false);
    expect(isValidNodeId("../etc/passwd")).toBe(false);
    expect(isValidNodeId("has space")).toBe(false);
    expect(isValidNodeId("a/b")).toBe(false);
    expect(isValidNodeId("a".repeat(80))).toBe(true);
    expect(isValidNodeId("a".repeat(81))).toBe(false);
  });
});

describe("loading", () => {
  it("requires an address", () => {
    const directory = tempdir();
    const file = path.join(directory, "hook-endpoint.env");
    fs.writeFileSync(file, "ARMADRA_HOOK_TOKEN='t'\n");
    expect(loadEndpoint(file)).toHaveProperty("error");
  });

  it("puts the pending directory next to the endpoint file", () => {
    expect(
      pendingDir({ path: path.join("/data/armadra", "hook-endpoint.env") }),
    ).toBe(path.join("/data/armadra", "pending"));
  });
});

/** Writes a minimal valid endpoint file at `file`. */
function writeEndpoint(
  file: string,
  port: number,
  token: string,
  tokenDir: string,
): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    `ARMADRA_HOOK_PORT='${port}'\nARMADRA_HOOK_TOKEN='${token}'\nARMADRA_NODE_TOKEN_DIR='${tokenDir}'\n`,
  );
}

describe("candidate discovery", () => {
  it("puts the env var candidate first", () => {
    const root = tempdir();
    const envPath = path.join(root, "env", "hook-endpoint.env");
    const dataDir = path.join(root, "data");
    writeEndpoint(envPath, 100, "t1", path.join(root, "tokens1"));
    writeEndpoint(
      path.join(dataDir, "hook-endpoint.env"),
      200,
      "t2",
      path.join(root, "tokens2"),
    );
    const candidates = discoverCandidatesFrom(envPath, dataDir);
    expect(candidates.length).toBe(2);
    expect(candidates[0]?.port).toBe(100);
    expect(candidates[1]?.port).toBe(200);
  });

  it("does not try the same path twice", () => {
    const root = tempdir();
    const dataDir = path.join(root, "data");
    const file = path.join(dataDir, "hook-endpoint.env");
    writeEndpoint(file, 100, "t1", path.join(root, "tokens"));
    // The env var happens to name the exact file the default location names.
    expect(discoverCandidatesFrom(file, dataDir).length).toBe(1);
  });

  it("falls back to the default location when the env file is missing", () => {
    const root = tempdir();
    const dataDir = path.join(root, "data");
    writeEndpoint(
      path.join(dataDir, "hook-endpoint.env"),
      200,
      "t2",
      path.join(root, "tokens"),
    );
    const candidates = discoverCandidatesFrom(
      path.join(root, "nowhere", "hook-endpoint.env"),
      dataDir,
    );
    expect(candidates.length).toBe(1);
    expect(candidates[0]?.port).toBe(200);
  });

  it("adds endpoints.json when its address differs and reuses the last credentials", () => {
    const root = tempdir();
    const dataDir = path.join(root, "data");
    const tokenDir = path.join(root, "tokens");
    writeEndpoint(
      path.join(dataDir, "hook-endpoint.env"),
      100,
      "abc",
      tokenDir,
    );
    fs.writeFileSync(
      path.join(dataDir, "endpoints.json"),
      '{"version":1,"runtime":{"instanceId":"i","writtenAt":"now","processId":1,"http":"http://127.0.0.1:200"}}',
    );
    const candidates = discoverCandidatesFrom(undefined, dataDir);
    expect(candidates.length).toBe(2);
    expect(candidates[0]?.port).toBe(100);
    expect(candidates[1]?.port).toBe(200);
    // Credentials are borrowed from the endpoint file, not re-derived.
    expect(candidates[1]?.hookToken).toBe("abc");
    expect(candidates[1]?.tokenDir).toBe(tokenDir);
  });

  it("skips endpoints.json when it names the same address", () => {
    const root = tempdir();
    const dataDir = path.join(root, "data");
    writeEndpoint(
      path.join(dataDir, "hook-endpoint.env"),
      100,
      "abc",
      path.join(root, "tokens"),
    );
    fs.writeFileSync(
      path.join(dataDir, "endpoints.json"),
      '{"version":1,"runtime":{"instanceId":"i","writtenAt":"now","processId":1,"http":"http://127.0.0.1:100"}}',
    );
    expect(discoverCandidatesFrom(undefined, dataDir).length).toBe(1);
  });

  it("skips endpoints.json with no credentials to borrow", () => {
    // Neither the env var nor the default location loaded a real endpoint, so
    // there is no token to present — presenting none at all would draw an HTTP
    // 401 and wrongly end the search right there.
    const root = tempdir();
    const dataDir = path.join(root, "data");
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(
      path.join(dataDir, "endpoints.json"),
      '{"version":1,"runtime":{"instanceId":"i","writtenAt":"now","processId":1,"http":"http://127.0.0.1:200"}}',
    );
    expect(discoverCandidatesFrom(undefined, dataDir)).toEqual([]);
  });

  it("never exceeds the bound", () => {
    expect(MAX_CANDIDATES).toBe(3);
  });
});
