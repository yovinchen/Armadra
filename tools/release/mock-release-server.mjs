/**
 * A GitHub Releases API and download host, served from a local directory.
 *
 * The whole update path — the Host's check, its download, its signature
 * verification, and the shell's manifest fetch — can then be exercised without
 * reaching GitHub. A test that needs the network is a test that stops testing
 * when the network is down, and a release pipeline is exactly the thing one
 * cannot afford to leave untested until the day it runs for real.
 *
 * It binds loopback on an ephemeral port. The Host accepts a plain-HTTP
 * release source only on loopback, which is what makes this usable without
 * inventing a certificate.
 */
import { createReadStream, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { publishableFiles } from "./checksums.mjs";
import { sha256 } from "./checksums.mjs";

/**
 * Describe one release the way GitHub's API does, from a directory of assets.
 *
 * `digest` is the field the Host reads for a sha256; GitHub reports it as
 * "sha256:<hex>", and the Host ignores anything else.
 */
export async function describeRelease({
  directory,
  tag,
  body,
  draft = false,
  prerelease = false,
  base,
}) {
  const assets = [];
  for (const name of publishableFiles(directory).concat("SHA256SUMS")) {
    let info;
    try {
      info = statSync(join(directory, name));
    } catch {
      continue;
    }
    assets.push({
      name,
      browser_download_url: `${base}/download/${tag}/${encodeURIComponent(name)}`,
      size: info.size,
      digest: `sha256:${await sha256(join(directory, name))}`,
    });
    try {
      const signature = statSync(join(directory, `${name}.sig`));
      assets.push({
        name: `${name}.sig`,
        browser_download_url: `${base}/download/${tag}/${encodeURIComponent(name)}.sig`,
        size: signature.size,
        digest: `sha256:${await sha256(join(directory, `${name}.sig`))}`,
      });
    } catch {
      // An unsigned asset is published as unsigned; the Host reports the
      // signature as ABSENT rather than being told one exists.
    }
  }
  return {
    tag_name: tag,
    draft,
    prerelease,
    published_at: new Date(1_770_000_000_000).toISOString(),
    html_url: `${base}/releases/${tag}`,
    body,
    assets,
  };
}

/**
 * Start the server. `releases` is a list of `{ directory, tag, body, draft,
 * prerelease }`; the newest is whichever tag sorts highest, which the Host
 * decides for itself.
 *
 * `faults` lets a test ask for the failures a real host produces: `status` to
 * answer the index with an error code, `truncate` to cut a download short, and
 * `corrupt` to flip a byte so a digest check has something to catch.
 */
export async function startMockReleaseServer({
  releases,
  faults = {},
  owner = "armadra",
  repo = "armadra",
}) {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const documents = [];
  for (const release of releases) {
    documents.push(await describeRelease({ ...release, base }));
  }
  const byTag = new Map(
    releases.map((release) => [release.tag, release.directory]),
  );
  const requests = [];

  server.on("request", (request, response) => {
    requests.push(request.url);
    const url = new URL(request.url, base);
    if (url.pathname === `/repos/${owner}/${repo}/releases`) {
      if (faults.status) {
        response.writeHead(faults.status).end("release index is unavailable");
        return;
      }
      if (faults.malformed) {
        response
          .writeHead(200, { "content-type": "application/json" })
          .end("not json");
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      // Drafts are served exactly as GitHub does — visible to the API, and
      // skipped by the Host — so the "not published yet" path is real.
      response.end(JSON.stringify(documents));
      return;
    }
    const download = /^\/download\/([^/]+)\/(.+)$/.exec(url.pathname);
    if (download) {
      const directory = byTag.get(decodeURIComponent(download[1]));
      const name = decodeURIComponent(download[2]);
      if (!directory) {
        response.writeHead(404).end("no such release");
        return;
      }
      let info;
      try {
        info = statSync(join(directory, name));
      } catch {
        response.writeHead(404).end("no such asset");
        return;
      }
      if (faults.corrupt === name) {
        const bytes = Buffer.from(readFileSync(join(directory, name)));
        // One flipped byte: the size still matches, so only the digest and the
        // signature can catch it. That is the point of having both.
        bytes[0] ^= 0xff;
        response
          .writeHead(200, { "content-length": String(bytes.length) })
          .end(bytes);
        return;
      }
      if (faults.truncate === name) {
        // Promise the full length, deliver half, then drop the socket: that is
        // what a download interrupted mid-flight looks like to a client, and
        // it is the case a resumable-looking reader would get wrong.
        response.writeHead(200, { "content-length": String(info.size) });
        const partial = readFileSync(join(directory, name)).subarray(
          0,
          Math.floor(info.size / 2),
        );
        // Destroy only once the partial body has been flushed, so the client
        // sees a body that stops early rather than a connection that never
        // produced one.
        response.write(partial, () => response.destroy());
        return;
      }
      response.writeHead(200, { "content-length": String(info.size) });
      createReadStream(join(directory, name)).pipe(response);
      return;
    }
    response.writeHead(404).end("not found");
  });

  return {
    base,
    /** The value an operator would pass to --updates-source. */
    source: `${base}/repos/${owner}/${repo}`,
    requests,
    async close() {
      // Node's fetch keeps its sockets alive, so close() alone would wait for
      // a client that has no intention of hanging up. A test server outlives
      // nothing: drop the connections, then wait for the listener.
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [directory, tag = "v0.0.0", notePath] = process.argv.slice(2);
  if (!directory || !notePath) {
    console.error(
      "usage: node tools/release/mock-release-server.mjs <asset dir> <tag> <release note file>",
    );
    process.exit(2);
  }
  const server = await startMockReleaseServer({
    releases: [{ directory, tag, body: readFileSync(notePath, "utf8") }],
  });
  console.log(`Serving ${directory} as ${tag}`);
  console.log(`--updates-source ${server.source}`);
}
