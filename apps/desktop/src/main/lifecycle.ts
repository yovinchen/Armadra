import type { HostStatus } from "@armadra/protocol";
import { LifecycleState } from "../shell-core/lifecycle-state";
import { type HostLaunchConfig, ensureHost, stopHost } from "./host";
import type { RuntimeProcess } from "./runtime-process";

/**
 * Closing the foreground keeps its document and services alive. Explicit quit
 * serializes with Host startup, stops the configured Host, then our Runtime.
 *
 * Ported from `src-tauri/src/lifecycle.rs` plus the quit orchestration in
 * `src-tauri/src/main.rs:89-120`. The three-phase state itself is pure and
 * lives in `shell-core/lifecycle-state.ts`.
 */

/** A promise chain that serializes Host startup, shutdown and quit. */
class Serial {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.then(work, work);
    // A rejection must not poison the chain for the next caller, but it still
    // has to reach the one who asked.
    this.tail = next.catch(() => undefined);
    return next;
  }
}

export class DesktopLifecycle {
  readonly state = new LifecycleState();
  private hostConfig: HostLaunchConfig | null = null;
  /**
   * What the last successful startup observed. Kept rather than re-read so a
   * later caller talks about exactly the Host instance this shell verified.
   */
  private hostStatus: HostStatus | null = null;
  private readonly hostOperation = new Serial();

  configureHost(config: HostLaunchConfig): void {
    this.hostConfig = config;
  }

  hostLaunchConfig(): HostLaunchConfig | null {
    return this.hostConfig;
  }

  observedHost(): HostStatus | null {
    return this.hostStatus;
  }

  async startHost(): Promise<void> {
    await this.hostOperation.run(async () => {
      // Quit may have won before this startup task was first scheduled.
      if (this.state.isQuitting()) return;
      const config = this.hostConfig;
      if (config === null) return;
      this.hostStatus = await ensureHost(config);
    });
  }

  async stopConfiguredHost(): Promise<void> {
    await this.hostOperation.run(async () => {
      this.hostStatus = null;
      const config = this.hostConfig;
      if (config === null) return;
      await stopHost(config);
    });
  }
}

export interface QuitOutcome {
  readonly ok: boolean;
  /** Present only when `ok` is false; already safe to show to the user. */
  readonly message?: string;
}

/**
 * The quit sequence: Host first, then the Runtime, and the application exits
 * only if BOTH confirmed.
 *
 * The order is not cosmetic. The Host holds the ownership record and drains
 * its own clients; the Runtime is what detaches tmux sessions instead of
 * ending them. Stopping the Runtime first would leave the Host talking to a
 * service that is gone.
 *
 * A failure does NOT exit. The window comes back and the user is told, because
 * the alternative — quitting anyway — silently leaves background services and
 * the user's sessions in a state nobody inspected.
 */
export async function runQuitSequence(
  lifecycle: DesktopLifecycle,
  runtime: RuntimeProcess,
): Promise<QuitOutcome> {
  const failures: string[] = [];
  try {
    await lifecycle.stopConfiguredHost();
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }
  try {
    // The Runtime is stopped even when the Host failed: leaving it running
    // would be a second orphan on top of the one the user already has to
    // deal with, and its own stop path is what detaches tmux cleanly.
    await runtime.stop();
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }
  if (failures.length > 0) {
    lifecycle.state.quitFailed();
    return { ok: false, message: failures.join("\n") };
  }
  lifecycle.state.quitCompleted();
  return { ok: true };
}

/** The dialog text for a quit that could not finish. */
export function quitFailureDialog(message: string): {
  title: string;
  body: string;
} {
  return {
    title: "Armadra 退出未完成",
    body: `后台未能全部停止，应用尚未退出。请检查后台状态。\n${message}`,
  };
}
