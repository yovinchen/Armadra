import { app } from "electron";
import { join } from "node:path";
import { repoRoot } from "./repo-root";

/**
 * The one name this shell answers to, everywhere the OS shows an app name:
 * the Dock, the menu bar, window titles, the About panel, task switchers.
 *
 * `APP_NAME` is the single literal; every other export below is a pure
 * function of it (plus whatever else the caller supplies), so a rename is one
 * line and every surface that reads from this module follows without a
 * second place to remember.
 */
export const APP_NAME = "Armadra";

/**
 * Where the packaged icon lives, resolved the same way the Runtime and Host
 * binaries are (`repo-root.ts`): under the repository root in development,
 * four levels above the built main bundle inside the asar alike.
 *
 * Only used for the DEVELOPMENT Dock icon and window icon — a packaged build
 * gets its icon from `electron-builder.yml`'s `mac.icon` / `win.icon` /
 * `linux.icon`, which electron-builder bakes into the bundle itself.
 */
export function iconPath(from: string = __dirname): string {
  return join(repoRoot(from), "apps/desktop/build/icons/icon.png");
}

/**
 * The About panel's fields, as a plain object — pure, so the ordering and
 * content are testable without an Electron process to host them in.
 *
 * `applicationVersion` is the caller's `app.getVersion()`, not a literal
 * here: it comes from `package.json` at build time and this module has no
 * business re-stating it.
 */
export function aboutPanelOptions(
  applicationVersion: string,
  icon?: string,
): {
  applicationName: string;
  applicationVersion: string;
  copyright: string;
  iconPath?: string;
} {
  return {
    applicationName: APP_NAME,
    applicationVersion,
    copyright: `Copyright © ${new Date().getFullYear()} YoVinchen`,
    ...(icon ? { iconPath: icon } : {}),
  };
}

/**
 * The thin assembly other modules must not repeat.
 *
 * `app.setName` runs before `app.whenReady()` on purpose — Electron reads the
 * process name for the Dock and the menu bar at ready time, so a call placed
 * inside the `whenReady().then()` callback is already too late and the Dock
 * keeps showing "Electron" for the rest of the run (the bug this task fixes).
 * `setDockIcon` and `setAboutPanel`, by contrast, both need an app instance
 * that behaves like the running one (`app.dock`, `app.setAboutPanelOptions`),
 * so callers invoke them once ready.
 */
export function setApplicationName(): void {
  app.setName(APP_NAME);
}

/**
 * The development-mode Dock icon. Packaged builds never call this: their icon
 * is `electron-builder.yml`'s `mac.icon`, already inside the bundle.
 */
export function setDockIcon(
  icon: string = iconPath(),
  platform: NodeJS.Platform = process.platform,
): void {
  // Only macOS has a Dock; on the other platforms the window icon is the brand.
  if (platform !== "darwin") return;
  app.dock?.setIcon(icon);
}

/**
 * `icon` is a development-only override (`iconPath()`); a packaged build
 * omits it — `build/icons/` is not part of the shipped bundle, only the
 * electron-builder inputs that produced the platform icon already inside
 * it — and the About panel then falls back to the app's own bundle icon.
 */
export function setAboutPanel(icon?: string): void {
  app.setAboutPanelOptions(aboutPanelOptions(app.getVersion(), icon));
}
