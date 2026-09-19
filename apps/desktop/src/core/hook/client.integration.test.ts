import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { validPendingId, writeAnswerFile } from "./approvals";
import { registerCollabDispatcher } from "./collab";
import { type HookFixture, hookFixture } from "./fixture";
import { pendingDir } from "../paths";

/**
 * The real `armadra-hook` client against this core's socket.
 *
 * Every other suite drives the router directly, which proves the logic and
 * nothing about the wire: the client speaks hand-rolled HTTP/1.1 with a fixed
 * header order over a unix socket, re-reads the endpoint file on every
 * invocation, and fails *open* on anything it does not understand — so a core
 * that answered 500 to every report would look identical to one that worked.
 * This drives the binary itself.
 *
 * The binary is optional: a checkout that has not built it skips rather than
 * fails, because what is being asserted is the core's half of the contract and
 * not which toolchains happen to be installed here.
 */

const here = dirname(fileURLToPath(import.meta.url));
const CLIENT = resolve(here, "../../../../../target/debug/armadra-hook");

function haveClient(): boolean {
  try {
    return statSync(CLIENT).isFile();
  } catch {
    return false;
  }
}

let open: HookFixture[] = [];
let release: (() => void) | undefined;

async function fixture(): Promise<HookFixture> {
  const made = hookFixture();
  open.push(made);
  const path = made.service.socketPath() as string;
  await made.server.listen({ kind: "unix", path });
  // The endpoint file is what the client reads; it has to name the socket we
  // just bound and carry this run's bearer.
  made.service.publishEndpoint(undefined);
  return made;
}

afterEach(async () => {
  release?.();
  release = undefined;
  for (const one of open) {
    await one.server.close();
    one.close();
  }
  open = [];
});

/**
 * Runs the client and collects its three outcomes.
 *
 * Asynchronous on purpose: `spawnSync` would block this process' event loop,
 * and this process is the one serving the socket the client is dialling — the
 * client would sit out its whole 1.5s budget waiting for an accept that cannot
 * happen until it has already exited.
 */
function run(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  input?: string,
): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(CLIENT, [...args], { env });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) =>
      resolve({ status: status ?? -1, stdout, stderr }),
    );
    child.stdin.end(input ?? "");
  });
}

/** The environment an agent PTY gets — contract §5, item 5, and no more. */
function agentEnv(one: HookFixture): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    ARMADRA_NODE_ID: one.nodeId,
    ARMADRA_AGENT_ID: "claude",
    ARMADRA_ENDPOINT_FILE: one.service.endpointFile(),
    ARMADRA_CANVAS_CONTROL: "1",
  };
}

describe.skipIf(!haveClient() || process.platform === "win32")(
  "the armadra-hook client",
  () => {
    it("reports a turn over the socket and the row moves", async () => {
      const one = await fixture();
      one.service.issueNodeToken(one.nodeId);
      const env = agentEnv(one);

      for (const [payload, state] of [
        [{ hook_event_name: "UserPromptSubmit", prompt: "go" }, "working"],
        [{ hook_event_name: "Stop", last_assistant_message: "done" }, "done"],
      ] as const) {
        const answer = await run(["claude"], env, JSON.stringify(payload));
        // Hook mode always exits 0 and prints nothing: Claude injects hook
        // stdout into the model's context on several events.
        expect(answer.status, answer.stderr).toBe(0);
        expect(answer.stdout).toBe("");
        expect(one.status()?.state).toBe(state);
      }

      const status = one.status();
      // The node token the client read off `<data>/node-tokens/<nodeId>` is
      // this core's, so the row is verified rather than merely accepted.
      expect(status?.verified).toBe(true);
      expect(status?.stateSource).toBe("hook");
      expect(status?.unread).toBe(true);
    });

    it("is accepted but unverified without a node token file", async () => {
      const one = await fixture();
      // No `issueNodeToken`: the client finds no file and sends no header.
      const answer = await run(
        ["claude"],
        agentEnv(one),
        JSON.stringify({ hook_event_name: "UserPromptSubmit" }),
      );
      expect(answer.status).toBe(0);
      expect(one.status()?.state).toBe("working");
      expect(one.status()?.verified).toBe(false);
    });

    it("passes the bearer on the collaboration door", async () => {
      const one = await fixture();
      one.service.issueNodeToken(one.nodeId);
      const seen: string[] = [];
      release = registerCollabDispatcher("context-link", (request) => {
        seen.push(`${request.verb}:${String(request.caller.verified)}`);
        return { kind: "text", status: 200, body: "no linked nodes\n" };
      });

      const answer = await run(["context", "list"], agentEnv(one));
      expect(answer.status, answer.stderr).toBe(0);
      // The client prints the prose body verbatim into the agent's stdout.
      expect(answer.stdout).toBe("no linked nodes\n");
      expect(seen).toEqual(["list:true"]);
    });

    it("reports the endpoint to its own doctor", async () => {
      const one = await fixture();
      one.service.issueNodeToken(one.nodeId);
      const answer = await run(["doctor"], agentEnv(one));
      expect(answer.status, answer.stderr).toBe(0);
      expect(answer.stdout).toContain(one.service.endpointFile());
    });

    /**
     * The permission round trip, end to end (contract §5.5).
     *
     * `ARMADRA_PERM_WAIT_SECS` switches the client from "report and exit" to
     * "write `<data>/pending/<id>.json`, poll for `<id>.answer`, print the
     * decision". The canvas answering is what writes that file, and what the
     * CLI reads is the exact JSON Claude parses — so both halves are checked
     * here rather than asserted about separately.
     */
    it("answers a waiting permission request through the pending file", async () => {
      const one = await fixture();
      one.service.issueNodeToken(one.nodeId);
      const directory = pendingDir(one.core.directory);
      const waiting = run(
        ["claude"],
        { ...agentEnv(one), ARMADRA_PERM_WAIT_SECS: "20" },
        JSON.stringify({
          hook_event_name: "PermissionRequest",
          tool_name: "Bash",
          tool_input: { command: "rm -rf ." },
        }),
      );

      // The client mints the id, so the canvas learns it from the row the
      // report wrote — which is exactly how the approval card gets it.
      const pendingId = await new Promise<string>((resolve, reject) => {
        const started = Date.now();
        const poll = (): void => {
          const id = one.status()?.pendingId;
          if (id !== undefined) return resolve(id);
          if (Date.now() - started > 10_000) {
            return reject(new Error("the report never arrived"));
          }
          setTimeout(poll, 20);
        };
        poll();
      });
      expect(one.status()?.state).toBe("blocked");
      expect(validPendingId(pendingId)).toBe(true);
      expect(existsSync(join(directory, `${pendingId}.json`))).toBe(true);

      expect(writeAnswerFile(directory, pendingId, "allow")).toBe(true);
      const answer = await waiting;
      expect(answer.status, answer.stderr).toBe(0);
      // The exact document Claude parses out of a PermissionRequest hook.
      expect(JSON.parse(answer.stdout)).toEqual({
        hookSpecificOutput: {
          hookEventName: "PermissionRequest",
          decision: { behavior: "allow" },
        },
      });
      // The client removes both files once it has the decision.
      expect(existsSync(join(directory, `${pendingId}.json`))).toBe(false);
      expect(existsSync(join(directory, `${pendingId}.answer`))).toBe(false);
    });

    /**
     * The endpoint file is a POSIX document by contract, and the client is not
     * the only reader: the generated extensions parse it, and a person
     * debugging sources it. `sh` agreeing with us is the check that matters.
     */
    it("writes an endpoint file a shell can source", async () => {
      const one = await fixture();
      const rendered = readFileSync(one.service.endpointFile(), "utf8");
      const stdout = execFileSync(
        "/bin/sh",
        [
          "-c",
          `${rendered}\nprintf '%s|%s' "$ARMADRA_HOOK_SOCK" "$ARMADRA_HOOK_VERSION"`,
        ],
        { encoding: "utf8" },
      );
      expect(stdout).toBe(`${one.service.socketPath() as string}|1`);
      expect(existsSync(one.service.socketPath() as string)).toBe(true);
    });
  },
);
