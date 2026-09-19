import { describe, expect, it } from "vitest";
import { createLog, logLevel, nodePlatform } from "./platform";

describe("the log", () => {
  it("defaults to info and refuses to be silenced by a typo", () => {
    expect(logLevel(undefined)).toBe("info");
    expect(logLevel("")).toBe("info");
    expect(logLevel("quiet")).toBe("info");
    expect(logLevel("DEBUG")).toBe("debug");
    expect(logLevel(" warn ")).toBe("warn");
  });

  it("prints at and above the level and nothing below it", () => {
    const lines: string[] = [];
    const log = createLog("warn", (line) => lines.push(line));
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("WARN w");
    expect(lines[1]).toContain("ERROR e");
  });

  it("puts structured fields on the same line as JSON", () => {
    const lines: string[] = [];
    createLog("debug", (line) => lines.push(line)).info("bound", { port: 1 });
    expect(lines[0]).toContain('INFO bound {"port":1}');
    expect(lines[0]?.endsWith("\n")).toBe(true);
  });
});

describe("the platform seam", () => {
  it("carries only what a shell knows and the core cannot find out", () => {
    const platform = nodePlatform({ dataDir: "/data", appVersion: "0.1.0" });
    expect(platform.dataDir).toBe("/data");
    expect(platform.appVersion).toBe("0.1.0");
    expect(platform.isPackaged).toBe(false);
    expect(typeof platform.openExternal).toBe("function");
    expect(typeof platform.notify).toBe("function");
  });

  it("notifies without a shell by logging, rather than throwing", () => {
    const lines: string[] = [];
    const platform = nodePlatform({
      dataDir: "/data",
      appVersion: "0.1.0",
      log: createLog("debug", (line) => lines.push(line)),
    });
    platform.notify("tray", { text: "hello" });
    expect(lines[0]).toContain("notify");
  });

  it("opens only the schemes a person could have meant", async () => {
    const platform = nodePlatform({ dataDir: "/data", appVersion: "0.1.0" });
    await expect(platform.openExternal("file:///etc/passwd")).rejects.toThrow(
      /refusing to open/,
    );
    await expect(platform.openExternal("javascript:alert(1)")).rejects.toThrow(
      /refusing to open/,
    );
    await expect(platform.openExternal("not a url")).rejects.toThrow(
      /not a URL/,
    );
  });
});
