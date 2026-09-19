import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { unshared, waitUntilUnshared } from "./before-pack.mjs";

test("a file nobody holds passes the probe and keeps its name", () => {
  const dir = mkdtempSync(join(tmpdir(), "armadra-before-pack-"));
  const file = join(dir, "armadra-runtime.exe");
  writeFileSync(file, "");
  assert.equal(unshared(file), true);
  assert.ok(existsSync(file));
  assert.ok(!existsSync(`${file}.probe`));
});

test("a held file is reported once with its holders, then released", () => {
  const seen = [];
  let attempts = 0;
  waitUntilUnshared("C:\\held.exe", {
    stepMs: 1,
    probe: () => ++attempts > 2,
    report: () => "123 scanner (module)",
    log: (line) => seen.push(line),
  });
  assert.equal(attempts, 3);
  assert.equal(seen.length, 2);
  assert.match(seen[0], /123 scanner \(module\)/);
  assert.match(seen[1], /released/);
});

test("a file that never releases fails with the limit in the message", () => {
  assert.throws(
    () =>
      waitUntilUnshared("C:\\stuck.exe", {
        limitMs: 5,
        stepMs: 1,
        probe: () => false,
        report: () => "",
        log: () => {},
      }),
    /stayed locked/,
  );
});
