import { Menu, Tray, app, nativeImage } from "electron";
import { join } from "node:path";
import {
  localeFromTag,
  shellText,
  type ShellLocale,
} from "../shell-core/messages";
import {
  parseMiniUsage,
  pollIntervalMs,
  refreshMinutes,
  usageLines,
  type MiniUsage,
} from "../shell-core/usage";
import { repoRoot } from "./repo-root";
import { revealWindow } from "./window";

/**
 * The tray icon, its menu, and the usage strip at the top of it.
 *
 * Ported from `src-tauri/src/main.rs:177-249` + `usage.rs`. Two differences,
 * both forced by Electron rather than chosen: a `Menu` is immutable once
 * built, so every refresh REBUILDS it (muda could rewrite a label in place),
 * and the polling loop is a `setTimeout` chain instead of a Tokio task.
 *
 * The rule the strip is built around is unchanged and lives in
 * `shell-core/usage.ts`: **unknown is not zero**, and a fetch that fails keeps
 * the previous reading rather than redrawing the rows as two unknowns.
 */

let tray: Tray | null = null;
let locale: ShellLocale = "zh-CN";
/** The last reading that arrived. Kept across failures on purpose. */
let usage: MiniUsage | null = null;
/** Whether an update is staged. W2.2 owns the flow; the item is its door. */
let updateStaged = false;
let onRestart: () => void = () => undefined;
let timer: ReturnType<typeof setTimeout> | null = null;
let stopped = false;

/** What the quit item does. Supplied by the assembly, because the graceful
 * shutdown sequence is `main/index.ts`'s, not the tray's. */
let onQuit: () => void = () => app.quit();

function icon(): Electron.NativeImage {
  // The same icon set electron-builder packages from (`build/icons/`), shared
  // rather than duplicated. A template image so macOS tints it for light and
  // dark menu bars by itself.
  const image = nativeImage.createFromPath(
    join(repoRoot(), "apps/desktop/build/icons/32x32.png"),
  );
  if (!image.isEmpty() && process.platform === "darwin")
    image.setTemplateImage(true);
  return image;
}

function buildMenu(): Menu {
  const [session, week] = usageLines(
    {
      session: shellText(locale, "tray.usage.session"),
      week: shellText(locale, "tray.usage.week"),
      unknown: shellText(locale, "tray.usage.unknown"),
    },
    usage,
  );
  return Menu.buildFromTemplate([
    // A readout, not an action: the two rows are disabled so clicking them
    // does nothing rather than doing something unstated.
    { label: session, enabled: false },
    { label: week, enabled: false },
    { type: "separator" },
    // Present exactly while an update is staged. An item that is always there
    // but disabled would say the feature exists and is unavailable, when the
    // truth is that there is nothing to restart into (`main.rs:255-262`).
    ...(updateStaged
      ? [
          {
            label: shellText(locale, "tray.updateRestart"),
            click: () => onRestart(),
          } satisfies Electron.MenuItemConstructorOptions,
        ]
      : []),
    {
      label: shellText(locale, "tray.showWindow"),
      click: () => revealWindow(),
    },
    { label: shellText(locale, "tray.quit"), click: () => onQuit() },
  ]);
}

function redraw(): void {
  tray?.setContextMenu(buildMenu());
}

/** Shows the restart item exactly while an update is staged. W2.2 calls this. */
export function setUpdateStaged(staged: boolean, restart: () => void): void {
  onRestart = restart;
  if (updateStaged === staged) return;
  updateStaged = staged;
  redraw();
}

export interface TrayOptions {
  /** Where the Runtime is, resolved at poll time: the address is published
   * after startup and can change when the Runtime restarts. */
  readonly runtimeBase: () => Promise<string>;
  /** The graceful quit sequence. */
  readonly quit: () => void;
}

export function createTray(options: TrayOptions): void {
  if (tray) return;
  locale = localeFromTag(app.getLocale());
  onQuit = options.quit;
  const image = icon();
  if (image.isEmpty()) {
    // A tray with no image is an invisible click target. Say so instead of
    // leaving the user wondering where the icon went.
    process.stderr.write("Tray icon could not be loaded; tray disabled\n");
    return;
  }
  tray = new Tray(image);
  tray.setToolTip("Armadra");
  redraw();
  // 左键留给「点一下把窗口叫回来」，菜单只从右键出。
  tray.on("click", () => revealWindow());
  void poll(options.runtimeBase);
}

export function destroyTray(): void {
  stopped = true;
  if (timer) clearTimeout(timer);
  timer = null;
  tray?.destroy();
  tray = null;
}

async function fetchText(base: string, path: string): Promise<string | null> {
  try {
    const response = await fetch(`${base}${path}`, {
      signal: AbortSignal.timeout(5_000),
    });
    return response.ok ? await response.text() : null;
  } catch {
    return null;
  }
}

/**
 * One poll, then schedule the next.
 *
 * A failure leaves `usage` alone: the Runtime restarting, or being a second
 * slow, must not blank a strip the user is looking at. The interval follows
 * `usage.refreshMinutes` within the bounds `shell-core/usage.ts` sets, and is
 * re-read every round so a settings change takes effect without a restart.
 */
async function poll(runtimeBase: () => Promise<string>): Promise<void> {
  if (stopped) return;
  let interval = pollIntervalMs(null);
  try {
    const base = await runtimeBase();
    const mini = await fetchText(base, "/api/usage/mini");
    if (mini !== null) {
      const parsed = parseMiniUsage(mini);
      if (parsed) {
        usage = parsed;
        redraw();
      }
    }
    const settings = await fetchText(base, "/api/settings");
    interval = pollIntervalMs(
      settings === null ? null : refreshMinutes(settings),
    );
  } catch {
    // Same rule as a failed fetch: keep the last reading and try again.
  }
  if (stopped) return;
  timer = setTimeout(() => void poll(runtimeBase), interval);
  // The poll must never be the reason the process stays alive at quit.
  timer.unref?.();
}
