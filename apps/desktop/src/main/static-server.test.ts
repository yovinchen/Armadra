import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type PageSource,
  contentTypeFor,
  hostHeaderAllowed,
  resolveWithinRoot,
  startPageSource,
  startStaticServer,
} from "./static-server";

/**
 * The page's origin, and the three things a loopback static server has to get
 * right before it is allowed to serve the shell's own bundle: it may not leave
 * its root, it may not answer to a name it was not bound as, and it must send
 * the page's policy with the document.
 */

const directories: string[] = [];
const servers: PageSource[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const path of directories.splice(0))
    rmSync(path, { recursive: true, force: true });
});

function bundle(): string {
  const root = mkdtempSync(join(tmpdir(), "armadra-static-"));
  directories.push(root);
  writeFileSync(join(root, "index.html"), "<!doctype html><title>app</title>");
  mkdirSync(join(root, "assets"));
  writeFileSync(join(root, "assets", "app.js"), "export const x = 1;\n");
  return root;
}

async function serving(root: string): Promise<PageSource> {
  const server = await startStaticServer(root);
  servers.push(server);
  return server;
}

/**
 * One raw HTTP/1.1 request, because `fetch` normalizes `..` out of a path and
 * refuses to set `Host` — the two things these checks are about.
 */
function raw(
  origin: string,
  path: string,
  host?: string,
): Promise<{ status: number; body: string }> {
  const url = new URL(origin);
  return new Promise((done, fail) => {
    const socket = connect(Number(url.port), url.hostname, () => {
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: ${host ?? url.host}\r\nConnection: close\r\n\r\n`,
      );
    });
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("error", fail);
    socket.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      done({
        status: Number(/^HTTP\/1\.[01] (\d{3})/.exec(text)?.[1] ?? 0),
        body: text,
      });
    });
  });
}

describe("staying inside the root", () => {
  it("never resolves outside the root, whatever the spelling", () => {
    const root = "/srv/app";
    expect(resolveWithinRoot(root, "/index.html")).toBe("/srv/app/index.html");
    expect(resolveWithinRoot(root, "/assets/../index.html")).toBe(
      "/srv/app/index.html",
    );
    // The invariant is one sentence: every answer is either refused, or a
    // path under the root. Which of the two a given spelling gets is the
    // platform's business; leaving the root is nobody's.
    for (const spelling of [
      "/../secrets",
      "/../../etc/passwd",
      "/%2e%2e/secrets",
      "/%2e%2e%2f%2e%2e%2fetc/passwd",
      "/assets/../../secrets",
      "/\0/etc/passwd",
      "/%zz",
      // A prefix match on the string alone would accept this sibling.
      "/../app-other/secrets",
      "/....//secrets",
    ]) {
      const resolved = resolveWithinRoot(root, spelling);
      if (resolved === undefined) continue;
      expect(resolved.startsWith(`${root}/`), spelling).toBe(true);
    }
    // A NUL byte and a malformed escape are refused outright rather than
    // handed to the file system to interpret.
    expect(resolveWithinRoot(root, "/\0/etc/passwd")).toBeUndefined();
    expect(resolveWithinRoot(root, "/%zz")).toBeUndefined();
  });

  it("does not serve a file outside the root over HTTP either", async () => {
    const root = bundle();
    const outside = mkdtempSync(join(tmpdir(), "armadra-outside-"));
    directories.push(outside);
    writeFileSync(join(outside, "secret.txt"), "private");
    const page = await serving(root);
    // Raw, because `fetch` normalizes `..` away before the server ever sees
    // it — and an attacker would not be using `fetch`.
    for (const path of [
      `/..${join(outside, "secret.txt")}`,
      `/%2e%2e${join(outside, "secret.txt")}`,
      "/../../../../../../etc/hosts",
    ]) {
      // What comes back is either a refusal or the application's own
      // document (an unknown path with no extension is a route); what never
      // comes back is a file from outside the root.
      const answer = await raw(page.origin, path);
      expect(answer.body, path).not.toContain("private");
      expect(answer.body, path).not.toContain("127.0.0.1\t");
      if (answer.status === 200)
        expect(answer.body, path).toContain("<title>app</title>");
    }
  });
});

describe("the served bundle", () => {
  it("answers the document, its assets, and its routes", async () => {
    const page = await serving(bundle());
    expect(page.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(page.served).toBe(true);

    const index = await fetch(page.url);
    expect(index.status).toBe(200);
    expect(index.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await index.text()).toContain("<title>app</title>");

    const asset = await fetch(`${page.origin}/assets/app.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toBe(
      "text/javascript; charset=utf-8",
    );

    // apps/web is a single-page application: a route is the document.
    const route = await fetch(`${page.origin}/workspace/one`);
    expect(route.status).toBe(200);
    expect(await route.text()).toContain("<title>app</title>");

    // A missing ASSET stays missing: answering it with HTML would hand the
    // page a document where it asked for a script, which fails later and
    // somewhere else.
    expect((await fetch(`${page.origin}/assets/gone.js`)).status).toBe(404);
  });

  it("sends the page's policy and refuses to be written to", async () => {
    const page = await serving(bundle());
    const response = await fetch(page.url);
    const policy = response.headers.get("content-security-policy") ?? "";
    expect(policy).toContain("default-src 'self'");
    expect(policy).toContain("ws://127.0.0.1:*");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");

    const written = await fetch(page.url, { method: "POST" });
    expect(written.status).toBe(405);
  });

  it("answers only to the name it was bound as", async () => {
    const page = await serving(bundle());
    const port = Number(new URL(page.origin).port);
    expect(hostHeaderAllowed(`127.0.0.1:${port}`, port)).toBe(true);
    expect(hostHeaderAllowed(`localhost:${port}`, port)).toBe(true);
    // A public page can point a DNS name at 127.0.0.1 and have the user's own
    // browser fetch this port; the name it sends is what gives it away.
    expect(hostHeaderAllowed(`attacker.example:${port}`, port)).toBe(false);
    expect(hostHeaderAllowed("127.0.0.1:1", port)).toBe(false);
    expect(hostHeaderAllowed(undefined, port)).toBe(false);

    expect((await raw(page.origin, "/")).status).toBe(200);
    expect(
      (await raw(page.origin, "/", `attacker.example:${port}`)).status,
    ).toBe(421);
  });

  it("stops listening when it is closed", async () => {
    const page = await startStaticServer(bundle());
    expect((await fetch(page.url)).status).toBe(200);
    await page.close();
    await expect(fetch(page.url)).rejects.toThrow();
  });
});

describe("one origin for both modes", () => {
  it("uses the dev server's origin while developing and its own once packaged", async () => {
    const dev = await startPageSource("http://127.0.0.1:1420", false, "/nope");
    expect(dev).toMatchObject({
      origin: "http://127.0.0.1:1420",
      url: "http://127.0.0.1:1420",
      served: false,
    });

    const packaged = await serving(bundle());
    expect(packaged.url.startsWith(packaged.origin)).toBe(true);
    // Whoever serves it, the origin is a real HTTP origin — never `file:`,
    // which nothing can be granted to (§2.1).
    for (const source of [dev, packaged]) {
      expect(new URL(source.origin).protocol).toBe("http:");
    }
  });
});

describe("content types", () => {
  it("names what apps/web ships and refuses to guess at the rest", () => {
    expect(contentTypeFor("/index.html")).toBe("text/html; charset=utf-8");
    expect(contentTypeFor("/a/b.WOFF2")).toBe("font/woff2");
    expect(contentTypeFor("/x.wasm")).toBe("application/wasm");
    expect(contentTypeFor("/LICENSE")).toBe("application/octet-stream");
  });
});
