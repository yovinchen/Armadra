import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { placeHookLauncher } from "./after-pack.mjs";
import {
  HOOK_LAUNCHER_RESOURCE,
  compileHookLauncher,
  cscArguments,
  cscCandidates,
  findCsc,
} from "./hook-launcher.mjs";

test("csc is looked for under every .NET Framework 4 directory of WINDIR", () => {
  const candidates = cscCandidates({ WINDIR: "D:\\Win" });
  assert.equal(candidates.length, 3);
  for (const candidate of candidates) {
    assert.ok(candidate.startsWith(join("D:\\Win", "Microsoft.NET")));
    assert.ok(candidate.endsWith(join("v4.0.30319", "csc.exe")));
  }
  const second = candidates[1];
  assert.equal(
    findCsc({ env: { WINDIR: "D:\\Win" }, exists: (p) => p === second }),
    second,
  );
  assert.equal(
    findCsc({ env: { WINDIR: "D:\\Win" }, exists: () => false }),
    undefined,
  );
});

test("the launcher is an anycpu console program", () => {
  const args = cscArguments("in.cs", "out.exe");
  assert.ok(args.includes("/target:exe"));
  assert.ok(args.includes("/platform:anycpu"));
  assert.ok(args.includes("/out:out.exe"));
  assert.equal(args.at(-1), "in.cs");
});

test("after-pack builds the launcher only for a Windows target", () => {
  const built = [];
  const logs = [];
  const options = {
    host: "win32",
    compile: (output) => (built.push(output), output),
    log: (line) => logs.push(line),
  };
  assert.equal(placeHookLauncher("darwin", "R", options), undefined);
  assert.equal(placeHookLauncher("linux", "R", options), undefined);
  assert.deepEqual(built, []);
  assert.equal(
    placeHookLauncher("win32", "R", options),
    join("R", HOOK_LAUNCHER_RESOURCE),
  );
  assert.deepEqual(built, [join("R", HOOK_LAUNCHER_RESOURCE)]);
});

test("a Windows target packaged elsewhere says it fell back to the .cmd", () => {
  const logs = [];
  const result = placeHookLauncher("win32", "R", {
    host: "darwin",
    compile: () => assert.fail("no compiler off Windows"),
    log: (line) => logs.push(line),
  });
  assert.equal(result, undefined);
  assert.match(logs[0], /WARNING .*armadra-hook\.cmd/);
});

test(
  "the C# source compiles with the csc every Windows ships",
  { skip: process.platform !== "win32" },
  () => {
    const dir = mkdtempSync(join(tmpdir(), "armadra-launcher-exe-"));
    try {
      const output = compileHookLauncher(join(dir, "armadra-hook.exe"));
      assert.ok(existsSync(output));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
