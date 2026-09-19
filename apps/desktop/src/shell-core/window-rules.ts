/**
 * What the window does when it is closed, and where its content comes from.
 * Pure, so both rules can be asserted for every platform without a display.
 */

export type CloseAction = "default" | "hide" | "leave-fullscreen-then-hide";

/**
 * macOS convention: closing the window hides it — the app, its Runtime, its
 * Host and its tmux sessions keep running; a real close only happens on quit.
 * Other platforms quit on window close, so the handler never intercepts there.
 */
export function shouldHideOnClose(
  platform: string,
  quitting: boolean,
): boolean {
  return platform === "darwin" && !quitting;
}

/**
 * Hiding a FULLSCREEN window without leaving fullscreen first strands its
 * empty Space as a black screen the user can still swipe to — the known
 * Electron behaviour, electron/electron#20263. Fullscreen must therefore be
 * exited, the async `leave-full-screen` transition awaited, and only THEN the
 * window hidden. The quit path is unaffected: there the window really closes
 * and its Space goes away with it.
 */
export function closeAction(
  platform: string,
  quitting: boolean,
  isFullScreen: boolean,
): CloseAction {
  if (!shouldHideOnClose(platform, quitting)) return "default";
  return isFullScreen ? "leave-fullscreen-then-hide" : "hide";
}

/**
 * apps/web's own dev server. `apps/web/vite.config.ts` pins this address with
 * `strictPort`, so its Runtime proxy stays predictable; the shell defaults to
 * it when electron-vite did not start the renderer itself.
 */
export const DEFAULT_DEV_RENDERER_URL = "http://127.0.0.1:1420";

export type RendererTarget =
  | { readonly kind: "url"; readonly url: string }
  | { readonly kind: "file"; readonly path: string };

/**
 * Where the renderer comes from: apps/web's dev server while developing, and
 * apps/web's build output once packaged. The shell never builds the front end
 * a second way.
 */
export function rendererTarget(
  devServerUrl: string | undefined,
  packaged: boolean,
  packagedIndex: string,
): RendererTarget {
  if (!packaged)
    return { kind: "url", url: devServerUrl || DEFAULT_DEV_RENDERER_URL };
  return { kind: "file", path: packagedIndex };
}
