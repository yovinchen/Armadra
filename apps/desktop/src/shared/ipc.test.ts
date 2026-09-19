import { describe, expect, it } from "vitest";
import {
  ALL_CHANNELS,
  IMPLEMENTED_CHANNELS,
  IPC,
  NOT_IMPLEMENTED,
  errorCode,
  ipcError,
  ipcRejection,
} from "./ipc";

/**
 * The table is the contract three processes share, so the properties that make
 * it usable are asserted rather than assumed.
 */
describe("the IPC table", () => {
  it("has no duplicate channel names", () => {
    const names = ALL_CHANNELS.map((spec) => spec.channel);
    expect(new Set(names).size).toBe(names.length);
  });

  it("names every channel `domain:action`", () => {
    for (const spec of ALL_CHANNELS) {
      expect(spec.channel, spec.channel).toMatch(/^[a-z]+:[a-z-]+$/);
    }
  });

  it("records a reach for every channel", () => {
    for (const spec of ALL_CHANNELS) {
      expect(["window", "shared"], spec.channel).toContain(spec.reach);
    }
  });

  it("only claims channels that exist as implemented", () => {
    const declared = new Set(ALL_CHANNELS.map((spec) => spec.channel));
    for (const channel of IMPLEMENTED_CHANNELS)
      expect(declared.has(channel), channel).toBe(true);
  });

  it("implements exactly the channels the shipped batches promised", () => {
    // W1.0/W1.1 answered the first three; W2.1 added the system integration,
    // W2.2 the seven update commands, and W3.3/W3.4 the four browser channels.
    // Everything else in the table still rejects with `not_implemented`, and
    // this list is the record of which batch owes what.
    expect([...IMPLEMENTED_CHANNELS].sort()).toEqual(
      [
        "app:locale",
        "identity:ticket",
        "transport:endpoints",
        "window:is-focused",
        "dialog:pick-directory",
        "dialog:pick-files",
        "shell:open-external",
        "shortcuts:apply",
        "updates:cancel",
        "updates:check",
        "updates:dismiss",
        "updates:download",
        "updates:install",
        "updates:restart-report",
        "updates:state",
        "browser:register",
        "browser:unregister",
        "browser:view",
        "browser:control",
      ].sort(),
    );
  });

  it("keeps the two window events the shell pushes on its own", () => {
    // Neither is in design §2.2: the intercept is a port decided after the
    // table was written, and a main-process notification has nowhere else to
    // report a click to. Both are `window` reach — they mean nothing to a peer
    // that is not this window.
    for (const spec of [IPC.windowKeyIntent, IPC.windowNotificationClick]) {
      expect(spec.direction, spec.channel).toBe("event");
      expect(spec.reach, spec.channel).toBe("window");
    }
  });

  it("keeps the ticket channel to this window alone", () => {
    // A ticket is a credential for THIS page's origin. A remote peer asking
    // for one would be asking the shell to mint a session for a page it is
    // not, so the reach is recorded before any peer exists to ask.
    expect(IPC.identityTicket.reach).toBe("window");
    expect(IPC.identityTicket.direction).toBe("invoke");
  });

  it("covers every domain the migration design §2.2 lists", () => {
    const domains = new Set(
      ALL_CHANNELS.map((spec) => spec.channel.split(":")[0]),
    );
    expect([...domains].sort()).toEqual([
      "app",
      "browser",
      "dialog",
      "identity",
      "shell",
      "shortcuts",
      "transport",
      "updates",
      "window",
    ]);
  });

  it("keeps the seven update commands and their progress event", () => {
    const updates = ALL_CHANNELS.filter((spec) =>
      spec.channel.startsWith("updates:"),
    );
    expect(updates.filter((spec) => spec.direction === "invoke")).toHaveLength(
      7,
    );
    expect(updates.filter((spec) => spec.direction === "event")).toHaveLength(
      1,
    );
    expect(IPC.updatesProgress.direction).toBe("event");
  });

  it("shapes an error as { code, message }", () => {
    expect(ipcError(NOT_IMPLEMENTED, "later")).toEqual({
      code: "not_implemented",
      message: "later",
    });
  });

  it("puts the code where the IPC boundary cannot drop it", () => {
    // Electron serializes a rejected handler's error by message and stack;
    // own properties do not survive. So the page has to be able to read the
    // code back out of the message, however Electron wrapped it.
    const rejection = ipcRejection("scheme_not_allowed", "only http and https");
    expect(rejection.code).toBe("scheme_not_allowed");
    expect(errorCode(rejection)).toBe("scheme_not_allowed");
    expect(
      errorCode(
        new Error(
          `Error invoking remote method 'shell:open-external': Error: ${rejection.message}`,
        ),
      ),
    ).toBe("scheme_not_allowed");
    expect(errorCode(ipcRejection(NOT_IMPLEMENTED, "later"))).toBe(
      NOT_IMPLEMENTED,
    );
  });

  it("reports no code rather than inventing one", () => {
    for (const value of [
      new Error("something went wrong"),
      new Error("Error: plain text"),
      "a string",
      null,
      undefined,
    ])
      expect(errorCode(value), JSON.stringify(value)).toBeUndefined();
  });
});
