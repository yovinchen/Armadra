import { strict as assert } from "node:assert";
import test from "node:test";

import {
  bundleResources,
  copyWithRetry,
  migrationResources,
  placements,
  platformFor,
} from "./after-pack.mjs";

test("only the platform/arch pairs this shell ships are packaged", () => {
  assert.equal(platformFor("darwin", "arm64"), "darwin");
  assert.equal(platformFor("win32", "x64"), "win32");
  assert.equal(platformFor("linux", "arm64"), "linux");
  assert.throws(() => platformFor("win32", "ia32"), /no bundle target/);
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

test("a platform's placements are its out/ bundles plus every migration, nothing else", () => {
  for (const platform of ["win32", "darwin", "linux"]) {
    const placed = placements(platform);
    // Nothing is an executable any more: the core runs on the Electron the
    // bundle already carries, and there are no sidecar binaries left to chmod.
    assert.deepEqual(
      placed.filter((p) => p.executable),
      [],
    );
    assert.deepEqual(
      placed.map((p) => `${p.from} -> ${p.to}`),
      [...bundleResources(platform), ...migrationResources()].map(
        (r) => `${r.from} -> ${r.to}`,
      ),
    );
  }
  // Only Windows carries the session host; every platform carries the hook.
  assert.deepEqual(
    bundleResources("darwin").map((r) => r.to),
    ["cli/armadra-hook.js", "tray.png"],
  );
  assert.deepEqual(
    bundleResources("win32").map((r) => r.to),
    ["cli/armadra-hook.js", "tray.png", "session-host/host.cjs"],
  );
});

test("the migrations go where a packaged core looks for them", () => {
  const migrations = migrationResources();
  // `core/db/migrations.ts` joins `resourcesPath` with exactly "migrations".
  assert.ok(migrations.every((m) => m.to.startsWith("migrations/")));
  assert.ok(migrations.every((m) => m.to.endsWith(".sql")));
  // One continuous sequence from 1: the same set the ledger preflight reads.
  assert.deepEqual(
    migrations.map((m) =>
      Number(m.to.slice("migrations/".length, -".sql".length).slice(0, 4)),
    ),
    migrations.map((_, index) => index + 1),
  );
});
