/**
 * The three-phase quit state of `src-tauri/src/lifecycle.rs:17-66`, as pure
 * logic so the ordering rules can be tested without an `app` object.
 *
 * Closing the foreground is not quitting: it keeps the document, the terminals
 * and the background services alive and only hides the window. Quit is
 * single-flight, and only a quit that *completed* permits the process to exit —
 * a shutdown that failed must never read as success on a second attempt.
 */
export type Phase = "running" | "stopping" | "stopped";

export class LifecycleState {
  private phase: Phase = "running";
  private hidden = false;

  /** The foreground was closed. Services keep running. */
  hide(): void {
    this.hidden = true;
  }

  /**
   * Bring the window back — unless a quit is in progress, in which case
   * nothing may resurrect a window whose services are already stopping. Every
   * entry point (tray click, dock reopen, global hotkey, menu item) goes
   * through here so they cannot disagree about that.
   */
  reveal(): boolean {
    if (this.isQuitting()) return false;
    this.hidden = false;
    return true;
  }

  shouldShow(): boolean {
    return !this.hidden && !this.isQuitting();
  }

  isQuitting(): boolean {
    return this.phase !== "running";
  }

  /** `true` for the caller that owns this quit; `false` for every other. */
  beginQuit(): boolean {
    if (this.phase !== "running") return false;
    this.phase = "stopping";
    return true;
  }

  /** Services did not all stop. Back to running: the app stays open. */
  quitFailed(): void {
    this.phase = "running";
  }

  quitCompleted(): void {
    this.phase = "stopped";
  }

  canExit(): boolean {
    return this.phase === "stopped";
  }

  current(): Phase {
    return this.phase;
  }
}
