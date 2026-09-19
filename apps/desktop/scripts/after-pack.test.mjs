import { strict as assert } from "node:assert";
import test from "node:test";

import { copyWithRetry, placements, tripleFor } from "./after-pack.mjs";
import { bundleResources } from "./sidecar-targets.mjs";
import { binariesFor } from "./stage-binaries.mjs";

test("every packaged platform/arch pair maps to the triple stage-binaries used", () => {
  assert.equal(tripleFor("darwin", "arm64"), "aarch64-apple-darwin");
  assert.equal(tripleFor("win32", "x64"), "x86_64-pc-windows-msvc");
  assert.equal(tripleFor("linux", "arm64"), "aarch64-unknown-linux-gnu");
  assert.throws(() => tripleFor("win32", "ia32"), /no sidecar target/);
});

test("a busy file is retried until it copies, and the holder is reported once", () => {
  let calls = 0;
  const seen = [];
  const attempts = copyWithRetry("src.exe", "dst.exe", {
    stepMs: 0,
    copy: () => {
      calls += 1;
      if (calls < 3) throw Object.assign(new Error("busy"), { code: "EBUSY" });
    },
    log: (line) => seen.push(line),
    report: () => "42 scanner (module)",
    sleep: () => {},
  });
  assert.equal(attempts, 3);
  assert.equal(seen.length, 2);
  assert.match(seen[0], /42 scanner \(module\)/);
  assert.match(seen[1], /after 3 attempts/);
});

test("a file that stays busy past the limit fails with the code in the message", () => {
  let clock = 0;
  assert.throws(
    () =>
      copyWithRetry("src.exe", "dst.exe", {
        limitMs: 10,
        stepMs: 5,
        copy: () => {
          throw Object.assign(new Error("busy"), { code: "EPERM" });
        },
        log: () => {},
        report: () => "",
        now: () => clock,
        sleep: (ms) => {
          clock += ms;
        },
      }),
    /stayed busy for 0.01s \(EPERM\)/,
  );
});

test("an error that is not a sharing violation is not retried", () => {
  let calls = 0;
  assert.throws(
    () =>
      copyWithRetry("src.exe", "dst.exe", {
        copy: () => {
          calls += 1;
          throw Object.assign(new Error("gone"), { code: "ENOENT" });
        },
        log: () => {},
        sleep: () => {},
      }),
    /gone/,
  );
  assert.equal(calls, 1);
});

test("a target's placements are its staged binaries plus its out/ bundles, nothing else", () => {
  for (const triple of [
    "x86_64-pc-windows-msvc",
    "aarch64-apple-darwin",
    "x86_64-unknown-linux-gnu",
  ]) {
    const placed = placements(triple);
    const binaries = placed.filter((p) => p.executable).map((p) => p.to);
    const ext = triple.includes("windows") ? ".exe" : "";
    assert.deepEqual(
      binaries,
      binariesFor(triple).map((b) => `${b}${ext}`),
    );
    assert.deepEqual(
      placed.filter((p) => !p.executable).map((p) => `${p.from} -> ${p.to}`),
      bundleResources(triple).map((b) => `${b.from} -> ${b.to}`),
    );
  }
});
