/**
 * What the browser domain drives, whichever shell assembled it.
 *
 * There are two implementations and they are not variants of one another:
 *
 *   * {@link DriveClient} — the desktop shell's `browser:drive` loopback
 *     WebSocket. The page is a `<webview>` guest in somebody's window; this
 *     process holds nothing but the right to drive it.
 *   * `headless/HeadlessBackend` — a server shell has no window, so the core
 *     starts a headless Chromium itself, drives it over CDP, and streams the
 *     page to whoever is looking.
 *
 * The seam is here rather than inside the verb surface on purpose: everything
 * that decides WHETHER something may happen — the three authorization rules,
 * the lease, the URL policy, the verb names — is written once in
 * `core/browser` and asks a backend only for the page.
 */

/** An event a backend pushes: a page navigated, a person touched it, a guest
 * went away. Consumed by `onShellEvent`. */
export type EventSink = (event: Record<string, unknown>) => void;

/** What a backend says about itself. Read by diagnostics and by the empty
 * state a browser node draws when there is no browser at all. */
export interface BackendStatus {
  readonly kind: "shell" | "headless";
  /** Whether a verb sent right now could reach a page. */
  readonly available: boolean;
  /** Why not, when it could not. A stable code, never prose. */
  readonly reason?: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}

export interface DriveBackend {
  readonly kind: "shell" | "headless";
  /** Starts whatever this backend needs, and subscribes to its events. */
  connect(events: EventSink): void;
  isConnected(): boolean;
  /** Sends one already-authorized verb and waits for its answer. */
  drive(nodeId: string, verb: string, args: unknown): Promise<unknown>;
  /** Tells the backend something without waiting: a lease ended, and every
   * attachment to that node must go. */
  notify(nodeId: string, event: string, detail: unknown): void;
  status(): BackendStatus;
  close(): void;
}
