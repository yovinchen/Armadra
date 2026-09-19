/**
 * Password and passphrase prompts, routed to a person.
 *
 * Ported from `apps/runtime/src/terminal/ssh/prompts.rs`.
 *
 * `ssh` asks for a secret on a TTY. A Worker connection has no TTY, so before
 * this module the only options were `BatchMode=yes` — which fails outright on
 * any host needing a password — or letting the prompt swallow the frame
 * stream. Instead `SSH_ASKPASS` points at a helper, that helper asks the core
 * what to print, and the core asks the person.
 *
 * What the secret does **not** do is as important as what it does:
 *
 *  * It is never written to disk. The pending prompt holds it in memory for
 *    the seconds between the answer arriving and the helper reading it, and
 *    the entry is removed as it is read.
 *  * It is never logged. Prompt text is redacted before it is broadcast,
 *    because a server is free to put anything in a prompt.
 *  * It is never reused. One prompt, one answer, one read.
 *
 * A prompt nobody answers expires, so `ssh` fails cleanly instead of hanging
 * for as long as the connection timeout allows.
 *
 * Unlike the Rust module this is an instance rather than a process global. The
 * core is assembled from one context object and two of them can run in one
 * test file; a `static LazyLock` registry would make those two share prompts.
 */

import { randomUUID } from "node:crypto";
import { redactSecrets } from "./redact";

/**
 * How long a prompt waits for a person. The helper gives up at the same point
 * and exits non-zero, which makes `ssh` fail rather than hang.
 */
export const PROMPT_TIMEOUT_MS = 120_000;

/**
 * What kind of secret is being asked for. Derived from the prompt text, so the
 * dialog can say "passphrase for your key" rather than quoting a server.
 */
export type PromptKind = "password" | "passphrase";

/**
 * What the client is told about a prompt. No answer field: this travels
 * outward only.
 */
export interface SshPrompt {
  readonly promptId: string;
  readonly hostId: string;
  readonly kind: PromptKind;
  /**
   * Redacted before it leaves the core: the text is the server's, and a server
   * can put a secret in it.
   */
  readonly prompt: string;
}

interface Pending {
  readonly hostId: string;
  readonly kind: PromptKind;
  readonly prompt: string;
  answer: string | undefined;
  readonly opened: number;
  /** Resolved when an answer arrives, so the helper's wait is not a poll. */
  readonly answered: Promise<void>;
  wake(): void;
}

/**
 * A server's prompt string decides which of the two this is. `ssh` phrases a
 * key passphrase and a login password differently, and the dialog should not
 * have to guess.
 */
export function classify(prompt: string): PromptKind {
  return prompt.toLowerCase().includes("passphrase")
    ? "passphrase"
    : "password";
}

/** Raised for every refusal, carrying the status the API face owes it. */
export class PromptError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PromptError";
  }
}

export class PromptRegistry {
  private readonly prompts = new Map<string, Pending>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Open a prompt and return what the client should be shown. */
  open(hostId: string, prompt: string): SshPrompt {
    this.expire();
    const promptId = randomUUID().replace(/-/gu, "");
    const kind = classify(prompt);
    const redacted = redactSecrets(prompt);
    let wake = (): void => {};
    const answered = new Promise<void>((resolve) => {
      wake = resolve;
    });
    this.prompts.set(promptId, {
      hostId,
      kind,
      prompt: redacted,
      answer: undefined,
      opened: this.now(),
      answered,
      wake,
    });
    return { promptId, hostId, kind, prompt: redacted };
  }

  /**
   * Record a person's answer. Answering twice is refused rather than silently
   * replacing the first: one prompt is one secret.
   */
  answer(promptId: string, hostId: string, answer: string): void {
    const pending = this.prompts.get(promptId);
    if (pending === undefined || pending.hostId !== hostId) {
      throw new PromptError(
        404,
        "not_found",
        "That prompt is no longer waiting",
      );
    }
    if (pending.answer !== undefined) {
      throw new PromptError(409, "conflict", "That prompt is already answered");
    }
    pending.answer = answer;
    pending.wake();
  }

  /**
   * Take the answer, removing the prompt. Returns `undefined` while it is
   * still waiting; the caller decides how long to keep asking.
   */
  take(promptId: string): string | undefined {
    const pending = this.prompts.get(promptId);
    if (pending === undefined) {
      throw new PromptError(
        404,
        "not_found",
        "That prompt is no longer waiting",
      );
    }
    if (pending.answer === undefined) return undefined;
    // Removed as it is read: the secret exists in one place and then in none.
    this.prompts.delete(promptId);
    return pending.answer;
  }

  /**
   * Wait until the prompt is answered, then take it. `undefined` means it
   * expired, was cancelled, or the deadline passed — all of which the helper
   * turns into a non-zero exit, which makes `ssh` fail rather than hang.
   */
  async await(
    promptId: string,
    deadlineMs: number,
  ): Promise<string | undefined> {
    const pending = this.prompts.get(promptId);
    if (pending === undefined) return undefined;
    if (pending.answer === undefined) {
      let timer: NodeJS.Timeout | undefined;
      const expired = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, deadlineMs);
        timer.unref?.();
      });
      await Promise.race([pending.answered, expired]);
      if (timer !== undefined) clearTimeout(timer);
    }
    try {
      return this.take(promptId);
    } catch {
      return undefined;
    }
  }

  /** Give up on a prompt — the connection died, or the person cancelled. */
  close(promptId: string): void {
    const pending = this.prompts.get(promptId);
    this.prompts.delete(promptId);
    // Releases anybody waiting on it, so a cancelled prompt fails `ssh` now
    // rather than at the two-minute deadline.
    pending?.wake();
  }

  /** What is still waiting, for a client that reconnected mid-prompt. */
  waiting(): SshPrompt[] {
    const listed: SshPrompt[] = [];
    for (const [promptId, pending] of this.prompts) {
      if (pending.answer !== undefined) continue;
      listed.push({
        promptId,
        hostId: pending.hostId,
        kind: pending.kind,
        prompt: pending.prompt,
      });
    }
    return listed;
  }

  private expire(): void {
    const now = this.now();
    for (const [promptId, pending] of [...this.prompts]) {
      if (now - pending.opened >= PROMPT_TIMEOUT_MS) {
        this.prompts.delete(promptId);
        pending.wake();
      }
    }
  }
}
