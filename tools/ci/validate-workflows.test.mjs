import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseYaml } from "./workflow-yaml.mjs";
import {
  checkWorkflow,
  checkWorkflowDirectory,
} from "./validate-workflows.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));

function check(yaml) {
  return checkWorkflow("test.yml", parseYaml(yaml));
}

test("the repository's own workflows pass", () => {
  const { files, problems } = checkWorkflowDirectory();
  assert.deepEqual(problems, []);
  assert.ok(files.includes("ci.yml"));
  assert.ok(files.includes("release.yml"));
});

test("the parser reads the shapes a workflow actually uses", () => {
  const document = parseYaml(
    readFileSync(join(root, ".github/workflows/ci.yml"), "utf8"),
  );
  assert.equal(document.name, "ci");
  // Nested mappings, flow sequences, block scalars and lists of mappings.
  assert.deepEqual(document.on.push.branches, ["main"]);
  assert.equal(document.jobs.host["runs-on"], "ubuntu-latest");
  assert.equal(document.jobs.host.steps[0].uses, "actions/checkout@v4");
  const cross = document.jobs.host.steps.at(-1);
  assert.match(cross.run, /^GOOS=windows[\s\S]*\nGOOS=linux/);
  assert.equal(document.jobs.web.needs, "changes");
});

test("a job that needs a job nobody defined is reported", () => {
  const problems = check(`
name: x
on:
  push:
jobs:
  build:
    needs: [verify]
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /needs verify, which is not a job/);
});

// Reading needs.<job> without declaring it does not wait for that job, so the
// value is empty at exactly the moment it is used.
test("reading an undeclared needs output is reported", () => {
  const problems = check(`
name: x
on:
  push:
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo \${{ needs.verify.outputs.version }}
`);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /reads needs\.verify without declaring it/);
});

test("a step output with no matching step id is reported", () => {
  const problems = check(`
name: x
on:
  push:
jobs:
  verify:
    runs-on: ubuntu-latest
    outputs:
      version: \${{ steps.versoin.outputs.version }}
    steps:
      - id: version
        run: echo hi
`);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /steps\.versoin\.outputs/);
});

test("a cycle in needs is reported", () => {
  const problems = check(`
name: x
on:
  push:
jobs:
  a:
    needs: [b]
    runs-on: ubuntu-latest
    steps:
      - run: echo a
  b:
    needs: [a]
    runs-on: ubuntu-latest
    steps:
      - run: echo b
`);
  assert.ok(problems.some((problem) => /form a cycle/.test(problem)));
});

test("steps that do nothing, do two things, or float a version are reported", () => {
  const problems = check(`
name: x
on:
  push:
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - name: nothing
      - uses: actions/checkout
      - uses: actions/setup-node@v4
        run: echo both
`);
  assert.equal(problems.length, 3);
  assert.match(problems[0], /neither runs nor uses/);
  assert.match(problems[1], /without pinning a version/);
  assert.match(problems[2], /both runs and uses/);
});

test("a workflow with no trigger, runner or steps is reported", () => {
  assert.ok(
    check(
      "name: x\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: x\n",
    ).some((p) => /no trigger/.test(p)),
  );
  assert.ok(
    check(
      "name: x\non:\n  push:\njobs:\n  a:\n    steps:\n      - run: x\n",
    ).some((p) => /names no runner/.test(p)),
  );
  assert.ok(
    check(
      "name: x\non:\n  push:\njobs:\n  a:\n    runs-on: ubuntu-latest\n",
    ).some((p) => /has no steps/.test(p)),
  );
});

test("a malformed file is reported as a problem rather than crashing the run", () => {
  const directory = mkdtempSync(join(tmpdir(), "armadra-workflows-"));
  try {
    writeFileSync(join(directory, "broken.yml"), "name: x\n\tjobs:\n");
    const { problems } = checkWorkflowDirectory(directory);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /broken\.yml: .*tabs/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the release workflow has the five jobs the design names, and publishes only drafts", () => {
  const document = parseYaml(
    readFileSync(join(root, ".github/workflows/release.yml"), "utf8"),
  );
  assert.deepEqual(Object.keys(document.jobs), [
    "verify",
    "web",
    "build",
    "notarize",
    "assemble",
  ]);
  assert.deepEqual(document.on.push.tags, ["v*"]);
  // Six targets, one runner each.
  assert.equal(document.jobs.build.strategy.matrix.include.length, 6);
  const targets = document.jobs.build.strategy.matrix.include.map(
    (entry) => entry.target,
  );
  assert.deepEqual(new Set(targets).size, 6);
  // Publishing is a human act: the workflow only ever creates a draft.
  const create = document.jobs.assemble.steps.at(-1).run;
  assert.match(create, /gh release create/);
  assert.match(create, /--draft/);
  assert.ok(!/gh release edit .*--draft=false/.test(create));
  assert.ok(!/--latest/.test(create));
});
