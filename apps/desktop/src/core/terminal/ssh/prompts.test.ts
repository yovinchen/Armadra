/**
 * The Rust `prompts.rs` test module, case for case, plus the redaction cases
 * that live in `security.rs` on that side.
 */

import { describe, expect, it } from "vitest";
import { PROMPT_TIMEOUT_MS, PromptError, PromptRegistry, classify } from "./prompts";
import { redactSecrets, tail } from "./redact";

describe("classifying a prompt", () => {
  it("tells a passphrase prompt from a password one", () => {
    expect(classify("Enter passphrase for key '/home/ada/.ssh/id_ed25519': ")).toBe(
      "passphrase",
    );
    expect(classify("ada@example.com's password: ")).toBe("password");
  });
});

describe("the prompt registry", () => {
  /**
   * A prompt is one secret. Answering it twice would mean a second value
   * nobody asked for could replace the first before the helper reads it.
   */
  it("accepts exactly one answer and is gone once read", () => {
    const prompts = new PromptRegistry();
    const prompt = prompts.open("box", "password: ");
    expect(prompts.take(prompt.promptId)).toBeUndefined();
    prompts.answer(prompt.promptId, "box", "hunter2");
    expect(() => prompts.answer(prompt.promptId, "box", "again")).toThrow(
      PromptError,
    );
    expect(prompts.take(prompt.promptId)).toBe("hunter2");
    // Read once and then gone, so nothing can pick it up a second time.
    expect(() => prompts.take(prompt.promptId)).toThrow(PromptError);
  });

  /**
   * The prompt text belongs to the server. Anything that looks like a secret
   * in it must not reach a log or a client.
   */
  it("redacts the prompt text before it leaves the core", () => {
    const prompts = new PromptRegistry();
    const prompt = prompts.open("box", "password=hunter2 enter password: ");
    expect(prompt.prompt).not.toContain("hunter2");
    expect(prompt.prompt).toContain("[REDACTED]");
  });

  /**
   * A prompt belongs to the host it was opened for; answering somebody else's
   * is not found rather than accepted.
   */
  it("refuses an answer for a different host", () => {
    const prompts = new PromptRegistry();
    const prompt = prompts.open("box", "password: ");
    expect(() => prompts.answer(prompt.promptId, "other", "x")).toThrow(
      PromptError,
    );
  });

  it("lists only unanswered prompts for a reconnecting client", () => {
    const prompts = new PromptRegistry();
    const prompt = prompts.open("listing-host", "password: ");
    expect(
      prompts.waiting().some((entry) => entry.promptId === prompt.promptId),
    ).toBe(true);
    prompts.answer(prompt.promptId, "listing-host", "x");
    expect(
      prompts.waiting().some((entry) => entry.promptId === prompt.promptId),
    ).toBe(false);
  });

  /**
   * A prompt nobody answers expires, so `ssh` fails cleanly instead of hanging
   * for as long as the connection timeout allows.
   */
  it("expires a prompt nobody answered", () => {
    let now = 1_000;
    const prompts = new PromptRegistry(() => now);
    const stale = prompts.open("box", "password: ");
    now += PROMPT_TIMEOUT_MS;
    // The sweep runs when the next prompt is opened, the way the Rust
    // `expire()` is called from `open`.
    prompts.open("box", "password: ");
    expect(
      prompts.waiting().some((entry) => entry.promptId === stale.promptId),
    ).toBe(false);
  });

  /** Waiting resolves as soon as somebody answers, without a poll interval. */
  it("wakes a waiter the moment the answer arrives", async () => {
    const prompts = new PromptRegistry();
    const prompt = prompts.open("box", "password: ");
    const waited = prompts.await(prompt.promptId, 5_000);
    prompts.answer(prompt.promptId, "box", "hunter2");
    expect(await waited).toBe("hunter2");
  });

  /** A cancelled prompt releases its waiter now rather than at the deadline. */
  it("gives a waiter nothing when the prompt is cancelled", async () => {
    const prompts = new PromptRegistry();
    const prompt = prompts.open("box", "password: ");
    const waited = prompts.await(prompt.promptId, 5_000);
    prompts.close(prompt.promptId);
    expect(await waited).toBeUndefined();
  });

  /** Two prompts are two secrets; neither may be read as the other. */
  it("keeps two open prompts apart", () => {
    const prompts = new PromptRegistry();
    const one = prompts.open("box", "password: ");
    const other = prompts.open("other", "password: ");
    prompts.answer(other.promptId, "other", "second");
    expect(prompts.take(one.promptId)).toBeUndefined();
    expect(prompts.take(other.promptId)).toBe("second");
  });
});

describe("redaction", () => {
  it("replaces the value of every name that is always a secret", () => {
    expect(redactSecrets("token: abc123")).toBe("token=[REDACTED]");
    expect(redactSecrets("ANTHROPIC_API_KEY=sk-1")).toBe(
      "ANTHROPIC_API_KEY=[REDACTED]",
    );
    expect(redactSecrets("Authorization: Bearer abc.def")).toBe(
      "Authorization: Bearer [REDACTED]",
    );
    expect(redactSecrets("nothing to see")).toBe("nothing to see");
  });

  /** The reported output is a redacted tail, never a full transcript. */
  it("keeps the last six non-empty lines and redacts them", () => {
    const text = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join(
      "\n",
    );
    const trimmed = tail(`${text}\npassword=hunter2`);
    expect(trimmed.startsWith("line 16")).toBe(true);
    expect(trimmed).toContain("[REDACTED]");
    expect(trimmed).not.toContain("hunter2");
  });

  /** The ceiling is counted in code points, so a wide script is not cut mid-character. */
  it("caps the tail at six hundred characters", () => {
    expect(tail("汉".repeat(1_000))).toHaveLength(600);
  });
});
