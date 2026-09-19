import {
  Menu,
  app,
  type BrowserWindow,
  type MenuItemConstructorOptions,
} from "electron";
import { IPC } from "../shared/ipc";
import { keydownIntercept } from "../shell-core/keydown-intercept";
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
    // The page is told what was asked for even though the shell performs the
    // window half itself — the canvas may want to close a node first, and only
    // the page knows whether there is one.
    sendToWindow(IPC.windowKeyIntent.channel, intent);
    if (intent === "close-window") closeWindow();
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
    return [{ role: "appMenu" }, { role: "editMenu" }, { role: "windowMenu" }];
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
