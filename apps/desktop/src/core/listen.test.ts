import { createServer } from "node:http";
import { statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer as createSocketServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ListenSpec,
  bind,
  formatListenSpec,
  parseListenSpec,
  release,
  tcpAuthority,
} from "./listen";
import { tempDir } from "./testing/temp-dir";

const closing: (() => void)[] = [];

afterEach(() => {
  for (const close of closing.splice(0)) close();
});

function server(): ReturnType<typeof createServer> {
  const created = createServer();
  closing.push(() => created.close());
  return created;
}

function temporary(): string {
  return tempDir("armadra-listen-");
}

describe("--listen spec parsing", () => {
  it("parses every transport on every platform", () => {
    expect(parseListenSpec("tcp:127.0.0.1:0")).toEqual({
      ok: true,
      spec: { kind: "tcp", host: "127.0.0.1", port: 0 },
    });
    expect(parseListenSpec("unix:/tmp/armadra/runtime.sock")).toEqual({
      ok: true,
      spec: { kind: "unix", path: "/tmp/armadra/runtime.sock" },
    });
    expect(parseListenSpec("pipe:armadra-runtime.42")).toEqual({
      ok: true,
      spec: { kind: "pipe", name: "armadra-runtime.42" },
    });
  });

  it("takes a bare address as the TCP shorthand, whitespace and all", () => {
    expect(parseListenSpec(" 127.0.0.1:9 ")).toEqual({
      ok: true,
      spec: { kind: "tcp", host: "127.0.0.1", port: 9 },
    });
  });

  it("accepts a bracketed IPv6 literal", () => {
    expect(parseListenSpec("tcp:[::1]:8080")).toEqual({
      ok: true,
      spec: { kind: "tcp", host: "[::1]", port: 8080 },
    });
  });

  it("round trips through its display form", () => {
    for (const spec of [
      "tcp:127.0.0.1:43119",
      "unix:/tmp/armadra/runtime.sock",
      "pipe:armadra-runtime",
    ]) {
      const parsed = parseListenSpec(spec);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(formatListenSpec(parsed.spec)).toBe(spec);
      expect(parseListenSpec(formatListenSpec(parsed.spec))).toEqual(parsed);
    }
  });

  it("refuses addresses that could escape their namespace", () => {
    for (const spec of [
      "unix:relative/runtime.sock",
      "unix:",
      "pipe:..\\..\\windows",
      "pipe:with space",
      "pipe:",
      "pipe:/etc/passwd",
      "tcp:localhost:1",
      "tcp:127.0.0.1",
      "https://127.0.0.1:1",
      "",
    ]) {
      expect(parseListenSpec(spec).ok, spec).toBe(false);
    }
  });

  it("caps a pipe name at 200 characters", () => {
    expect(parseListenSpec(`pipe:${"a".repeat(200)}`).ok).toBe(true);
    expect(parseListenSpec(`pipe:${"a".repeat(201)}`).ok).toBe(false);
  });

  it("refuses a port outside the range", () => {
    expect(parseListenSpec("tcp:127.0.0.1:65536").ok).toBe(false);
    expect(parseListenSpec("tcp:127.0.0.1:-1").ok).toBe(false);
    expect(parseListenSpec("tcp:127.0.0.1:").ok).toBe(false);
    expect(parseListenSpec("tcp:127.0.0.1:65535").ok).toBe(true);
  });

  it("refuses an octet outside the range rather than reading it as a name", () => {
    expect(parseListenSpec("tcp:999.0.0.1:1").ok).toBe(false);
    expect(parseListenSpec("tcp:127.0.0:1").ok).toBe(false);
  });

  it("names the TCP authority and nothing else", () => {
    expect(tcpAuthority({ kind: "tcp", host: "127.0.0.1", port: 8 })).toBe(
      "127.0.0.1:8",
    );
    expect(tcpAuthority({ kind: "unix", path: "/x.sock" })).toBeUndefined();
  });
});

describe("binding", () => {
  it("reports the port the kernel chose", async () => {
    const bound = await bind(server(), {
      kind: "tcp",
      host: "127.0.0.1",
      port: 0,
    });
    expect(bound.kind).toBe("tcp");
    expect(bound.kind === "tcp" && bound.port).toBeGreaterThan(0);
  });

  it("refuses a taken port rather than moving to a different one", async () => {
    const held = server();
    const bound = await bind(held, { kind: "tcp", host: "127.0.0.1", port: 0 });
    const port = bound.kind === "tcp" ? bound.port : 0;
    await expect(
      bind(server(), { kind: "tcp", host: "127.0.0.1", port }),
    ).rejects.toThrow(/already in use/);
  });

  it.skipIf(process.platform === "win32")(
    "creates a private socket in a private directory and reports no port",
    async () => {
      const path = join(temporary(), "nested", "runtime.sock");
      const bound = await bind(server(), { kind: "unix", path });
      expect(bound).toEqual({ kind: "unix", path });
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(join(path, "..")).mode & 0o777).toBe(0o700);
    },
  );

  it.skipIf(process.platform === "win32")(
    "never steals a socket from a core that is listening on it",
    async () => {
      const path = join(temporary(), "runtime.sock");
      await bind(server(), { kind: "unix", path });
      await expect(bind(server(), { kind: "unix", path })).rejects.toThrow(
        /already listening/,
      );
    },
  );

  it.skipIf(process.platform === "win32")(
    "replaces a stale socket but never a regular file",
    async () => {
      const directory = temporary();
      const path = join(directory, "runtime.sock");
      const dead = createSocketServer();
      await new Promise<void>((done) => dead.listen(path, () => done()));
      await new Promise<void>((done) => dead.close(() => done()));
      // The inode survives the listener; binding it again must succeed.
      const bound = await bind(server(), { kind: "unix", path });
      expect(bound).toEqual({ kind: "unix", path });

      const occupied = join(directory, "not-a-socket");
      writeFileSync(occupied, "important");
      await expect(
        bind(server(), { kind: "unix", path: occupied }),
      ).rejects.toThrow(/not a socket/);
    },
  );

  it.skipIf(process.platform === "win32")(
    "releases only a socket, and only ours",
    async () => {
      const directory = temporary();
      const path = join(directory, "runtime.sock");
      const listener = server();
      await bind(listener, { kind: "unix", path });
      listener.close();
      release({ kind: "unix", path });
      expect(() => statSync(path)).toThrow();
      const file = join(directory, "keep");
      writeFileSync(file, "x");
      release({ kind: "unix", path: file } as ListenSpec);
      expect(statSync(file).size).toBe(1);
    },
  );

  it.skipIf(process.platform === "win32")(
    "says which transport is missing rather than falling back to a port",
    async () => {
      await expect(
        bind(server(), { kind: "pipe", name: "armadra-core" }),
      ).rejects.toThrow(/needs Windows/);
    },
  );
});
