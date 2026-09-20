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
    // A 2×2 "icon": one dark pixel, three light ones — enough for the glyph
    // cut-out to have a shape to trim to.
    createFromPath: () => ({
      isEmpty: () => iconEmpty,
      getSize: () => ({ width: 2, height: 2 }),
      toBitmap: () =>
        Buffer.from([
          20, 20, 20, 255, 245, 245, 245, 255, 245, 245, 245, 255, 245, 245,
          245, 255,
        ]),
      resize: () => ({ isEmpty: () => false }),
      setTemplateImage: () => undefined,
    }),
    createFromBitmap: (
      data: Buffer,
      size: { width: number; height: number },
    ) => ({
      resize: () => ({ toPNG: () => Buffer.from([data.length, size.width]) }),
    }),
    createEmpty: () => {
      const image = {
        representations: [] as unknown[],
        addRepresentation: (rep: unknown) => image.representations.push(rep),
        setTemplateImage: (flag: boolean) => {
          templateFlags.push(flag);
        },
        isEmpty: () => false,
      };
      images.push(image);
      return image;
    },
  },
}));

vi.mock("./window", () => ({
  revealWindow: () => reveals.push(1),
}));

vi.mock("./repo-root", () => ({ repoRoot: () => "/repo" }));

const USAGE = JSON.stringify({
  providers: [
    {
      id: "claude",
      status: "ok",
      windows: [
        { label: "5h", usedPercent: 42, resetsAt: null },
        { label: "7d", usedPercent: 13, resetsAt: null },
      ],
    },
    { id: "codex", status: "error", reason: "network", windows: [] },
  ],
});
const COST = JSON.stringify({ status: "ok", today: { costUsd: 3.5 } });
const images: { representations: unknown[] }[] = [];
const templateFlags: boolean[] = [];

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
  images.length = 0;
  templateFlags.length = 0;
  answers = {
    "/api/usage": USAGE,
    "/api/usage/cost": COST,
    "/api/settings": "{}",
  };
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

describe("the menu-bar glyph", () => {
  it("is a template image with a 1× and a 2× representation on macOS", async () => {
    await startTray();
    if (process.platform !== "darwin") return;
    expect(images).toHaveLength(1);
    expect(
      images[0]?.representations.map(
        (r) => (r as { scaleFactor: number }).scaleFactor,
      ),
    ).toEqual([1, 2]);
    expect(templateFlags).toEqual([true]);
  });
});

describe("the usage readout", () => {
  it("is one line per provider plus today's cost, drawn from the core's answers", async () => {
    await startTray();
    const labels = lastMenu().map((item) => item.label);
    expect(labels[0]).toBe("Claude · 5h 42% · 7d 13%");
    expect(labels[1]).toBe("Codex · cannot reach the usage endpoint");
    expect(labels[2]).toBe("Local cost today $3.50");
    // A readout, not an action.
    expect(lastMenu()[0]?.enabled).toBe(false);
    expect(lastMenu()[2]?.enabled).toBe(false);
  });

  it("keeps the previous reading when the next poll fails", async () => {
    const module = await startTray();
    const before = lastMenu().map((item) => item.label);

    answers["/api/usage"] = null;
    answers["/api/usage/cost"] = null;
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 10);

    // The Runtime restarting, or being a second slow, must not blank a strip
    // the user is looking at.
    expect(lastMenu().map((item) => item.label)).toEqual(before);
    module.destroyTray();
  });

  it("keeps the previous reading when the body is unreadable", async () => {
    const module = await startTray();
    const before = lastMenu().map((item) => item.label);

    answers["/api/usage"] = "not json";
    answers["/api/usage/cost"] = "not json";
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 10);

    expect(lastMenu().map((item) => item.label)).toEqual(before);
    module.destroyTray();
  });
});

describe("the polling loop", () => {
  it("re-reads the refresh setting every round, so a change needs no restart", async () => {
    const module = await startTray();
    expect(requested).toEqual([
      "/api/usage",
      "/api/usage/cost",
      "/api/settings",
    ]);

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
