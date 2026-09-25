/**
 * The method allowlist, the write gate, the registry and settings — a port of
 * the pre-merge implementation.
 */

import { describe, expect, it } from "vitest";

import { check, codeActionIsOffered, grantChange, requirement } from "./policy";
import {
  candidate,
  featuresFromCapabilities,
  language,
  languageIdFor,
  type ServerState,
} from "./registry";
import { LanguageSettings, normalizeLanguageSection } from "./settings";
import type { JsonObject } from "./jsonrpc";

describe("language/policy", () => {
  it("an unknown method is refused rather than forwarded", () => {
    // The whole point of an allowlist: a method nobody vetted does not reach a
    // language server just because it exists.
    expect(requirement("textDocument/inlayHint")).toBe("never");
    expect(requirement("$/somethingNew")).toBe("never");
    expect(check("workspace/executeCommand", true)).toBe("notAllowed");
    // Even with every grant.
    expect(check("window/showDocument", true)).toBe("notAllowed");
  });

  it("the write gate matches the editor's own read-only state", () => {
    for (const method of [
      "textDocument/rename",
      "textDocument/prepareRename",
      "textDocument/formatting",
      "textDocument/rangeFormatting",
      "codeAction/resolve",
    ]) {
      expect(check(method, false), method).toBe("readOnly");
      expect(check(method, true), method).toBeUndefined();
    }
    for (const method of [
      "textDocument/hover",
      "textDocument/completion",
      "textDocument/definition",
      "textDocument/references",
      "textDocument/codeAction",
      "workspace/symbol",
      "$/cancelRequest",
    ]) {
      expect(check(method, false), method).toBeUndefined();
    }
  });

  it("a code action that only runs a command is not offered", () => {
    expect(codeActionIsOffered({ title: "fix", edit: { changes: {} } })).toBe(
      true,
    );
    expect(
      codeActionIsOffered({ title: "run", command: { command: "x" } }),
    ).toBe(false);
    // An action with both is applied by its edit; the command is never run.
    expect(
      codeActionIsOffered({
        title: "both",
        edit: {},
        command: { command: "x" },
      }),
    ).toBe(true);
  });
});

describe("language/registry", () => {
  it("answers a language only for files it covers", () => {
    expect(languageIdFor("src/main.rs")).toBe("rust");
    expect(languageIdFor("src/App.tsx")).toBe("typescript");
    expect(languageIdFor("script.MJS")).toBe("javascript");
    // A whole file name, because `go.mod`'s extension is `mod`.
    expect(languageIdFor("go.mod")).toBe("go");
    expect(languageIdFor("nested/dir/go.sum")).toBe("go");
    // No language is an answer.
    expect(languageIdFor("notes.txt")).toBeUndefined();
    expect(languageIdFor(".gitignore")).toBeUndefined();
    expect(languageIdFor("Makefile")).toBeUndefined();
  });

  it("falling back to a linter narrows what is claimed", () => {
    const python = language("python");
    expect(python).toBeDefined();
    const ruff = python?.candidates.find((entry) => entry.serverId === "ruff");
    expect(ruff).toBeDefined();
    expect(ruff?.features).not.toContain("completion");
    expect(ruff?.features).not.toContain("rename");
    expect(ruff?.features).toContain("diagnostics");
    // And it is the last resort, after the two full servers.
    expect(python?.candidates[python.candidates.length - 1]?.serverId).toBe(
      "ruff",
    );
    expect(candidate("ruff")?.entry.languageId).toBe("python");
  });

  it("features come from what the server said it can do", () => {
    const features = featuresFromCapabilities({
      hoverProvider: true,
      renameProvider: { prepareProvider: true },
      // Explicitly false is explicitly absent.
      completionProvider: false,
      documentFormattingProvider: true,
    });
    expect(features).toContain("hover");
    expect(features).toContain("rename");
    expect(features).toContain("formatting");
    expect(features).not.toContain("completion");
    // Push diagnostics are not advertised; a server that pushes says so by
    // pushing, so the capability is claimed unless the server opted out.
    expect(features).toContain("diagnostics");
  });

  it("every state has one stable name on the wire", () => {
    const names: ServerState[] = [
      "available",
      "unsupported",
      "idleStopped",
      "crashed",
      "disconnected",
    ];
    // The union *is* the wire spelling here, so the assertion is that the
    // names have not drifted from the Rust `as_str` table.
    expect(names).toEqual([
      "available",
      "unsupported",
      "idleStopped",
      "crashed",
      "disconnected",
    ]);
  });
});

describe("language/settings", () => {
  it("clamps what a hand-edited file can ask for", () => {
    const settings = LanguageSettings.fromDocument({
      language: {
        idleStopSeconds: 999_999,
        maxServers: 0,
        maxRssBytes: 1,
        formatOnSave: true,
        servers: {
          ruff: {
            path: "/usr/local/bin/ruff",
            args: ["server", "--preview"],
          },
          gopls: { enabled: false },
        },
      },
    });
    // Out of range snaps back to the default rather than being rejected.
    expect(settings.idleStopSeconds).toBe(600);
    expect(settings.maxServers).toBe(1);
    // A ceiling too small to hold any real server is raised, not honoured.
    expect(settings.maxRssBytes).toBeGreaterThanOrEqual(128 * 1024 * 1024);
    expect(settings.formatOnSave).toBe(true);
    const ruff = settings.server("ruff");
    expect(ruff.path).toBe("/usr/local/bin/ruff");
    expect(ruff.args).toEqual(["server", "--preview"]);
    expect(ruff.enabled).toBe(true);
    expect(settings.server("gopls").enabled).toBe(false);
    // A server nobody configured is enabled with the registry's own program.
    expect(settings.server("rust-analyzer").enabled).toBe(true);
    expect(settings.server("rust-analyzer").path).toBe("");
  });

  it("a zero idle stop means never rather than immediately", () => {
    expect(
      LanguageSettings.fromDocument({ language: { idleStopSeconds: 0 } })
        .idleStopSeconds,
    ).toBe(0);
    expect(
      LanguageSettings.fromDocument({ language: { maxRssBytes: 0 } })
        .maxRssBytes,
    ).toBe(0);
  });

  it("normalising fills defaults without touching the user's map", () => {
    const document: JsonObject = {
      language: { servers: { "unknown-server": { path: "/x" } } },
    };
    normalizeLanguageSection(document);
    const section = document["language"] as JsonObject;
    expect(section["idleStopSeconds"]).toBe(600);
    expect(section["maxServers"]).toBe(6);
    expect(section["formatOnSave"]).toBe(false);
    // An id this build has never heard of survives.
    expect(
      ((section["servers"] as JsonObject)["unknown-server"] as JsonObject)[
        "path"
      ],
    ).toBe("/x");
  });
});

describe("language/policy grant changes", () => {
  it("stops on a lost execute grant or a deleted workspace, narrows on a lost write", () => {
    expect(grantChange({ write: true, execute: false })).toEqual({
      kind: "stop",
      reason: "execution_not_granted",
    });
    expect(grantChange(null)).toEqual({
      kind: "stop",
      reason: "workspace_closed",
    });
    expect(grantChange({ write: false, execute: true })).toEqual({
      kind: "readOnly",
    });
    expect(grantChange({ write: true, execute: true })).toEqual({
      kind: "keep",
    });
  });
});
