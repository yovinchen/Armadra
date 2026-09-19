import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  dataDir,
  databaseFile,
  endpointsFile,
  hardenDirectory,
  hardenFile,
  hookEndpointFile,
  nodeTokenDir,
  pendingDir,
  resolveDataDir,
  settingsFile,
  workerSettingsFile,
  writeSecret,
} from "./paths";

function temporary(): string {
  return mkdtempSync(join(tmpdir(), "armadra-paths-"));
}

describe("the data directory", () => {
  it("lets the override win on every platform", () => {
    for (const platform of ["darwin", "win32", "linux"]) {
      expect(
        dataDir(platform, { ARMADRA_DATA_DIR: "/x", HOME: "/home/dev" }),
      ).toBe("/x");
    }
  });

  it("resolves macOS, Windows and Linux the way the Rust Runtime does", () => {
    expect(dataDir("darwin", { HOME: "/Users/dev" })).toBe(
      "/Users/dev/Library/Application Support/Armadra",
    );
    expect(
      dataDir("win32", { LOCALAPPDATA: "C:\\Users\\dev\\AppData\\Local" }),
    ).toBe(join("C:\\Users\\dev\\AppData\\Local", "Armadra"));
    expect(dataDir("linux", { XDG_DATA_HOME: "/data" })).toBe("/data/armadra");
    expect(dataDir("linux", { HOME: "/home/dev" })).toBe(
      "/home/dev/.local/share/armadra",
    );
  });

  it("falls through when the platform's own variable is absent", () => {
    // The Rust `cfg!` chain does exactly this rather than failing.
    expect(dataDir("darwin", { XDG_DATA_HOME: "/data" })).toBe("/data/armadra");
    expect(dataDir("win32", { HOME: "/home/dev" })).toBe(
      "/home/dev/.local/share/armadra",
    );
    expect(dataDir("linux", {})).toBe(join(tmpdir(), "armadra"));
  });

  it("prefers an explicit --data-dir to everything", () => {
    expect(resolveDataDir("/explicit", "darwin", { HOME: "/Users/dev" })).toBe(
      "/explicit",
    );
    expect(resolveDataDir(undefined, "linux", { XDG_DATA_HOME: "/d" })).toBe(
      "/d/armadra",
    );
  });

  it("keeps every contractual file inside the data directory", () => {
    const base = "/data";
    for (const path of [
      endpointsFile(base),
      hookEndpointFile(base),
      nodeTokenDir(base),
      pendingDir(base),
      settingsFile(base),
      workerSettingsFile(base),
      databaseFile(base),
    ]) {
      expect(path.startsWith(`${base}/`)).toBe(true);
    }
    expect(endpointsFile(base)).toBe("/data/endpoints.json");
    expect(hookEndpointFile(base)).toBe("/data/hook-endpoint.env");
    expect(databaseFile(base)).toBe("/data/canvas.db");
  });
});

describe("the private-file primitive", () => {
  it.skipIf(process.platform === "win32")(
    "creates the directory 0700 and the file 0600",
    () => {
      const path = join(temporary(), "nested", "secret");
      writeSecret(path, "token");
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(join(path, "..")).mode & 0o777).toBe(0o700);
      expect(readFileSync(path, "utf8")).toBe("token");
    },
  );

  it.skipIf(process.platform === "win32")(
    "is 0600 whatever the umask says",
    () => {
      // `fs.writeFile(..., { mode })` would hand the umask a say; this must not.
      const previous = process.umask(0o077);
      try {
        const path = join(temporary(), "secret");
        writeSecret(path, "token");
        expect(statSync(path).mode & 0o777).toBe(0o600);
      } finally {
        process.umask(previous);
      }
    },
  );

  it("replaces atomically and leaves no temporary file behind", () => {
    const directory = temporary();
    const path = join(directory, "secret");
    writeSecret(path, "first");
    writeSecret(path, Buffer.from("second"));
    expect(readFileSync(path, "utf8")).toBe("second");
    expect(readdirSync(directory)).toEqual(["secret"]);
  });

  it("writes through a leftover temporary file from a previous run", () => {
    const directory = temporary();
    const path = join(directory, "secret");
    writeFileSync(join(directory, `.secret.tmp-${process.pid}`), "stale");
    writeSecret(path, "fresh");
    expect(readFileSync(path, "utf8")).toBe("fresh");
    expect(readdirSync(directory)).toEqual(["secret"]);
  });

  it.skipIf(process.platform === "win32")(
    "hardens an existing path without complaining about one that is gone",
    () => {
      const directory = temporary();
      const path = join(directory, "file");
      writeFileSync(path, "x", { mode: 0o644 });
      hardenFile(path);
      hardenDirectory(directory);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(directory).mode & 0o777).toBe(0o700);
      expect(() => hardenFile(join(directory, "missing"))).not.toThrow();
      expect(() => hardenDirectory(join(directory, "missing"))).not.toThrow();
    },
  );
});
