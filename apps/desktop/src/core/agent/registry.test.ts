import { describe, expect, it } from "vitest";
import {
  AGENT_IDS,
  AGENT_REGISTRY,
  AGENT_STATE_SOURCES,
  OBSERVED,
  STATE_SOURCE_EXTENSION,
  STATE_SOURCE_HOOK,
  customInfo,
  definition,
  detect,
  hasCapability,
  resolveCommand,
  stateSourceFor,
  stateSourceIsReported,
  validAgentId,
} from "./registry";

/** Ported from the `mod tests` in the pre-merge implementation. */

const NO_CUSTOM = { customAgents: () => [] };

describe("the agent registry", () => {
  it("lists exactly the six CLIs, and Gemini is not one of them", () => {
    expect(AGENT_REGISTRY).toHaveLength(AGENT_IDS.length);
    expect([...AGENT_IDS]).not.toContain("gemini");
    for (const agent of AGENT_REGISTRY) {
      expect(AGENT_IDS as readonly string[]).toContain(agent.id);
      expect(agent.launchCmd).not.toBe("");
      expect(agent.color.startsWith("#")).toBe(true);
      expect(agent.color).toHaveLength(7);
      expect(agent.capabilities).toContain("contextLink");
    }
    expect(definition("claude")?.launchCmd).toBe("claude");
    expect(definition("opencode")?.promptMode).toBe("flag-prompt");
    expect(definition("pi")?.launchCmd).toBe("pi");
    expect(definition("omp")?.launchCmd).toBe("omp");
    expect(definition("copilot")?.launchCmd).toBe("copilot");
    expect(definition("gemini")).toBeUndefined();
  });

  it("never reads an observation as a report", () => {
    // The value the whole column exists for, and the one that must never
    // pass: the output pump can guess a terminal has gone quiet, and treating
    // that guess as evidence of an ended turn is how a handoff lands
    // mid-sentence.
    expect(stateSourceIsReported(STATE_SOURCE_HOOK)).toBe(true);
    expect(stateSourceIsReported(STATE_SOURCE_EXTENSION)).toBe(true);
    expect(stateSourceIsReported(OBSERVED)).toBe(false);
    expect(stateSourceIsReported(undefined)).toBe(false);
    expect(stateSourceIsReported(null)).toBe(false);
    expect(stateSourceIsReported("")).toBe(false);
    expect(stateSourceIsReported("invented")).toBe(false);
  });

  it("gives every provider with a source a known channel and the hooks capability", () => {
    for (const agent of AGENT_REGISTRY) {
      const source = stateSourceFor(agent.id);
      if (source === undefined) continue;
      expect(AGENT_STATE_SOURCES as readonly string[]).toContain(source);
      expect(agent.capabilities).toContain("hooks");
    }
    expect(stateSourceFor("claude")).toBe(STATE_SOURCE_HOOK);
    expect(stateSourceFor("copilot")).toBe(STATE_SOURCE_HOOK);
    expect(stateSourceFor("pi")).toBe(STATE_SOURCE_EXTENSION);
    expect(stateSourceFor("omp")).toBe(STATE_SOURCE_EXTENSION);
    expect(stateSourceFor("opencode")).toBe(STATE_SOURCE_EXTENSION);
    // No provider is ever guessed at: an id with no adapter has no source, and
    // neither does a custom entry, whose base picks the channel first.
    expect(stateSourceFor("custom:wrapper")).toBeUndefined();
    expect(stateSourceFor("")).toBeUndefined();
  });

  it("reports the resolved command path, and resolves a path as a path", () => {
    for (const agent of detect()) {
      expect(agent.installed).toBe(agent.resolvedPath !== null);
      expect(agent.resolvedPath !== null).toBe(
        resolveCommand(agent.launchCmd) !== undefined,
      );
    }
    expect(resolveCommand("")).toBeUndefined();
    expect(resolveCommand("definitely-not-a-real-binary-xyz")).toBeUndefined();
    // The test binary sits in no PATH directory under its own name, so the
    // only way this resolves is by treating it as the path it is.
    expect(resolveCommand(process.execPath)).toBe(process.execPath);
    expect(resolveCommand("/bin/definitely-not-here")).toBeUndefined();
    expect(resolveCommand("./definitely-not-here")).toBeUndefined();
  });

  it("lets a custom agent inherit everything but its name and program", () => {
    const custom = {
      id: "custom:echo",
      label: "Echo",
      color: "#ffffff",
      launchCmd: process.execPath,
      args: ["hello"],
      baseAgent: "codex",
      disabledCapabilities: [],
    };
    const info = customInfo(custom);
    expect(info.id).toBe("custom:echo");
    expect(info.label).toBe("Echo");
    expect(info.launchCmd).toBe(process.execPath);
    expect(info.args).toEqual(["hello"]);
    expect(info.baseAgent).toBe("codex");
    // Prompt mode, capabilities and colour come from the base agent.
    const base = definition("codex");
    expect(info.promptMode).toBe(base?.promptMode);
    expect(info.capabilities).toEqual(base?.capabilities);
    expect(info.color).toBe(base?.color);
    expect(info.installed).toBe(true);
    expect(info.resolvedPath).toBe(process.execPath);
  });

  it("never lets a custom entry gain another adapter's abilities", () => {
    const orphan = customInfo({
      id: "custom:orphan",
      label: "Orphan",
      launchCmd: "wrapper",
      baseAgent: "nope",
    });
    expect(orphan.baseAgent).toBeUndefined();
    expect(orphan.capabilities).toEqual([]);
  });

  it("narrows a custom agent's capabilities and never widens them", () => {
    const settings = {
      customAgents: () => [
        {
          id: "custom:narrow",
          label: "Narrow",
          launchCmd: "wrapper",
          baseAgent: "claude",
          disabledCapabilities: ["resume", "usage", "invented"],
        },
        {
          id: "custom:unknown",
          label: "Unknown",
          launchCmd: "wrapper",
          baseAgent: "invented",
        },
      ],
    };
    expect(hasCapability(settings, "custom:narrow", "resume")).toBe(false);
    expect(hasCapability(settings, "custom:narrow", "usage")).toBe(false);
    expect(hasCapability(settings, "custom:narrow", "hooks")).toBe(true);
    // A base that does not have it cannot be given it by not disabling it.
    expect(hasCapability(settings, "custom:narrow", "invented")).toBe(false);
    // An entry whose base is unknown can do nothing at all.
    expect(hasCapability(settings, "custom:unknown", "hooks")).toBe(false);
  });

  it("answers capabilities for a built-in from the registry alone", () => {
    expect(hasCapability(NO_CUSTOM, "claude", "usage")).toBe(true);
    // Copilot has no account-usage adapter; the capability is not declared
    // from a doc.
    expect(hasCapability(NO_CUSTOM, "copilot", "usage")).toBe(false);
    expect(hasCapability(NO_CUSTOM, "gemini", "hooks")).toBe(false);
    // A `custom:` id with no stored entry is nobody.
    expect(hasCapability(NO_CUSTOM, "custom:ghost", "hooks")).toBe(false);
  });

  it("accepts the six ids and a bounded custom suffix, and nothing else", () => {
    for (const id of AGENT_IDS) expect(validAgentId(id)).toBe(true);
    expect(validAgentId("custom:wrapper")).toBe(true);
    expect(validAgentId("custom:")).toBe(false);
    expect(validAgentId(`custom:${"x".repeat(65)}`)).toBe(false);
    expect(validAgentId("gemini")).toBe(false);
    expect(validAgentId("")).toBe(false);
  });
});
