import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The tray, against a stand-in Electron and a stand-in Runtime.
 *
 * The rule the whole module is built around is **unknown is not zero**: a
 * fetch that fails keeps the previous reading rather than redrawing the strip
 * as two unknowns. That rule lives in `shell-core/usage.ts` and is tested
 * there on its own; what can only be tested here is whether the polling loop
 * actually honours it — a `catch` that redrew would pass every pure test.
 */

interface MenuItem {
  label?: string;
  enabled?: boolean;
  type?: string;
}

const built: MenuItem[][] = [];
const trays: FakeTray[] = [];
const reveals: number[] = [];
const quits: number[] = [];
let iconEmpty = false;

class FakeTray {
  destroyed = false;
  menus: MenuItem[][] = [];
  tooltip = "";
  readonly handlers = new Map<string, () => void>();
  setContextMenu(menu: { template: MenuItem[] }) {
    this.menus.push(menu.template);
  }
  setToolTip(text: string) {
    this.tooltip = text;
  }
  on(event: string, listener: () => void) {
    this.handlers.set(event, listener);
  }
  destroy() {
    this.destroyed = true;
  }
}

vi.mock("electron", () => ({
  Menu: {
    buildFromTemplate: (template: MenuItem[]) => {
      built.push(template);
      return { template };
    },
  },
  Tray: class {
    constructor() {
      const tray = new FakeTray();
      trays.push(tray);
      return tray as unknown as object;
    }
  },
  app: {
    getLocale: () => "en",
    quit: () => quits.push(1),
  },
  nativeImage: {
    createFromPath: () => ({
      isEmpty: () => iconEmpty,
      setTemplateImage: () => undefined,
    }),
  },
}));

vi.mock("./window", () => ({
  revealWindow: () => reveals.push(1),
}));

vi.mock("./repo-root", () => ({ repoRoot: () => "/repo" }));

const MINI = JSON.stringify({
  session: { provider: "anthropic", label: "5h", usedPercent: 42 },
  week: { provider: "anthropic", label: "7d", usedPercent: 13 },
});

/** What the fake Runtime answers next, per path. `null` = the fetch fails. */
let answers: Record<string, string | null> = {};
const requested: string[] = [];

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  built.length = 0;
  trays.length = 0;
  reveals.length = 0;
  quits.length = 0;
  requested.length = 0;
  iconEmpty = false;
  answers = { "/api/usage/mini": MINI, "/api/settings": "{}" };
  vi.stubGlobal("fetch", async (url: string) => {
    const path = url.replace("http://runtime", "");
    requested.push(path);
    const body = answers[path];
    if (body === null || body === undefined) throw new Error("unreachable");
    return { ok: true, text: async () => body };
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function startTray() {
  const module = await import("./tray");
  module.createTray({
    runtimeBase: async () => "http://runtime",
    quit: () => quits.push(2),
  });
  // Let the first poll's awaits settle.
  await vi.advanceTimersByTimeAsync(0);
  return module;
}

function lastMenu(): MenuItem[] {
  return trays[0]?.menus.at(-1) ?? [];
}

describe("the usage strip", () => {
  it("is drawn from what the Runtime answered", async () => {
    await startTray();
    const labels = lastMenu().map((item) => item.label);
    expect(labels[0]).toContain("42%");
    expect(labels[1]).toContain("13%");
    // A readout, not an action.
    expect(lastMenu()[0]?.enabled).toBe(false);
    expect(lastMenu()[1]?.enabled).toBe(false);
  });

  it("keeps the previous reading when the next poll fails", async () => {
    const module = await startTray();
    const before = lastMenu().map((item) => item.label);

    answers["/api/usage/mini"] = null;
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 10);

    // The Runtime restarting, or being a second slow, must not blank a strip
    // the user is looking at.
    expect(lastMenu().map((item) => item.label)).toEqual(before);
    module.destroyTray();
  });

  it("keeps the previous reading when the body is unreadable", async () => {
    const module = await startTray();
    const before = lastMenu().map((item) => item.label);

    answers["/api/usage/mini"] = "not json";
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 10);

    expect(lastMenu().map((item) => item.label)).toEqual(before);
    module.destroyTray();
  });
});

describe("the polling loop", () => {
  it("re-reads the refresh setting every round, so a change needs no restart", async () => {
    const module = await startTray();
    expect(requested).toEqual(["/api/usage/mini", "/api/settings"]);

    // 1 minute is below the ceiling, so the interval clamps to 60s.
    answers["/api/settings"] = JSON.stringify({ usage: { refreshMinutes: 1 } });
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 10);
    const rounds = requested.length;
    await vi.advanceTimersByTimeAsync(60_000 + 10);
    expect(requested.length).toBeGreaterThan(rounds);
    module.destroyTray();
  });

  it("stops for good once the tray is destroyed", async () => {
    const module = await startTray();
    module.destroyTray();
    const rounds = requested.length;
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(requested.length).toBe(rounds);
    expect(trays[0]?.destroyed).toBe(true);
  });
});

describe("the tray menu", () => {
  it("shows the restart item exactly while an update is staged", async () => {
    const module = await startTray();
    const restarts: number[] = [];
    expect(lastMenu().some((item) => item.label?.includes("Restart"))).toBe(
      false,
    );

    module.setUpdateStaged(true, () => restarts.push(1));
    const item = lastMenu().find((each) => each.label?.includes("Restart"));
    expect(item).toBeDefined();

    module.setUpdateStaged(false, () => restarts.push(1));
    expect(lastMenu().some((each) => each.label?.includes("Restart"))).toBe(
      false,
    );
    module.destroyTray();
  });

  it("brings the window back on a left click", async () => {
    const module = await startTray();
    trays[0]?.handlers.get("click")?.();
    expect(reveals).toHaveLength(1);
    module.destroyTray();
  });

  it("quits through the sequence the assembly supplied, not app.quit", async () => {
    const module = await startTray();
    const quit = lastMenu().find(
      (item) => item.label === "Quit and stop background services",
    );
    expect(quit).toBeDefined();
    (quit as unknown as { click: () => void }).click();
    // The graceful shutdown belongs to `main/index.ts`; the tray only calls it.
    expect(quits).toEqual([2]);
    module.destroyTray();
  });
});

describe("a tray icon that will not load", () => {
  it("is reported rather than left as an invisible click target", async () => {
    iconEmpty = true;
    const written: string[] = [];
    const write = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: unknown) => {
        written.push(String(chunk));
        return true;
      });

    const module = await import("./tray");
    module.createTray({
      runtimeBase: async () => "http://runtime",
      quit: () => undefined,
    });

    expect(trays).toHaveLength(0);
    expect(written.join("")).toContain("Tray icon could not be loaded");
    write.mockRestore();
  });
});
