#!/usr/bin/env node
/**
 * Pins the managed browser for **this machine's** platform
 * (docs/design/remote-and-browser-completion.md §2.1).
 *
 * Why a script rather than a checked-in table: Chrome for Testing publishes no
 * digests. `last-known-good-versions-with-downloads.json` gives a version and a
 * URL per platform and nothing else, there is no sibling `.sha256`, and the
 * only checksums on the wire are the storage layer's own `x-goog-hash`
 * (crc32c + md5) — which come from the same host as the bytes and so verify
 * nothing an attacker on that host could not also forge. Verified against the
 * live endpoints on 2026-09-07.
 *
 * So the digest has to be *observed*: download once, hash the file, and write
 * what was seen into the manifest. Every later install on every machine is
 * then checked against that recorded digest. This script is how a person with
 * network access produces one entry; targets it cannot observe are left out
 * rather than guessed at, and the Runtime pins those on first download instead
 * (`launch/managed.rs`, trust on first use).
 *
 *   node tools/browser-manifest.mjs                # this platform, Stable
 *   node tools/browser-manifest.mjs --channel Beta
 *   node tools/browser-manifest.mjs --version 152.0.7977.82
 *   node tools/browser-manifest.mjs --print        # do not write the manifest
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = join(root, "apps/runtime/browser-manifest.json");
const ENDPOINT =
  "https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json";
const ALL_VERSIONS =
  "https://googlechromelabs.github.io/chrome-for-testing/known-good-versions-with-downloads.json";

/** Chrome for Testing's platform names, keyed the way the manifest keys are. */
const PLATFORMS = {
  "darwin-arm64": {
    key: "macos-arm64",
    cft: "mac-arm64",
    executable:
      "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
  },
  "darwin-x64": {
    key: "macos-x64",
    cft: "mac-x64",
    executable:
      "chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
  },
  "win32-x64": {
    key: "windows-x64",
    cft: "win64",
    executable: "chrome-win64/chrome.exe",
  },
  "linux-x64": {
    key: "linux-x64",
    cft: "linux64",
    executable: "chrome-linux64/chrome",
  },
};

function flag(name) {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
}

async function json(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return await response.json();
}

/** The download URL Chrome for Testing publishes for one platform. */
async function resolve(platform) {
  const wanted = flag("version");
  if (wanted) {
    const all = await json(ALL_VERSIONS);
    const entry = all.versions.findLast((item) => item.version === wanted);
    if (!entry) throw new Error(`no Chrome for Testing build ${wanted}`);
    return { version: entry.version, downloads: entry.downloads };
  }
  const channel = flag("channel") ?? "Stable";
  const known = await json(ENDPOINT);
  const entry = known.channels[channel];
  if (!entry) throw new Error(`no channel named ${channel}`);
  return { version: entry.version, downloads: entry.downloads };
}

/**
 * Streams the archive to a scratch file, hashing as it goes. The digest covers
 * the bytes that were written, which is the same rule `launch/managed.rs`
 * applies when it later checks them.
 */
async function download(url, into) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  const hash = createHash("sha256");
  let bytes = 0;
  const file = await open(into, "w");
  try {
    await pipeline(
      Readable.fromWeb(response.body),
      async function* (chunks) {
        for await (const chunk of chunks) {
          hash.update(chunk);
          bytes += chunk.length;
          yield chunk;
        }
      },
      file.createWriteStream(),
    );
  } finally {
    await file.close();
  }
  return { sha256: hash.digest("hex"), bytes };
}

/**
 * Confirms the executable really is at the path the manifest will claim.
 * A manifest that names a path the archive does not contain fails every
 * install with `archive_layout`, and it would fail it *after* a 180 MB
 * download — worth one `unzip -Z1` here.
 */
function locate(archive, expected) {
  let listing;
  try {
    listing = execFileSync("unzip", ["-Z1", archive], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    console.warn(
      "warning: no usable `unzip`, so the executable path was not checked against the archive",
    );
    return expected;
  }
  const entries = listing.split("\n");
  if (entries.includes(expected)) return expected;
  throw new Error(
    `the archive has no \`${expected}\`; its first entries are ${entries.slice(0, 5).join(", ")}`,
  );
}

const platform = PLATFORMS[`${process.platform}-${process.arch}`];
if (!platform) {
  console.error(
    `This script pins the platform it runs on, and ${process.platform}-${process.arch} is not one Chrome for Testing publishes.`,
  );
  process.exit(1);
}

const { version, downloads } = await resolve(platform);
const download_ = (downloads.chrome ?? []).find(
  (item) => item.platform === platform.cft,
);
if (!download_) {
  console.error(`Chrome for Testing ${version} has no ${platform.cft} build.`);
  process.exit(1);
}

const scratch = mkdtempSync(join(tmpdir(), "armadra-cft-"));
const archive = join(scratch, "chrome.zip");
let observed;
try {
  console.log(`downloading ${download_.url}`);
  observed = await download(download_.url, archive);
  console.log(`  ${observed.bytes} bytes, sha256 ${observed.sha256}`);
  observed.executable = locate(archive, platform.executable);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
// One manifest pins one version, and every URL in it belongs to that version.
// Keeping another platform's entry across a version bump would point it at an
// archive that no longer exists.
if (manifest.version !== version && Object.keys(manifest.targets).length > 0) {
  console.warn(
    `warning: dropping targets pinned for ${manifest.version}; re-run this on each platform to pin ${version}`,
  );
  manifest.targets = {};
}
manifest.version = version;
manifest.targets[platform.key] = {
  url: download_.url,
  sha256: observed.sha256,
  bytes: observed.bytes,
  executable: observed.executable,
  // When this digest was observed, and by what. It is the only provenance
  // there is: the publisher does not sign or hash these archives.
  pinnedAt: new Date().toISOString().slice(0, 10),
};

const text = `${JSON.stringify(manifest, null, 2)}\n`;
if (process.argv.includes("--print")) {
  process.stdout.write(text);
} else {
  writeFileSync(MANIFEST, text);
  console.log(`pinned ${platform.key} in apps/runtime/browser-manifest.json`);
}
