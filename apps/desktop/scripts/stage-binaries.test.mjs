import assert from "node:assert/strict";
import { test } from "node:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

import {
  binariesFor,
  resourceDestination,
  stageBinaries,
} from "./stage-binaries.mjs";
import { selectTarget, sidecarPaths } from "./sidecar-targets.mjs";

const host = "aarch64-apple-darwin";

function root() {
  return mkdtempSync(resolve(tmpdir(), "armadra-stage-binaries-"));
}

function writeSource({ directory, target, binary, content = "binary" }) {
  const { source } = sidecarPaths({
    repository: directory,
    env: {},
    target,
    binary,
  });
  mkdirSync(dirname(source), { recursive: true });
  writeFileSync(source, content);
  return source;
}

test("macOS/Linux targets stage three binaries, without the session host", () => {
  for (const triple of ["aarch64-apple-darwin", "x86_64-unknown-linux-gnu"]) {
    assert.deepEqual(binariesFor(triple), [
      "armadra-runtime",
      "armadra-hook",
      "armadra-host",
    ]);
  }
});

test("a Windows target also ships the session host", () => {
  assert.deepEqual(binariesFor("x86_64-pc-windows-msvc"), [
    "armadra-runtime",
    "armadra-hook",
    "armadra-session-host",
    "armadra-host",
  ]);
});

test("destinations carry the binary's plain name, with no triple suffix", () => {
  const target = selectTarget({ host, target: host });
  const directory = root();
  const destination = resourceDestination({
    root: directory,
    binary: "armadra-runtime",
    target,
  });
  assert.equal(
    destination,
    resolve(directory, "apps/desktop/resources/armadra-runtime"),
  );
});

test("copies every built binary into apps/desktop/resources", () => {
  const directory = root();
  const target = selectTarget({ host, target: host });
  for (const binary of binariesFor(target.triple)) {
    writeSource({ directory, target, binary, content: `content of ${binary}` });
  }
  const staged = stageBinaries({ root: directory, env: {}, target });
  assert.equal(staged.length, 3);
  for (const binary of binariesFor(target.triple)) {
    const destination = resourceDestination({
      root: directory,
      binary,
      target,
    });
    assert.ok(existsSync(destination), destination);
    assert.equal(readFileSync(destination, "utf8"), `content of ${binary}`);
  }
});

test("a missing binary fails loudly, naming every one that is missing", () => {
  const directory = root();
  const target = selectTarget({ host, target: host });
  // Only build the Runtime; leave the hook and the Host missing.
  writeSource({ directory, target, binary: "armadra-runtime" });
  assert.throws(
    () => stageBinaries({ root: directory, env: {}, target }),
    (error) => {
      assert.match(error.message, /2 binaries were not built/);
      assert.match(error.message, /armadra-hook: expected at/);
      assert.match(error.message, /armadra-host: expected at/);
      assert.doesNotMatch(error.message, /armadra-runtime: expected at/);
      return true;
    },
  );
});

test("--placeholders never overwrites a real binary and never requires one", () => {
  const directory = root();
  const target = selectTarget({ host, target: host });
  // Nothing built at all: placeholders must still succeed.
  const staged = stageBinaries({
    root: directory,
    env: {},
    target,
    placeholders: true,
  });
  assert.equal(staged.length, 3);
  for (const path of staged) assert.equal(readFileSync(path, "utf8"), "");

  const [runtimePath] = staged;
  writeFileSync(runtimePath, "a real build");
  stageBinaries({ root: directory, env: {}, target, placeholders: true });
  assert.equal(readFileSync(runtimePath, "utf8"), "a real build");
});
