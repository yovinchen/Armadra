import { beforeEach, describe, expect, it } from "vitest";
import {
  MAX_RETAINED,
  clearRetained,
  retainUntilDismissed,
  retainedCount,
  type NotificationLike,
} from "./notification-retain";

/** A `Notification` stand-in that remembers its listeners so a test can fire
 * the event the OS would. */
function fake(): NotificationLike & { fire(event: string): void } {
  const listeners = new Map<string, () => void>();
  return {
    on: (event, listener) => listeners.set(event, listener),
    fire: (event) => listeners.get(event)?.(),
  };
}

describe("notification retention", () => {
  beforeEach(clearRetained);

  it("holds a notification so its click handler survives GC", () => {
    retainUntilDismissed(fake());
    expect(retainedCount()).toBe(1);
  });

  it("releases on every way the OS reports it gone", () => {
    for (const event of ["click", "close", "failed"]) {
      clearRetained();
      const notification = fake();
      retainUntilDismissed(notification);
      notification.fire(event);
      expect(retainedCount(), event).toBe(0);
    }
  });

  it("caps the set, dropping the oldest first", () => {
    const first = fake();
    retainUntilDismissed(first);
    for (let index = 0; index < MAX_RETAINED; index += 1)
      retainUntilDismissed(fake());
    // The cap holds, and it is the OLDEST that was let go — the recent ones a
    // user is plausibly about to click keep their handlers.
    expect(retainedCount()).toBe(MAX_RETAINED);
    first.fire("close");
    expect(retainedCount()).toBe(MAX_RETAINED);
  });
});
