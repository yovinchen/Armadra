import { afterEach, describe, expect, it } from "vitest";
import type { CoreContext } from "../main";
import { collab, setTerminalBridge } from "../agent";
import type { TerminalBridge } from "../collab/service";
import { fixture, type Fixture } from "../workspaces/fixture";
import { install as installWorkspaces } from "../workspaces/routes";
import { install as installCanvas } from "../canvas/routes";
import { install as installAgents } from "../agent";
import { install } from "./install";

/**
 * The PTY the collaboration verbs borrow.
 *
 * The seam existed and nothing ever filled it, so `context terminal`,
 * `canvas interrupt`, `canvas close`, the title suggestion and every scheduled
 * delivery all refused with "the terminal domain is not assembled" while the
 * panes were running. The suite therefore asserts the *wiring* — that
 * assembling the two domains in the order `DOMAINS` uses leaves a live bridge
 * on the collaboration context — and then that the bridge really reaches a PTY.
 */

const unix = process.platform !== "win32";
const describeUnix = unix ? describe : describe.skip;

let open: Fixture | undefined;
let stop: (() => Promise<void>) | undefined;

afterEach(async () => {
  await stop?.();
  stop = undefined;
  setTerminalBridge(undefined);
  open?.close();
  open = undefined;
});

async function core(): Promise<{ workspaceId: string; bridge: TerminalBridge }> {
  open = fixture([
    installWorkspaces,
    installCanvas,
    // Agents before terminals, exactly as `DOMAINS` orders them: the seam has
    // to exist before anything can be handed to it.
    installAgents,
    (context: CoreContext) => {
      const domain = install(context, { configured: "direct" });
      stop = () => domain.stop();
    },
  ]);
  const workspaces = (await open.call("GET", "/api/workspaces")).body as {
    id: string;
  }[];
  const bridge = collab()?.terminals;
  expect(bridge, "the terminal domain left no bridge on the collab context")
    .toBeDefined();
  return { workspaceId: (workspaces[0] as { id: string }).id, bridge: bridge! };
}

async function settled(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error("never settled");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describeUnix("the terminal bridge", () => {
  it("reaches a live pane, and knows whose session it is", async () => {
    const { workspaceId, bridge } = await core();
    const node = "11111111-2222-4333-8444-555555555555";
    const session = (
      await open!.call("POST", "/api/terminals", {
        workspaceId,
        cwd: open!.directory,
        command: "/bin/sh",
        args: ["-c", "read line; printf 'saw-[%s]\\n' \"$line\"; sleep 60"],
        nodeId: node,
      })
    ).body as { id: string; generation: number };

    expect(bridge.generation(session.id)).toBe(session.generation);
    expect(
      await bridge.isCurrentNodeSession(node, session.id, session.generation),
    ).toBe(true);
    // A generation that has moved on, and somebody else's node: both refused
    // rather than answered about the pane that *is* there.
    expect(
      await bridge.isCurrentNodeSession(node, session.id, session.generation + 1),
    ).toBe(false);
    expect(
      await bridge.isCurrentNodeSession(
        "99999999-2222-4333-8444-555555555555",
        session.id,
        session.generation,
      ),
    ).toBe(false);

    await bridge.write(session.id, session.generation, "typed-through\n");
    await settled(async () =>
      (await bridge.capture(session.id, 40, false)).data.includes(
        "saw-[typed-through]",
      ),
    );
    // Escapes off is what both callers ask for: a screen on its way to a model
    // or to a title wants the characters, not the SGR around them.
    const plain = await bridge.capture(session.id, 40, false);
    expect(plain.data).not.toMatch(/\[/);
    expect(plain.lines).toBeGreaterThan(0);

    const foreground = await bridge.foreground(session.id);
    expect(foreground?.command ?? "").toContain("sh");

    await bridge.terminate(session.id, "session");
    await settled(async () => bridge.generation(session.id) === undefined ||
      !(await bridge.isCurrentNodeSession(node, session.id, session.generation)));
  }, 60_000);

  it("is withdrawn when the domain stops", async () => {
    await core();
    expect(collab()?.terminals).toBeDefined();
    await stop?.();
    stop = undefined;
    // "Nothing to talk to" rather than "that session is missing".
    expect(collab()?.terminals).toBeUndefined();
  }, 60_000);
});
