import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { OMP_HOOK_EVENTS, PI_HOOK_EVENTS } from "./events";
import { opencodePluginSource, piExtensionSource } from "./extension-template";
import {
  modulePath,
  opencodePluginPath,
  piExtensionPath,
  uninstallModule,
} from "./extensions";
import { isManagedCommand } from "./shared";
import { tempDir } from "../../testing/temp-dir";

const CLIENT = "/opt/armadra/armadra-hook";

function home(kind: string): string {
  return tempDir(`armadra-${kind}-`);
}

/**
 * What the old global installer wrote into the directory the CLI scans. The
 * same source is injected per launch now (`inject.ts`); the tests here cover
 * the source itself and the removal of the old global copy.
 */
function writeOld(agentId: string, directory: string): string {
  const path = modulePath(agentId, directory);
  const source =
    agentId === "opencode"
      ? opencodePluginSource(agentId, CLIENT)
      : piExtensionSource(
          agentId,
          CLIENT,
          agentId === "omp" ? OMP_HOOK_EVENTS : PI_HOOK_EVENTS,
        );
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source, "utf8");
  return path;
}

describe("the opencode plugin", () => {
  it("is gated on the node and names our client", () => {
    const directory = home("opencode");
    const path = writeOld("opencode", directory);
    expect(path).toBe(opencodePluginPath(directory));
    expect(path.endsWith(join("plugins", "armadra-status.js"))).toBe(true);

    const source = readFileSync(path, "utf8");
    expect(source).toContain("export const ArmadraStatus");
    expect(source).toContain('armadraEnv("ARMADRA_NODE_ID")');
    expect(source).toContain("/opt/armadra/armadra-hook");
    expect(source).toContain('const ARMADRA_AGENT = "opencode";');
    expect(isManagedCommand(source)).toBe(true);
    // Deterministic: regenerating writes the same bytes.
    expect(opencodePluginSource("opencode", CLIENT)).toBe(source);
  });

  /**
   * §3.1 channel B: the plugin dials the socket itself and only spawns when it
   * cannot. Both halves have to be in the file for either claim to hold.
   */
  it("connects in process and keeps the spawn fallback", () => {
    const source = opencodePluginSource("opencode", CLIENT);
    // bun's transport first — that is what opencode runs on — then node's,
    // then the loopback port the endpoint file may carry.
    expect(source).toContain("unix: session.sock");
    expect(source).toContain("socketPath: session.sock");
    expect(source).toContain('host: "127.0.0.1"');
    // The fallback that was the whole plugin before the socket transport.
    expect(source).toContain("spawn(ARMADRA_CLIENT, [ARMADRA_AGENT]");
    // The credentials §1.3 calls unweakenable, unchanged by the transport.
    expect(source).toContain("X-Armadra-Hook-Token");
    expect(source).toContain("X-Armadra-Node-Token");
    expect(source).toContain("terminalBinding");
    expect(source).toContain("context-sequences");
    // The route stays opencode's own.
    expect(source).toContain('"/hook/" + ARMADRA_AGENT');
    // And the bus hook never returns a decision to opencode (§3.5).
    expect(source).not.toContain("permissionDecision");
    expect(source).not.toContain('"deny"');
  });

  it("removes our plugin on removal and leaves a stranger alone", () => {
    const directory = home("opencode");
    writeOld("opencode", directory);
    uninstallModule("opencode", directory);
    expect(existsSync(opencodePluginPath(directory))).toBe(false);
    // Uninstalling again is a no-op, not an error.
    expect(() => uninstallModule("opencode", directory)).not.toThrow();

    // Someone else's file under the same name is not ours to delete.
    const path = opencodePluginPath(directory);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "export const Other = () => ({});\n", "utf8");
    uninstallModule("opencode", directory);
    expect(existsSync(path)).toBe(true);
  });

  it("leaves other plugins alone through removal", () => {
    const directory = home("opencode");
    const theirs = join(directory, "plugins", "their-plugin.js");
    mkdirSync(dirname(theirs), { recursive: true });
    writeFileSync(theirs, "export const Theirs = () => ({});\n", "utf8");

    writeOld("opencode", directory);
    expect(readFileSync(theirs, "utf8")).toBe(
      "export const Theirs = () => ({});\n",
    );

    uninstallModule("opencode", directory);
    expect(existsSync(opencodePluginPath(directory))).toBe(false);
    expect(existsSync(theirs)).toBe(true);
  });

  it("escapes a Windows-style path for JavaScript", () => {
    const source = opencodePluginSource(
      "opencode",
      String.raw`C:\Program Files\armadra\armadra-hook.exe`,
    );
    expect(source).toContain(
      String.raw`C:\\Program Files\\armadra\\armadra-hook.exe`,
    );
    // And the literal it lands in is still one well-formed string.
    expect(source.split('const ARMADRA_CLIENT = "')).toHaveLength(2);
  });
});

describe("the Pi and Oh My Pi extension", () => {
  it("is gated on the node and names our client", () => {
    const directory = home("pi");
    const path = writeOld("pi", directory);
    expect(path).toBe(piExtensionPath(directory));
    expect(path.endsWith(join("extensions", "armadra-status.ts"))).toBe(true);

    const source = readFileSync(path, "utf8");
    expect(source).toContain("export default function");
    expect(source).toContain("ARMADRA_NODE_ID");
    expect(source).toContain("/opt/armadra/armadra-hook");
    expect(source).toContain('const ARMADRA_AGENT = "pi";');
    expect(source).toContain('"agent_settled"');
    expect(isManagedCommand(source)).toBe(true);
    expect(piExtensionSource("pi", CLIENT, PI_HOOK_EVENTS)).toBe(source);
  });

  it("leaves other extensions alone through removal", () => {
    const directory = home("pi");
    const theirs = join(directory, "extensions", "their-widget.ts");
    mkdirSync(dirname(theirs), { recursive: true });
    writeFileSync(theirs, "export default function () {}\n", "utf8");

    writeOld("pi", directory);
    expect(readFileSync(theirs, "utf8")).toBe(
      "export default function () {}\n",
    );

    uninstallModule("pi", directory);
    expect(existsSync(piExtensionPath(directory))).toBe(false);
    expect(existsSync(theirs)).toBe(true);
  });

  it("removes only our file on removal, idempotently", () => {
    const directory = home("pi");
    writeOld("pi", directory);
    uninstallModule("pi", directory);
    expect(existsSync(piExtensionPath(directory))).toBe(false);
    expect(() => uninstallModule("pi", directory)).not.toThrow();

    const path = piExtensionPath(directory);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "export default function () {}\n", "utf8");
    uninstallModule("pi", directory);
    expect(existsSync(path)).toBe(true);
  });

  it("reports as omp and regenerates byte-identically", () => {
    const directory = home("omp");
    const path = writeOld("omp", directory);
    const source = readFileSync(path, "utf8");
    expect(source).toContain('const ARMADRA_AGENT = "omp";');
    // The settle event the idle gate reads on this fork, and the one Pi uses,
    // are both registered: OMP 18.x emits only the first.
    expect(source).toContain('"session_stop"');
    expect(source).toContain('"agent_settled"');
    expect(source).toContain('"auto_compaction_end"');
    expect(isManagedCommand(source)).toBe(true);
    expect(piExtensionSource("omp", CLIENT, OMP_HOOK_EVENTS)).toBe(source);
  });

  it("writes different files into different homes for the two providers", () => {
    const piHome = home("pi");
    const ompHome = home("omp");
    writeOld("pi", piHome);
    writeOld("omp", ompHome);
    const piSource = readFileSync(piExtensionPath(piHome), "utf8");
    const ompSource = readFileSync(piExtensionPath(ompHome), "utf8");
    expect(piSource).not.toBe(ompSource);
    expect(piSource).not.toContain('"session_stop"');
  });
});
