import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { stagePlaceholders } from "./stage-sidecar-placeholders.mjs";
import { selectTarget } from "./sidecar-targets.mjs";

const host = "aarch64-apple-darwin";

function root() {
  return mkdtempSync(resolve(tmpdir(), "armadra-placeholders-"));
}

test("a Windows target gets the session host placeholder too", () => {
  const directory = root();
  const staged = stagePlaceholders({
    root: directory,
    env: {},
    target: selectTarget({ host, target: "x86_64-pc-windows-msvc" }),
  });
  assert.deepEqual(
    staged.map((path) => path.slice(directory.length + 1)),
    [
      "target/release/armadra-runtime-x86_64-pc-windows-msvc.exe",
      "target/release/armadra-hook-x86_64-pc-windows-msvc.exe",
      "target/release/armadra-session-host-x86_64-pc-windows-msvc.exe",
      "target/release/armadra-host-x86_64-pc-windows-msvc.exe",
    ],
  );
  for (const path of staged) assert.equal(readFileSync(path, "utf8"), "");
});

test("elsewhere only the three sidecars that ship are staged", () => {
  for (const triple of ["aarch64-apple-darwin", "x86_64-unknown-linux-gnu"]) {
    const directory = root();
    const staged = stagePlaceholders({
      root: directory,
      env: {},
      target: selectTarget({ host, target: triple }),
    });
    assert.deepEqual(
      staged.map((path) => path.slice(directory.length + 1)),
      [
        `target/release/armadra-runtime-${triple}`,
        `target/release/armadra-hook-${triple}`,
        `target/release/armadra-host-${triple}`,
      ],
    );
  }
});

test("a real binary from an earlier build is never overwritten", () => {
  const directory = root();
  const target = selectTarget({ host, target: host });
  const [first] = stagePlaceholders({ root: directory, env: {}, target });
  writeFileSync(first, "a real build");
  stagePlaceholders({ root: directory, env: {}, target });
  assert.equal(readFileSync(first, "utf8"), "a real build");
});
