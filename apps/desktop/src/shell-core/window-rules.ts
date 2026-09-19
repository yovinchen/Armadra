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

export type PageSourceTarget =
  /** Somebody else is serving apps/web; its origin is theirs. */
  | { readonly kind: "devServer"; readonly url: string }
  /** This shell serves apps/web's build output over loopback HTTP itself. */
  | { readonly kind: "static"; readonly root: string };

/**
 * Where the page comes from, and therefore what its ORIGIN is.
 *
 * Never `file:`. A `file:` page is an opaque origin: `fetch` to the Runtime is
 * cross-origin with no origin to allow, and the Host's native session is
 * granted to a named origin it could never present (§2.1). The packaged shell
 * therefore serves apps/web's build output over its own loopback HTTP server,
 * on a kernel-assigned port, and that URL is what the window loads.
 *
 * Development is unchanged: apps/web's dev server already is a loopback HTTP
 * origin, so it needs no second server — which is the point of returning one
 * shape for both modes. Whoever serves the page, the origin is one value.
 */
export function pageSourceTarget(
  devServerUrl: string | undefined,
  packaged: boolean,
  staticRoot: string,
  externalRenderer = false,
): PageSourceTarget {
  if (packaged) return { kind: "static", root: staticRoot };
  // electron-vite started apps/web itself and told us where.
  if (devServerUrl) return { kind: "devServer", url: devServerUrl };
  // `ARMADRA_DESKTOP_EXTERNAL_RENDERER=1`: somebody is already running
  // `pnpm --filter @armadra/web dev` on apps/web's own pinned port.
  if (externalRenderer)
    return { kind: "devServer", url: DEFAULT_DEV_RENDERER_URL };
  // Neither: an unpackaged run over a build output — `electron-vite preview`.
  // Serving it is the same path the packaged shell takes, which is the point
  // of exercising it without a bundle.
  return { kind: "static", root: staticRoot };
}
