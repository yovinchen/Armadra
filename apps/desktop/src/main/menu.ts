import {
  Menu,
  app,
  type BrowserWindow,
  type MenuItemConstructorOptions,
} from "electron";
import { IPC } from "../shared/ipc";
import {
  KEY_INTENT_REPLY_TIMEOUT_MS,
  KeyIntentArbiter,
} from "../shell-core/key-intent";
import {
  keydownIntercept,
  type KeyIntent,
} from "../shell-core/keydown-intercept";
import {
  localeFromTag,
  shellText,
  type ShellLocale,
} from "../shell-core/messages";
import { closeWindow, revealWindow, sendToWindow } from "./window";

/**
 * The application menu, and the chords the main process claims back from it.
 *
 * The two belong in one file because they are two halves of one decision: a
 * menu item's accelerator is handled ABOVE the web contents, so every chord
 * the menu owns is a chord the page can never see. The menu below therefore
 * carries as few accelerators as it can get away with, and the closed list in
 * `shell-core/keydown-intercept.ts` names the one it has to take back.
 */

/** The chords still waiting for the page to say whether it took them. */
const intents = new KeyIntentArbiter();

/**
 * `window:key-intent-result`. The page answering one claimed chord.
 *
 * The same function is what the timeout calls with `handled: false`, so the
 * two paths cannot drift: exactly one of them settles each token, and the
 * shell's own half runs exactly when the page did not take it.
 */
export function settleKeyIntent(token: unknown, handled: unknown): void {
  const outcome = intents.settle(token, handled);
  if (outcome.verdict !== "shell") return;
  if (outcome.intent === "close-window") closeWindow();
}

/**
 * Claims one chord and starts its round trip.
 *
 * ASK, do not act. The canvas may want to close a node first and only the
 * page knows whether there is one; the shell used to send the intent and
 * close the window in the same breath, which made the page's half
 * unreachable. The timer is what keeps ⌘W from ever doing nothing: a page
 * that does not answer gets its window closed anyway.
 *
 * Exported because the host window is no longer the only place a claimed
 * chord can be typed. A `<webview>` guest is a separate renderer with its own
 * `before-input-event`, and ⌘W inside one used to reach nothing at all — not
 * the menu (its accelerator is deliberately absent), not the window's
 * intercept (it never sees guest input), and not the page. The guest side
 * (`main/browser/index.ts`) calls this so both sources settle through the
 * SAME arbiter; a second copy of the timeout rule is exactly the divergence
 * `key-intent.ts` was written to prevent.
 */
export function claimKeyIntent(intent: KeyIntent): void {
  const token = intents.open(intent);
  sendToWindow(IPC.windowKeyIntent.channel, intent, token);
  const timer = setTimeout(
    () => settleKeyIntent(token, false),
    KEY_INTENT_REPLY_TIMEOUT_MS,
  );
  // A pending chord must never be the reason the process stays alive at quit.
  timer.unref?.();
}

/** Installed per window, because `before-input-event` is a webContents event. */
export function installKeydownIntercept(window: BrowserWindow): void {
  window.webContents.on("before-input-event", (event, input) => {
    const intent = keydownIntercept(
      {
        type: input.type,
        key: input.key,
        meta: input.meta,
        control: input.control,
        shift: input.shift,
        alt: input.alt,
      },
      process.platform,
    );
    if (intent === null) return;
    // Claimed means claimed: neither the menu nor the page may also act on it.
    event.preventDefault();
    claimKeyIntent(intent);
  });
}

function template(locale: ShellLocale): MenuItemConstructorOptions[] {
  if (process.platform === "darwin") {
    // macOS gets Electron's own default submenus through their roles: the
    // About/Services/Hide/Quit block, the full edit menu with the system
    // dictation and emoji items, and the window menu macOS expects to manage.
    // Rebuilding those by hand is how an app ends up missing Services or
    // Hide Others, which are conventions rather than features.
    //
    // The default File menu is deliberately NOT here: its only item is Close
    // Window on ⌘W, and that chord is claimed by the intercept above.
    // `label` is explicit rather than left to `role: "appMenu"`'s own
    // default: that default reads `app.name` at menu-build time too, but
    // naming it here is the one place a reviewer can see the first menu is
    // tied to `branding.ts`'s `APP_NAME` rather than trusting it silently.
    return [
      { role: "appMenu", label: app.name },
      { role: "editMenu" },
      { role: "windowMenu" },
    ];
  }
  return [
    {
      label: shellText(locale, "menu.file"),
      submenu: [
        {
          label: shellText(locale, "menu.showWindow"),
          click: () => revealWindow(),
        },
        {
          label: shellText(locale, "menu.closeWindow"),
          click: () => closeWindow(),
        },
        { type: "separator" },
        {
          label: shellText(locale, "menu.quit"),
          // Deliberately WITHOUT Ctrl+Q. Quitting stops the Runtime, the Host
          // and every terminal the user has open, and Ctrl+Q sits next to the
          // chords a terminal uses constantly; the Rust shell left it off for
          // the same reason (`main.rs:137-141`). The window manager's own
          // close button and this item are the ways out.
          click: () => app.quit(),
        },
      ],
    },
    {
      label: shellText(locale, "menu.edit"),
      submenu: [
        { role: "undo", label: shellText(locale, "menu.undo") },
        { role: "redo", label: shellText(locale, "menu.redo") },
        { type: "separator" },
        { role: "cut", label: shellText(locale, "menu.cut") },
        { role: "copy", label: shellText(locale, "menu.copy") },
        { role: "paste", label: shellText(locale, "menu.paste") },
        { role: "selectAll", label: shellText(locale, "menu.selectAll") },
      ],
    },
    {
      label: shellText(locale, "menu.window"),
      submenu: [
        { role: "minimize", label: shellText(locale, "menu.minimize") },
        { role: "zoom", label: shellText(locale, "menu.zoom") },
      ],
    },
  ];
}

export function installApplicationMenu(): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(template(localeFromTag(app.getLocale()))),
  );
}
