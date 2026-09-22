import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Dock icon, the menu bar name and the About panel all read from the
 * SAME call, `app.setName`, and Electron only honours it before
 * `app.whenReady()` resolves — called afterward, the Dock keeps showing
 * "Electron" for the rest of the run (the bug this module fixes). The fake
 * `app` below records call ORDER against a `ready` flag so
 * `setApplicationName` calling too late is a failing assertion, not a manual
 * check against a real Dock.
 */

const calls: string[] = [];
let ready = false;

vi.mock("electron", () => ({
  app: {
    setName: (name: string) => {
      calls.push(`setName:${name}:ready=${ready}`);
    },
    getVersion: () => "0.1.0",
    setAboutPanelOptions: (options: Record<string, unknown>) => {
      calls.push(`setAboutPanelOptions:${JSON.stringify(options)}`);
    },
    dock: {
      setIcon: (path: string) => {
        calls.push(`dock.setIcon:${path}`);
      },
    },
  },
}));

import {
  APP_NAME,
  aboutPanelOptions,
  iconPath,
  setAboutPanel,
  setApplicationName,
  setDockIcon,
} from "./branding";

beforeEach(() => {
  calls.length = 0;
  ready = false;
});

describe("the application name", () => {
  it("is set before the app is ready", () => {
    setApplicationName();
    ready = true;
    expect(calls).toEqual([`setName:${APP_NAME}:ready=false`]);
  });
});

describe("the development Dock icon", () => {
  it("is set from the repository's build/icons/icon.png", () => {
    setDockIcon("/repo/apps/desktop/build/icons/icon.png", "darwin");
    expect(calls).toEqual([
      "dock.setIcon:/repo/apps/desktop/build/icons/icon.png",
    ]);
  });

  it("does nothing where there is no Dock", () => {
    setDockIcon("/repo/apps/desktop/build/icons/icon.png", "linux");
    setDockIcon("/repo/apps/desktop/build/icons/icon.png", "win32");
    expect(calls).toEqual([]);
  });
});

describe("the About panel", () => {
  it("carries the product name, the running version and an icon", () => {
    const options = aboutPanelOptions("1.2.3", "/repo/icon.png");
    expect(options.applicationName).toBe(APP_NAME);
    expect(options.applicationVersion).toBe("1.2.3");
    expect(options.iconPath).toBe("/repo/icon.png");
    expect(options.copyright).toMatch(/^Copyright © \d{4} /);
  });

  it("omits iconPath when no development override is given", () => {
    const options = aboutPanelOptions("1.2.3");
    expect(options.iconPath).toBeUndefined();
  });

  it("is wired from the running app's own version", () => {
    setAboutPanel("/repo/icon.png");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("setAboutPanelOptions:");
    const [, json] = calls[0]!.split(/:(.+)/s);
    const parsed = JSON.parse(json!);
    expect(parsed).toEqual({
      applicationName: APP_NAME,
      applicationVersion: "0.1.0",
      copyright: expect.stringMatching(/^Copyright © \d{4} /),
      iconPath: "/repo/icon.png",
    });
  });
});

describe("iconPath", () => {
  it("resolves under the repository's build/icons/icon.png", () => {
    const resolved = iconPath("/repo/apps/desktop/out/main");
    // `repoRoot` resolves, which on Windows means the answer carries a drive
    // letter and backslashes; the expectation is built the same way.
    expect(resolved).toBe(
      join(resolve("/repo"), "apps", "desktop", "build", "icons", "icon.png"),
    );
  });
});
