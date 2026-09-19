/**
 * One version, four files, one tag.
 *
 * The workspace version in the root Cargo.toml is the only source; every other
 * place that repeats it is checked against it, and the Host's own version is
 * stamped in at link time from the same value. A release built from files that
 * disagree would ship a desktop shell and a Host that report different
 * versions, and the update check compares versions — so this runs first in CI
 * and refuses the tag rather than producing that release.
 *
 *   node tools/release/version.mjs check [--tag vX.Y.Z]
 *   node tools/release/version.mjs set X.Y.Z
 *   node tools/release/version.mjs print
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  compareVersions,
  parseVersion,
  readCompatibility,
} from "./compatibility.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));

/**
 * Every file that repeats the version. The Cargo workspace is first because it
 * is the source; the rest are compared with it.
 */
export const VERSION_SITES = [
  { path: "Cargo.toml", kind: "cargo-workspace" },
  { path: "package.json", kind: "json" },
  // electron-builder reads the version out of this manifest, so there is no
  // fourth site to keep in step any more.
  { path: "apps/desktop/package.json", kind: "json" },
];

const CARGO_VERSION =
  /(\[workspace\.package\][^[]*?\bversion\s*=\s*")([^"]*)(")/s;
const JSON_VERSION = /^(\s*"version"\s*:\s*")([^"]*)(")/m;

function pattern(kind) {
  return kind === "cargo-workspace" ? CARGO_VERSION : JSON_VERSION;
}

/** Read the version each site declares. */
export function readVersions(base = root) {
  return VERSION_SITES.map((site) => {
    const text = readFileSync(base + site.path, "utf8");
    const match = pattern(site.kind).exec(text);
    if (!match) throw new Error(`no version field in ${site.path}`);
    return { ...site, version: match[2] };
  });
}

/** The version the workspace declares — the one everything else must equal. */
export function workspaceVersion(base = root) {
  return readVersions(base)[0].version;
}

/**
 * Check every site, the tag if one was given, and the compatibility range.
 * Returns the problems rather than throwing, so all of them are reported at
 * once: a release engineer fixing one line at a time per CI run is a release
 * engineer who stops reading the output.
 */
export function checkVersions({ base = root, tag = "", compatibility } = {}) {
  const problems = [];
  const sites = readVersions(base);
  const expected = sites[0].version;
  try {
    parseVersion(expected);
  } catch {
    problems.push(`${sites[0].path} holds ${expected}, which is not a version`);
    return { version: expected, problems };
  }
  for (const site of sites.slice(1)) {
    if (site.version !== expected)
      problems.push(
        `${site.path} says ${site.version}, the workspace says ${expected}`,
      );
  }
  if (tag) {
    if (!tag.startsWith("v"))
      problems.push(`tag ${tag} does not start with "v"`);
    else if (tag.slice(1) !== expected)
      problems.push(`tag ${tag} does not name the version ${expected}`);
  }
  const range = compatibility ?? readCompatibility();
  if (compareVersions(range.minimumInstalled, expected) > 0) {
    problems.push(
      `compatibility.json accepts installs from ${range.minimumInstalled} upward, which excludes ${expected} itself`,
    );
  }
  if (
    range.maximumInstalled &&
    compareVersions(range.maximumInstalled, expected) >= 0
  ) {
    // A ceiling exists to stop an older line from offering this release to a
    // newer install. One at or above this version would refuse nothing.
    problems.push(
      `compatibility.json declares maximumInstalled ${range.maximumInstalled}, which does not exclude anything below ${expected}`,
    );
  }
  return { version: expected, problems };
}

/** Write a new version into every site. */
export function setVersion(next, base = root) {
  const version = parseVersion(next).text;
  const changed = [];
  for (const site of VERSION_SITES) {
    const file = base + site.path;
    const text = readFileSync(file, "utf8");
    const replaced = text.replace(
      pattern(site.kind),
      (_, head, current, tail) => {
        if (current !== version)
          changed.push(`${site.path}: ${current} -> ${version}`);
        return head + version + tail;
      },
    );
    if (replaced !== text) writeFileSync(file, replaced);
  }
  return { version, changed };
}

function main(argv) {
  const [mode, ...rest] = argv;
  if (mode === "print") {
    process.stdout.write(workspaceVersion() + "\n");
    return 0;
  }
  if (mode === "set") {
    const { version, changed } = setVersion(rest[0]);
    for (const line of changed) console.log(line);
    console.log(`Version is ${version}.`);
    return 0;
  }
  if (mode !== "check") {
    console.error("usage: node tools/release/version.mjs check|set|print");
    return 2;
  }
  const tagFlag = rest.indexOf("--tag");
  const tag =
    tagFlag >= 0
      ? (rest[tagFlag + 1] ?? "")
      : (process.env.GITHUB_REF_NAME ?? "");
  const { version, problems } = checkVersions({
    tag: tag.startsWith("v") ? tag : "",
  });
  for (const problem of problems) console.error(`✗ ${problem}`);
  if (problems.length > 0) {
    console.error(
      `\nRelease version check failed: ${problems.length} problem(s)`,
    );
    return 1;
  }
  console.log(
    `Version ${version} agrees across ${VERSION_SITES.length} files${tag ? ` and tag ${tag}` : ""}.`,
  );
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(process.argv.slice(2)));
}
