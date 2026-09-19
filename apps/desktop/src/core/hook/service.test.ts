import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { read } from "./endpoint";
import { HookService } from "./service";

function temporary(): string {
  return mkdtempSync(join(tmpdir(), "armadra-hook-service-"));
}

describe("the hook service", () => {
  it("writes the endpoint file and keeps the bearer across a restart", () => {
    const directory = temporary();
    const service = new HookService(directory, 43119);
    service.publishEndpoint(43119);

    const published = read(service.endpointFile());
    expect(published.get("ARMADRA_HOOK_VERSION")).toBe("1");
    expect(published.get("ARMADRA_HOOK_PORT")).toBe("43119");
    expect(published.get("ARMADRA_NODE_TOKEN_DIR")).toBe(
      service.nodeTokenDir(),
    );
    expect((published.get("ARMADRA_HOOK_TOKEN") ?? "").length).toBeGreaterThan(
      31,
    );
    if (process.platform !== "win32") {
      expect(published.get("ARMADRA_HOOK_SOCK")).toBe(
        join(directory, "hook.sock"),
      );
    }
    expect(service.health().ok).toBe(true);

    // A second core over the same data directory keeps both secrets, so
    // terminals started by the first one keep reporting.
    const restarted = new HookService(directory, 43118);
    expect(restarted.bearerMatches(published.get("ARMADRA_HOOK_TOKEN"))).toBe(
      true,
    );
    expect(restarted.verdict("node-a", service.issueNodeToken("node-a"))).toBe(
      "verified",
    );

    // The health flag follows the port that is actually published.
    expect(restarted.health().ok).toBe(false);
    restarted.publishEndpoint(43118);
    expect(restarted.health().ok).toBe(true);
    expect(read(service.endpointFile()).get("ARMADRA_HOOK_PORT")).toBe("43118");
  });

  it.skipIf(process.platform === "win32")(
    "publishes no port for a socket-only core and clears a previous one",
    () => {
      // A desktop core binds no port. Its endpoint file must advertise the
      // socket alone: a port key left over from a TCP run would send hook
      // clients to whatever process now owns that number.
      const directory = temporary();
      const withPort = new HookService(directory, 43119);
      withPort.publishEndpoint(43119);
      expect(withPort.health().ok).toBe(true);

      const socketOnly = new HookService(directory, undefined);
      // The stale port file does not describe this core.
      expect(socketOnly.health().ok).toBe(false);
      socketOnly.publishEndpoint(undefined);
      const published = read(socketOnly.endpointFile());
      expect(published.has("ARMADRA_HOOK_PORT")).toBe(false);
      expect(published.get("ARMADRA_HOOK_SOCK")).toBe(
        join(directory, "hook.sock"),
      );
      const health = socketOnly.health();
      expect(health.port).toBeUndefined();
      expect(health.ok).toBe(true);
      expect(health.sock).toBeDefined();
      // And the bearer is still the one earlier terminals were given.
      expect(
        socketOnly.bearerMatches(published.get("ARMADRA_HOOK_TOKEN")),
      ).toBe(true);
    },
  );

  it("writes node tokens next to the endpoint file", () => {
    const directory = temporary();
    const service = new HookService(directory, 43119);
    const token = service.issueNodeToken("node-a");
    expect(readFileSync(join(service.nodeTokenDir(), "node-a"), "utf8")).toBe(
      token,
    );
    expect(() => service.issueNodeToken("../escape")).toThrow();
  });

  it("keeps reducer memory per node and between events", () => {
    const service = new HookService(temporary(), 43119);
    service.withMemory("node-a", (memory) => {
      memory.awaitingInput = true;
    });
    expect(service.withMemory("node-a", (memory) => memory.awaitingInput)).toBe(
      true,
    );
    expect(service.withMemory("node-b", (memory) => memory.awaitingInput)).toBe(
      false,
    );
  });

  it.skipIf(process.platform === "win32")(
    "removes the endpoint file when a socket-only run has nothing to advertise",
    () => {
      // W0.3: the file is published optimistically before the bind, so a bind
      // that fails has to take the advertisement back rather than leave a dead
      // socket every client burns its connect budget on.
      const directory = temporary();
      const service = new HookService(directory, undefined);
      service.publishEndpoint(undefined);
      expect(read(service.endpointFile()).has("ARMADRA_HOOK_SOCK")).toBe(true);
      service.withdrawSocket();
      expect(read(service.endpointFile()).size).toBe(0);
    },
  );
});
