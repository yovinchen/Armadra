import { strict as assert } from "node:assert";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { TARGETS } from "./artifacts.mjs";
import {
  parseChecksums,
  sha256,
  verifyChecksums,
  writeChecksums,
} from "./checksums.mjs";
import { generateKey, publicKeyFile, secretFromKey } from "./minisign.mjs";
import { signDirectory, signableFiles, verifyDirectory } from "./sign.mjs";
import { startMockReleaseServer } from "./mock-release-server.mjs";
import {
  buildManifest,
  platformKey,
  writeManifest,
} from "./updater-manifest.mjs";
import { auditRelease, stageAssets } from "./dry-run.mjs";
import {
  extractFence,
  readCompatibility,
  releaseNote,
} from "./compatibility.mjs";
import {
  locateBinary,
  packageComponents,
  zipCommand,
} from "./package-components.mjs";
import { assemble } from "./assemble.mjs";

function scratch() {
  return mkdtempSync(join(tmpdir(), "armadra-assemble-"));
}

test("the checksum list covers every publishable file and nothing else", async () => {
  const directory = scratch();
  try {
    stageAssets({ directory, version: "0.2.0" });
    const { entries, content } = await writeChecksums(directory);
    const digests = parseChecksums(content);
    assert.equal(digests.size, entries);
    // A signature is checked by the key, and the list cannot hold its own
    // digest, so neither belongs in it.
    for (const name of digests.keys()) {
      assert.ok(!name.endsWith(".sig"), name);
      assert.notEqual(name, "SHA256SUMS");
    }
    assert.deepEqual(await verifyChecksums(directory), []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a file changed after the list was written fails verification", async () => {
  const directory = scratch();
  try {
    stageAssets({ directory, version: "0.2.0" });
    await writeChecksums(directory);
    const victim = join(directory, "armadra-host_0.2.0_linux-x86_64.tar.gz");
    writeFileSync(victim, "swapped\n");
    const problems = await verifyChecksums(directory);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /does not match its listed digest/);

    writeFileSync(
      join(directory, "extra_0.2.0_linux-x86_64.tar.gz"),
      "extra\n",
    );
    assert.ok(
      (await verifyChecksums(directory)).some((problem) =>
        /not listed in SHA256SUMS/.test(problem),
      ),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("signing covers the checksum list too", async () => {
  const directory = scratch();
  try {
    stageAssets({ directory, version: "0.2.0" });
    await writeChecksums(directory);
    const key = generateKey();
    const signed = signDirectory({ directory, key, version: "0.2.0" });
    assert.ok(
      signed.includes("SHA256SUMS"),
      "an unsigned list can be rewritten to match a swap",
    );
    assert.deepEqual(signed.sort(), signableFiles(directory).sort());
    const { problems, verified } = verifyDirectory({
      directory,
      publicKeyText: publicKeyFile(key),
    });
    assert.deepEqual(problems, []);
    assert.equal(verified.length, signed.length);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a signature moved onto another artifact is refused", async () => {
  const directory = scratch();
  try {
    stageAssets({ directory, version: "0.2.0" });
    await writeChecksums(directory);
    const key = generateKey();
    signDirectory({ directory, key, version: "0.2.0" });
    const from = "armadra-host_0.2.0_linux-x86_64.tar.gz";
    const onto = "armadra-hook_0.2.0_linux-x86_64.tar.gz";
    // Same key, valid signature, wrong file: only the trusted comment ties the
    // two together, so this must fail on the comment rather than the bytes.
    writeFileSync(
      join(directory, `${onto}.sig`),
      readFileSync(join(directory, `${from}.sig`)),
    );
    const { problems } = verifyDirectory({
      directory,
      publicKeyText: publicKeyFile(key),
    });
    assert.equal(problems.length, 1);
    assert.match(problems[0], new RegExp(`^${onto}: signature`));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("latest.json holds one signed entry per platform and nothing a package manager owns", () => {
  const directory = scratch();
  try {
    stageAssets({ directory, version: "0.2.0" });
    const { manifest, skipped } = writeManifest({
      directory,
      version: "0.2.0",
      notes: "Fixes.",
      targets: TARGETS,
      downloadUrl: (name) => `https://example.invalid/${name}`,
    });
    assert.deepEqual(skipped, []);
    assert.deepEqual(
      Object.keys(manifest.platforms).sort(),
      [...TARGETS].sort(),
    );
    for (const [key, entry] of Object.entries(manifest.platforms)) {
      assert.ok(entry.signature.length > 0, key);
      assert.ok(
        !/\.(deb|rpm|msi|dmg)$/.test(entry.url),
        `${key} offers ${entry.url}`,
      );
    }
    assert.equal(platformKey("darwin-aarch64"), "darwin-aarch64");
    assert.throws(() => platformKey("plan9-mips"), /no updater platform/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// An unsigned bundle in the manifest is an offer to install whatever the
// endpoint serves. It is left out with a reason instead.
test("a bundle with no signature is left out of latest.json", () => {
  const directory = scratch();
  try {
    stageAssets({ directory, version: "0.2.0" });
    rmSync(join(directory, "Armadra_0.2.0_linux-x86_64.AppImage.sig"));
    const { manifest, skipped } = buildManifest({
      directory,
      version: "0.2.0",
      notes: "",
      targets: TARGETS,
      downloadUrl: (name) => `https://example.invalid/${name}`,
    });
    assert.deepEqual(skipped, [
      {
        target: "linux-x86_64",
        asset: "Armadra_0.2.0_linux-x86_64.AppImage",
        reason: "signatureMissing",
      },
    ]);
    assert.ok(!manifest.platforms["linux-x86_64"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the audit catches a hole the individual steps would each pass", async () => {
  const directory = scratch();
  try {
    stageAssets({ directory, version: "0.2.0" });
    writeManifest({
      directory,
      version: "0.2.0",
      notes: "",
      targets: TARGETS,
      downloadUrl: (name) => `https://example.invalid/${name}`,
    });
    await writeChecksums(directory);
    const key = generateKey();
    signDirectory({ directory, key, version: "0.2.0" });
    assert.deepEqual(
      await auditRelease({
        directory,
        version: "0.2.0",
        publicKeyText: publicKeyFile(key),
      }),
      [],
    );
    // An asset nobody can place is a file that will never be offered, however
    // correct its bytes and its signature are.
    writeFileSync(join(directory, "leftover.txt"), "notes\n");
    await writeChecksums(directory);
    signDirectory({ directory, key, version: "0.2.0" });
    const problems = await auditRelease({
      directory,
      version: "0.2.0",
      publicKeyText: publicKeyFile(key),
    });
    assert.ok(
      problems.some((problem) =>
        /leftover\.txt declares no component/.test(problem),
      ),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the mock release server answers the shape the Host reads", async () => {
  const directory = scratch();
  try {
    stageAssets({ directory, version: "0.2.0" });
    await writeChecksums(directory);
    signDirectory({ directory, key: generateKey(), version: "0.2.0" });
    const note = releaseNote({
      version: "0.2.0",
      notes: "Fixes.",
      compatibility: readCompatibility(),
    });
    const server = await startMockReleaseServer({
      releases: [
        { directory, tag: "v0.2.0", body: note },
        { directory, tag: "v0.3.0", body: note, draft: true },
        { directory, tag: "v0.4.0-beta.1", body: note, prerelease: true },
      ],
    });
    try {
      const index = await (await fetch(`${server.source}/releases`)).json();
      assert.equal(index.length, 3);
      // A draft is served exactly as GitHub serves it: visible to the API and
      // skipped by the Host, so the "not published yet" path is a real path.
      assert.equal(
        index.find((release) => release.tag_name === "v0.3.0").draft,
        true,
      );
      assert.equal(
        index.find((release) => release.tag_name === "v0.4.0-beta.1")
          .prerelease,
        true,
      );
      const asset = index[0].assets.find(
        (entry) => entry.name === "SHA256SUMS",
      );
      assert.match(asset.digest, /^sha256:[0-9a-f]{64}$/);
      assert.equal(
        asset.digest,
        `sha256:${await sha256(join(directory, "SHA256SUMS"))}`,
      );
      assert.ok(
        index[0].assets.some((entry) => entry.name === "SHA256SUMS.sig"),
      );
      const body = Buffer.from(
        await (await fetch(asset.browser_download_url)).arrayBuffer(),
      );
      assert.deepEqual(body, readFileSync(join(directory, "SHA256SUMS")));
    } finally {
      await server.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the mock server can produce the failures a real host produces", async () => {
  const directory = scratch();
  try {
    stageAssets({ directory, version: "0.2.0" });
    await writeChecksums(directory);
    const name = "armadra-host_0.2.0_linux-x86_64.tar.gz";
    const original = readFileSync(join(directory, name));

    const unreachable = await startMockReleaseServer({
      releases: [],
      faults: { status: 503 },
    });
    const refused = await fetch(`${unreachable.source}/releases`);
    assert.equal(refused.status, 503);
    await refused.text();
    await unreachable.close();

    const malformed = await startMockReleaseServer({
      releases: [],
      faults: { malformed: true },
    });
    // A body that is not the shape the Host expects is an unusable source, not
    // an empty list of releases.
    assert.equal(
      await (await fetch(`${malformed.source}/releases`)).text(),
      "not json",
    );
    await malformed.close();

    const corrupt = await startMockReleaseServer({
      releases: [{ directory, tag: "v0.2.0", body: "" }],
      faults: { corrupt: name },
    });
    const served = Buffer.from(
      await (
        await fetch(`${corrupt.base}/download/v0.2.0/${name}`)
      ).arrayBuffer(),
    );
    // The length still matches, so only a digest or a signature can catch it.
    assert.equal(served.length, original.length);
    assert.notDeepEqual(served, original);
    await corrupt.close();

    const truncated = await startMockReleaseServer({
      releases: [{ directory, tag: "v0.2.0", body: "" }],
      faults: { truncate: name },
    });
    // The socket is dropped mid-body, so the download is an error rather than
    // a short success: a reader that returned the bytes it got would install
    // half a binary.
    await assert.rejects(async () => {
      const short = await fetch(`${truncated.base}/download/v0.2.0/${name}`);
      assert.equal(
        short.headers.get("content-length"),
        String(original.length),
      );
      await short.arrayBuffer();
    });
    await truncated.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("packaging finds a binary under either name and reports what was not built", () => {
  const from = scratch();
  const out = scratch();
  try {
    writeFileSync(join(from, "armadra-host"), "host\n");
    writeFileSync(
      join(from, "armadra-runtime-x86_64-unknown-linux-gnu"),
      "worker\n",
    );
    assert.ok(
      locateBinary({ from, binary: "armadra-host", target: "linux-x86_64" }),
    );
    assert.ok(
      locateBinary({
        from,
        binary: "armadra-runtime",
        target: "linux-x86_64",
        triple: "x86_64-unknown-linux-gnu",
      }),
    );
    const { packed, missing } = packageComponents({
      target: "linux-x86_64",
      from,
      out,
      version: "0.2.0",
      triple: "x86_64-unknown-linux-gnu",
    });
    assert.deepEqual(packed.map((entry) => entry.asset).sort(), [
      "armadra-host_0.2.0_linux-x86_64.tar.gz",
      "armadra-runtime_0.2.0_linux-x86_64.tar.gz",
    ]);
    // A component this target should publish but nobody built is a hole in the
    // release, reported now rather than by a client that cannot upgrade.
    assert.deepEqual(missing, ["armadra-hook"]);
  } finally {
    rmSync(from, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});

test("assembling produces a signed, checksummed, manifested release", async () => {
  const directory = scratch();
  try {
    stageAssets({ directory, version: "0.2.0" });
    const key = generateKey();
    const result = await assemble({
      directory,
      version: "0.2.0",
      repo: "yovinchen/Armadra",
      tag: "v0.2.0",
      notes: "Fixes.",
      secret: secretFromKey(key),
    });
    assert.deepEqual(result.problems, []);
    assert.deepEqual(result.missing, []);
    assert.ok(result.signed.includes("SHA256SUMS"));
    assert.deepEqual(extractFence(result.note), readCompatibility());
    for (const entry of Object.values(result.manifest.platforms)) {
      assert.match(
        entry.url,
        /^https:\/\/github\.com\/yovinchen\/Armadra\/releases\/download\/v0\.2\.0\//,
      );
    }
    assert.deepEqual(await verifyChecksums(directory), []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// A release that could not be signed must look unsigned. The note says so, and
// no .sig is left behind that a reader could mistake for one.
test("no signing key produces a release that admits it is unsigned", async () => {
  const directory = scratch();
  try {
    stageAssets({ directory, version: "0.2.0" });
    const result = await assemble({
      directory,
      version: "0.2.0",
      repo: "yovinchen/Armadra",
      tag: "v0.2.0",
      secret: "",
    });
    assert.deepEqual(result.signed, []);
    assert.match(result.note, /no signing key/);
    assert.ok(!readdirSync(directory).includes("SHA256SUMS.sig"));
    assert.deepEqual(result.problems, []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// A build without a Tauri signing key writes no .sig at all. That release
// cannot update itself, and says so; it is not a failed assembly. The bundles
// are still there for a manual install, and latest.json offers nothing.
test("no updater signature anywhere is an admitted unsigned release, not a hole", async () => {
  const directory = scratch();
  try {
    stageAssets({ directory, version: "0.2.0" });
    for (const name of readdirSync(directory)) {
      if (name.endsWith(".sig")) rmSync(join(directory, name));
    }
    const result = await assemble({
      directory,
      version: "0.2.0",
      repo: "yovinchen/Armadra",
      tag: "v0.2.0",
      secret: "",
    });
    assert.deepEqual(result.problems, []);
    assert.deepEqual(Object.keys(result.manifest.platforms), []);
    assert.deepEqual(result.missing, TARGETS);
    assert.match(
      result.note,
      /desktop updater packages \(no Tauri signing key\)/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a target with no updater bundle is a reported hole, not a silent one", async () => {
  const directory = scratch();
  try {
    stageAssets({ directory, version: "0.2.0" });
    rmSync(join(directory, "Armadra_0.2.0_windows-aarch64-setup.exe.sig"));
    const result = await assemble({
      directory,
      version: "0.2.0",
      repo: "yovinchen/Armadra",
      tag: "v0.2.0",
      secret: secretFromKey(generateKey()),
    });
    assert.deepEqual(result.missing, ["windows-aarch64"]);
    assert.ok(
      result.problems.some((problem) =>
        /windows-aarch64: signatureMissing/.test(problem),
      ),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an unplaceable file fails assembly", async () => {
  const directory = scratch();
  try {
    stageAssets({ directory, version: "0.2.0" });
    writeFileSync(join(directory, "notes.txt"), "hello\n");
    const result = await assemble({
      directory,
      version: "0.2.0",
      repo: "yovinchen/Armadra",
      tag: "v0.2.0",
      secret: secretFromKey(generateKey()),
    });
    assert.ok(
      result.problems.some((problem) =>
        /notes\.txt declares no component/.test(problem),
      ),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// Windows components are .zip, and `zip` is not on every Windows runner's
// PATH. Falling back to the 7-Zip that is there beats a release that fails at
// the packaging step with "zip: command not found".
test("the zip archiver falls back to 7-Zip and refuses to guess", () => {
  assert.deepEqual(zipCommand((name) => name === "zip").command, "zip");
  assert.deepEqual(zipCommand((name) => name === "7z").command, "7z");
  assert.deepEqual(zipCommand((name) => name === "7zz").command, "7zz");
  // Preference order: zip first, whatever else is also installed.
  assert.equal(zipCommand(() => true).command, "zip");
  assert.deepEqual(zipCommand(() => true).argv("out.zip", "inner"), [
    "-q",
    "-X",
    "-j",
    "out.zip",
    "inner",
  ]);
  assert.deepEqual(zipCommand((name) => name === "7z").argv("out.zip", "in"), [
    "a",
    "-tzip",
    "-bso0",
    "-bse0",
    "out.zip",
    "in",
  ]);
  assert.throws(() => zipCommand(() => false), /No zip archiver found/);
});
