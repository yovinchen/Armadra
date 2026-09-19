import { describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import {
  agentInfoSchema,
  terminalSessionSchema,
  type TerminalSession,
  type AgentInfo,
} from "@armadra/shared";
import { createWorkspaceFileDrag } from "../files/workspace-drag";
import {
  absoluteWorkspacePath,
  automaticInputBlocksFileDrop,
  pasteWorkspaceFilePaths,
  quoteTerminalPath,
  type TerminalDropTarget,
} from "./file-drop";

const RUNTIME = "http://127.0.0.1:55140";
const WORKSPACE = "019ff7d1-0d12-7421-833d-2c5e8d64ed10";
const SESSION = "019ff7d1-0d12-7421-833d-2c5e8d64ed11";
const target: TerminalDropTarget = {
  runtimeUrl: RUNTIME,
  workspaceId: WORKSPACE,
  workspaceRoot: "/repo",
  sessionId: SESSION,
  generation: 3,
  ssh: false,
};
function session(overrides: Partial<TerminalSession> = {}): TerminalSession {
  return terminalSessionSchema.parse({
    id: SESSION,
    workspaceId: WORKSPACE,
    cwd: "/elsewhere",
    shell: "/bin/zsh",
    command: null,
    agentId: null,
    status: "running",
    exitCode: null,
    pid: 1200,
    createdAt: "2026-09-05T00:00:00.000Z",
    endedAt: null,
    sessionKey: SESSION,
    backend: "tmux",
    attachState: "live",
    generation: 3,
    ...overrides,
  });
}
function drag(path = "a file's.txt") {
  return createWorkspaceFileDrag(RUNTIME, WORKSPACE, [
    {
      path,
      name: path.split("/").at(-1)!,
      kind: "file",
      size: 1,
      readonly: false,
    },
  ]);
}
function services(value = session()) {
  return {
    getTerminal: vi.fn(async () => value),
    fileInfo: vi.fn(async (_workspace: string, path: string) => ({ path })),
    listFiles: vi.fn(async (_workspace: string, path: string) => ({ path })),
    agents: vi.fn(async (): Promise<AgentInfo[]> => []),
  };
}

describe("safe terminal path text", () => {
  it("uses session shell quoting and never sends Enter", async () => {
    const paste = vi.fn();
    const api = services();
    await pasteWorkspaceFilePaths(drag(), target, api, () => true, paste);
    expect(paste).toHaveBeenCalledWith("'/repo/a file'\\''s.txt' ");
    expect(paste.mock.calls[0]?.[0]).not.toMatch(/[\r\n\u001b]/);
    expect(api.getTerminal).toHaveBeenCalledWith(SESSION);
  });

  it("uses PowerShell string escaping and CMD rejects expansions", () => {
    expect(
      quoteTerminalPath(
        "C:\\repo\\a'b.txt",
        "C:\\Program Files\\PowerShell\\pwsh.exe",
      ),
    ).toBe("'C:\\repo\\a''b.txt'");
    expect(
      quoteTerminalPath("C:\\a & b.txt", "C:\\Windows\\System32\\cmd.exe"),
    ).toBe('"C:\\a & b.txt"');
    for (const path of ["C:\\%USER%.txt", "C:\\!secret!.txt", 'C:\\bad".txt'])
      expect(() => quoteTerminalPath(path, "cmd.exe")).toThrow(
        "fileDrag.cmdPathUnsupported",
      );
    for (const path of [
      "/a\nb",
      "/a\rb",
      "/a\u001bb",
      "/a\u0000b",
      "/a\u007fb",
    ])
      expect(() => quoteTerminalPath(path, "bash")).toThrow(
        "fileDrag.invalidPath",
      );
    expect(() => quoteTerminalPath("/safe", "unknown-shell")).toThrow(
      "fileDrag.shellUnsupported",
    );
  });

  it("joins paths on the runtime filesystem rather than browser OS", () => {
    expect(
      absoluteWorkspacePath("C:\\repo", "src/a.txt", "powershell.exe"),
    ).toBe("C:\\repo\\src\\a.txt");
    expect(absoluteWorkspacePath("C:\\repo", "src/a.txt", "bash.exe")).toBe(
      "C:/repo/src/a.txt",
    );
    expect(absoluteWorkspacePath("/repo", "src/a.txt", "zsh")).toBe(
      "/repo/src/a.txt",
    );
    expect(() => absoluteWorkspacePath("/repo", "../a", "zsh")).toThrow();
  });

  it("supports identified built-in and configured Agent commands", async () => {
    const paste = vi.fn();
    await pasteWorkspaceFilePaths(
      drag(),
      { ...target, agentId: "claude" },
      services(
        session({
          agentId: "claude",
          command: "/Applications/Agent Tools/claude",
        }),
      ),
      () => true,
      paste,
    );
    const api = services(
      session({ agentId: "custom:helper", command: "/Agent Tools/helper" }),
    );
    api.agents.mockResolvedValue([
      agentInfoSchema.parse({
        id: "custom:helper",
        label: "Helper",
        launchCmd: "helper",
        resolvedPath: "/Agent Tools/helper",
        color: "#777777",
        promptMode: "argv",
        installed: true,
      }),
    ]);
    await pasteWorkspaceFilePaths(
      drag(),
      { ...target, agentId: "custom:helper" },
      api,
      () => true,
      paste,
    );
    expect(paste).toHaveBeenCalledTimes(2);
  });

  it.each([
    session({ command: "cat" }),
    session({ command: "ssh -t remote", agentId: "claude" }),
    session({
      command: "C:\\Program Files\\OpenSSH\\ssh.exe",
      agentId: "claude",
    }),
    session({ agentId: "codex" }),
    session({ generation: 4 }),
    session({ generation: undefined }),
    session({ workspaceId: "019ff7d1-0d12-7421-833d-2c5e8d64ed99" }),
    session({ shell: "unknown" }),
  ])("does not paste into unconfirmed execution contexts", async (value) => {
    const paste = vi.fn();
    const destination = value.agentId
      ? { ...target, agentId: "claude" }
      : target;
    await expect(
      pasteWorkspaceFilePaths(
        drag(),
        destination,
        services(value),
        () => true,
        paste,
      ),
    ).rejects.toThrow();
    expect(paste).not.toHaveBeenCalled();
  });

  it("rejects cross-runtime, SSH and inaccessible files", async () => {
    const paste = vi.fn();
    for (const destination of [
      { ...target, runtimeUrl: "http://other" },
      { ...target, ssh: true },
    ])
      await expect(
        pasteWorkspaceFilePaths(
          drag(),
          destination,
          services(),
          () => true,
          paste,
        ),
      ).rejects.toThrow();
    const api = services();
    api.fileInfo.mockRejectedValue(new Error("denied"));
    await expect(
      pasteWorkspaceFilePaths(drag(), target, api, () => true, paste),
    ).rejects.toThrow();
    expect(paste).not.toHaveBeenCalled();
  });

  it("drops a late response after destination changes and rejects unsafe canonical paths", async () => {
    const paste = vi.fn();
    const api = services();
    let active = true;
    api.fileInfo.mockImplementation(async () => {
      active = false;
      return { path: "safe.txt" };
    });
    await expect(
      pasteWorkspaceFilePaths(drag(), target, api, () => active, paste),
    ).rejects.toThrow("fileDrag.destinationChanged");
    api.fileInfo.mockResolvedValue({ path: "../outside.txt" });
    await expect(
      pasteWorkspaceFilePaths(drag(), target, api, () => true, paste),
    ).rejects.toThrow("fileDrag.invalidPath");
    expect(paste).not.toHaveBeenCalled();
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function batchDrag() {
  return createWorkspaceFileDrag(RUNTIME, WORKSPACE, [
    {
      path: "first file.txt",
      name: "first file.txt",
      kind: "file",
      size: 4,
      readonly: false,
    },
    {
      path: "资料/报告.md",
      name: "报告.md",
      kind: "file",
      size: 10,
      readonly: true,
    },
    {
      path: "项目目录",
      name: "项目目录",
      kind: "directory",
      size: 0,
      readonly: false,
    },
  ]);
}

describe("terminal file drop user-visible boundaries", () => {
  it.skipIf(process.platform === "win32")(
    "POSIX quoting reaches a real shell as one literal path, including expansion syntax",
    () => {
      const path =
        "/repo/中文 $(printf expanded); O'Reilly `printf substituted`.txt";
      const printed = execFileSync(
        "/bin/sh",
        ["-c", `printf '%s' ${quoteTerminalPath(path, "/bin/sh")}`],
        { encoding: "utf8" },
      );
      expect(printed).toBe(path);
    },
  );

  it("keeps shell-specific quotes literal and rejects every C0/DEL input", () => {
    expect(
      quoteTerminalPath("C:\\项目\\O'Reilly $env:HOME.txt", "PWSH.EXE"),
    ).toBe("'C:\\项目\\O''Reilly $env:HOME.txt'");
    expect(quoteTerminalPath("C:\\项目\\a & b (draft).txt", "CMD.EXE")).toBe(
      '"C:\\项目\\a & b (draft).txt"',
    );
    for (const code of [
      ...Array.from({ length: 32 }, (_, index) => index),
      127,
    ]) {
      for (const shell of ["/bin/sh", "powershell.exe", "cmd.exe"]) {
        expect(() =>
          quoteTerminalPath(
            `/repo/before${String.fromCharCode(code)}after`,
            shell,
          ),
        ).toThrow("fileDrag.invalidPath");
      }
    }
  });

  it("supports filesystem roots and UNC shares without inventing a browser-local path", () => {
    expect(absoluteWorkspacePath("/", "a.txt", "sh")).toBe("/a.txt");
    expect(absoluteWorkspacePath("/repo/", ".", "zsh")).toBe("/repo");
    expect(absoluteWorkspacePath("C:\\", ".", "cmd.exe")).toBe("C:\\");
    expect(
      absoluteWorkspacePath("C:\\", "folder/a.txt", "powershell.exe"),
    ).toBe("C:\\folder\\a.txt");
    expect(
      absoluteWorkspacePath(
        "\\\\server\\share\\",
        "目录/a.txt",
        "powershell.exe",
      ),
    ).toBe("\\\\server\\share\\目录\\a.txt");
    expect(() =>
      absoluteWorkspacePath("relative/root", "a.txt", "zsh"),
    ).toThrow("fileDrag.scopeMismatch");
  });

  it("resolves files and directories atomically, preserving selection order in one paste", async () => {
    const paste = vi.fn();
    const api = services();
    const first = deferred<{ path: string }>();
    api.fileInfo.mockImplementation(async (_workspace, path) =>
      path === "first file.txt" ? first.promise : { path },
    );
    const pending = pasteWorkspaceFilePaths(
      batchDrag(),
      { ...target, workspaceRoot: "/work dir" },
      api,
      () => true,
      paste,
    );
    await vi.waitFor(() =>
      expect(api.listFiles).toHaveBeenCalledWith(WORKSPACE, "项目目录"),
    );
    expect(paste).not.toHaveBeenCalled();
    first.resolve({ path: "first file.txt" });
    await pending;
    expect(api.fileInfo.mock.calls.map((call) => call.slice(0, 2))).toEqual([
      [WORKSPACE, "first file.txt"],
      [WORKSPACE, "资料/报告.md"],
    ]);
    expect(paste).toHaveBeenCalledTimes(1);
    expect(paste).toHaveBeenCalledWith(
      "'/work dir/first file.txt' '/work dir/资料/报告.md' '/work dir/项目目录' ",
    );
    expect(paste.mock.calls[0]?.[0]).not.toMatch(/[\r\n]/);
  });

  it("does not paste any partial selection when a later item cannot be resolved", async () => {
    const paste = vi.fn();
    const api = services();
    const first = deferred<{ path: string }>();
    api.fileInfo.mockImplementation(async (_workspace, path) =>
      path === "first file.txt" ? first.promise : { path },
    );
    api.listFiles.mockRejectedValue(new Error("directory no longer exists"));
    const pending = pasteWorkspaceFilePaths(
      batchDrag(),
      target,
      api,
      () => true,
      paste,
    );
    await expect(pending).rejects.toThrow("directory no longer exists");
    first.resolve({ path: "first file.txt" });
    await Promise.resolve();
    expect(paste).not.toHaveBeenCalled();
  });

  it.each(["metadata", "file"])(
    "does not paste when target changes while awaiting %s",
    async (stage) => {
      const paste = vi.fn();
      const api = services();
      let active = true;
      const metadata = deferred<TerminalSession>();
      const file = deferred<{ path: string }>();
      if (stage === "metadata")
        api.getTerminal.mockReturnValue(metadata.promise);
      else api.fileInfo.mockReturnValue(file.promise);
      const pending = pasteWorkspaceFilePaths(
        drag(),
        target,
        api,
        () => active,
        paste,
      );
      if (stage === "metadata")
        await vi.waitFor(() => expect(api.getTerminal).toHaveBeenCalledOnce());
      else await vi.waitFor(() => expect(api.fileInfo).toHaveBeenCalledOnce());
      active = false;
      if (stage === "metadata") metadata.resolve(session());
      else file.resolve({ path: "a file's.txt" });
      await expect(pending).rejects.toThrow("fileDrag.destinationChanged");
      expect(paste).not.toHaveBeenCalled();
    },
  );

  it.each(["exited", "failed", "terminated"] as const)(
    "refuses a %s session even if ids and generation match",
    async (status) => {
      const paste = vi.fn();
      const api = services(session({ status }));
      await expect(
        pasteWorkspaceFilePaths(drag(), target, api, () => true, paste),
      ).rejects.toThrow("fileDrag.destinationChanged");
      expect(paste).not.toHaveBeenCalled();
      expect(api.fileInfo).not.toHaveBeenCalled();
    },
  );

  it.each(["claude", "codex", "opencode", "pi", "omp", "copilot"])(
    "allows the identified built-in %s Agent",
    async (agentId) => {
      const paste = vi.fn();
      await pasteWorkspaceFilePaths(
        drag("文档.txt"),
        { ...target, agentId },
        services(session({ agentId, command: `/opt/Agent Tools/${agentId}` })),
        () => true,
        paste,
      );
      expect(paste).toHaveBeenCalledTimes(1);
      expect(paste.mock.calls[0]?.[0]).toBe("'/repo/文档.txt' ");
    },
  );

  it("rejects a configured Agent lookalike at a different executable path", async () => {
    const paste = vi.fn();
    const api = services(
      session({ agentId: "custom:helper", command: "/untrusted/helper" }),
    );
    api.agents.mockResolvedValue([
      agentInfoSchema.parse({
        id: "custom:helper",
        label: "Helper",
        launchCmd: "helper",
        resolvedPath: "/trusted/helper",
        color: "#777777",
        promptMode: "argv",
        installed: true,
      }),
    ]);
    await expect(
      pasteWorkspaceFilePaths(
        drag(),
        { ...target, agentId: "custom:helper" },
        api,
        () => true,
        paste,
      ),
    ).rejects.toThrow("fileDrag.executionUnsupported");
    expect(paste).not.toHaveBeenCalled();
  });

  it.each([
    "/usr/bin/env",
    "/bin/bash",
    "docker",
    "podman",
    "kubectl",
    "wsl.exe",
    "mosh",
  ])("refuses unconfirmed wrapper %s", async (command) => {
    const paste = vi.fn();
    await expect(
      pasteWorkspaceFilePaths(
        drag(),
        { ...target, agentId: "claude" },
        services(session({ agentId: "claude", command })),
        () => true,
        paste,
      ),
    ).rejects.toThrow("fileDrag.executionUnsupported");
    expect(paste).not.toHaveBeenCalled();
  });

  it("revalidates runtime-returned relative paths before paste", async () => {
    for (const path of [
      "../secret",
      "/etc/secret",
      "C:/secret",
      "folder/../../secret",
      "a\nb",
      "a\u007fb",
    ]) {
      const api = services();
      const paste = vi.fn();
      api.fileInfo.mockResolvedValue({ path });
      await expect(
        pasteWorkspaceFilePaths(drag(), target, api, () => true, paste),
      ).rejects.toThrow("fileDrag.invalidPath");
      expect(paste).not.toHaveBeenCalled();
    }
  });
});

type AutomaticInputState = Parameters<typeof automaticInputBlocksFileDrop>[0];
function idleAutomaticInput(): AutomaticInputState {
  return {
    nodePending: false,
    launchArmed: false,
    launchTimer: false,
    promptTimer: false,
    creating: false,
    acknowledged: false,
  };
}

describe("file drops do not race automatic Agent input", () => {
  it("allows an idle terminal but blocks each outstanding automatic input source", () => {
    expect(automaticInputBlocksFileDrop(idleAutomaticInput())).toBe(false);
    for (const flag of [
      "nodePending",
      "launchArmed",
      "launchTimer",
      "promptTimer",
      "creating",
    ] as const) {
      expect(
        automaticInputBlocksFileDrop({ ...idleAutomaticInput(), [flag]: true }),
      ).toBe(true);
    }
  });

  it("only considers a sent and acknowledged pending launch settled", () => {
    for (const pendingPhase of ["waiting", "manual"] as const) {
      for (const acknowledged of [false, true]) {
        expect(
          automaticInputBlocksFileDrop({
            ...idleAutomaticInput(),
            pendingPhase,
            acknowledged,
          }),
        ).toBe(true);
      }
    }
    expect(
      automaticInputBlocksFileDrop({
        ...idleAutomaticInput(),
        pendingPhase: "sent",
        acknowledged: false,
      }),
    ).toBe(true);
    expect(
      automaticInputBlocksFileDrop({
        ...idleAutomaticInput(),
        pendingPhase: "sent",
        acknowledged: true,
      }),
    ).toBe(false);
    expect(
      automaticInputBlocksFileDrop({
        ...idleAutomaticInput(),
        pendingPhase: "sent",
        acknowledged: true,
        promptTimer: true,
      }),
    ).toBe(true);
  });

  it("refuses a drop before looking up files while launch input is pending", async () => {
    const paste = vi.fn();
    const api = services();
    await expect(
      pasteWorkspaceFilePaths(
        drag(),
        { ...target, automaticInputPending: true },
        api,
        () => true,
        paste,
      ),
    ).rejects.toThrow("fileDrag.launchPending");
    expect(paste).not.toHaveBeenCalled();
    expect(api.getTerminal).not.toHaveBeenCalled();
    expect(api.fileInfo).not.toHaveBeenCalled();
  });

  it("does not paste if automatic input becomes armed during path resolution", async () => {
    let input = idleAutomaticInput();
    const file = deferred<{ path: string }>();
    const paste = vi.fn();
    const api = services();
    api.fileInfo.mockReturnValue(file.promise);
    const pending = pasteWorkspaceFilePaths(
      drag(),
      target,
      api,
      () => !automaticInputBlocksFileDrop(input),
      paste,
    );
    await vi.waitFor(() => expect(api.fileInfo).toHaveBeenCalledOnce());
    input = { ...input, launchArmed: true };
    file.resolve({ path: "a file's.txt" });
    await expect(pending).rejects.toThrow("fileDrag.destinationChanged");
    expect(paste).not.toHaveBeenCalled();
  });
});

describe("Windows canonical workspace roots", () => {
  const separator = String.fromCharCode(92);
  const extended = separator.repeat(2) + "?" + separator;
  const drive = extended + ["C:", "repo"].join(separator);
  const unc = extended + ["UNC", "server", "share"].join(separator);

  it("turns extended drive roots into normal drive paths only for POSIX shells", () => {
    expect(absoluteWorkspacePath(drive, "a", "bash.exe")).toBe("C:/repo/a");
    expect(absoluteWorkspacePath(drive, "a", "powershell.exe")).toBe(
      drive + separator + "a",
    );
    expect(absoluteWorkspacePath(drive, ".", "bash.exe")).toBe("C:/repo");
    const driveRoot = extended + "C:" + separator;
    expect(absoluteWorkspacePath(driveRoot, ".", "powershell.exe")).toBe(
      driveRoot,
    );
    expect(absoluteWorkspacePath(driveRoot, ".", "bash.exe")).toBe("C:/");
  });

  it("uses a normal UNC spelling in POSIX shells and retains the native extended UNC path", () => {
    expect(absoluteWorkspacePath(unc, "a", "bash.exe")).toBe(
      "//server/share/a",
    );
    expect(absoluteWorkspacePath(unc, "a", "pwsh.exe")).toBe(
      unc + separator + "a",
    );
  });

  it("rejects device namespaces instead of treating them as ordinary UNC shares", () => {
    const device =
      separator.repeat(2) + "." + separator + ["pipe", "agent"].join(separator);
    const volume =
      extended +
      "Volume{2f6f43d0-1234-4567-890a-123456789abc}" +
      separator +
      "repo";
    const global =
      extended +
      ["GLOBALROOT", "Device", "HarddiskVolume1", "repo"].join(separator);
    for (const root of [device, volume, global]) {
      for (const shell of ["bash.exe", "powershell.exe", "cmd.exe"])
        expect(() => absoluteWorkspacePath(root, "a", shell)).toThrow();
    }
  });
});

describe("older Runtime agent identity compatibility", () => {
  it("permits a plain shell when the older response omits agentId", async () => {
    const legacy = session();
    delete legacy.agentId;
    expect(Object.hasOwn(legacy, "agentId")).toBe(false);
    const paste = vi.fn();
    await pasteWorkspaceFilePaths(
      drag(),
      target,
      services(legacy),
      () => true,
      paste,
    );
    expect(paste).toHaveBeenCalledOnce();
  });

  it("does not guess an Agent identity from the command if the response omits agentId", async () => {
    const legacy = session({ command: "claude" });
    delete legacy.agentId;
    const paste = vi.fn();
    await expect(
      pasteWorkspaceFilePaths(
        drag(),
        { ...target, agentId: "claude" },
        services(legacy),
        () => true,
        paste,
      ),
    ).rejects.toThrow("fileDrag.executionUnsupported");
    expect(paste).not.toHaveBeenCalled();
  });
});
