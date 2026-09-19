import { describe, expect, it } from "vitest";
import {
  PASTE_END,
  SESSION_PREFIX,
  Utf8Decoder,
  nameComponent,
  parseBackendKind,
  persistent,
  sanitizePaste,
  sessionKey,
  sessionName,
  stripEscapes,
  tailComponent,
  tailLines,
  trimCaptured,
} from "./backend";

describe("session names", () => {
  it("sanitises and bounds every component", () => {
    const name = sessionName(
      "0199f3ab-cdef-7000-8000-000000000000",
      sessionKey("0199f3ff.weird:key/with$junk"),
      3,
    );
    expect(name).toBe("armadra-0199f3ab-withjunk-3");
    expect(name.startsWith(SESSION_PREFIX)).toBe(true);
    expect(/^[A-Za-z0-9-]+$/.test(name)).toBe(true);
    // Empty or fully-illegal components still produce a usable name.
    expect(sessionName("...", sessionKey(""), 1)).toBe("armadra-xx-xx-1");
  });

  /**
   * UUIDv7 keys minted in the same ~65 second window share their leading eight
   * hex digits, so the name must not be built from the head of the key. The
   * assertion on the heads is what makes the second one worth anything.
   */
  it("gives two nodes created in the same moment different names", () => {
    const workspace = "0199f3ab-cdef-7000-8000-000000000000";
    const first = sessionKey("0199f3ff-0001-7000-8000-aaaaaaaaaaaa");
    const second = sessionKey("0199f3ff-0002-7000-8000-bbbbbbbbbbbb");
    expect(nameComponent(first, 8)).toBe(nameComponent(second, 8));
    expect(sessionName(workspace, first, 1)).not.toBe(
      sessionName(workspace, second, 1),
    );
    // A recycle is a different session again.
    expect(sessionName(workspace, first, 1)).not.toBe(
      sessionName(workspace, first, 2),
    );
  });

  it("takes the tail, not the head", () => {
    // `-` is a legal tmux name character and is kept, exactly as the Rust
    // filter keeps it; only `.` `:` `/` and the rest are dropped.
    expect(tailComponent("0199f3ff-aaaa-bbbb", 8)).toBe("aaa-bbbb");
    expect(tailComponent("0199f3ff.weird:key/with$junk", 8)).toBe("withjunk");
    expect(tailComponent("", 8)).toBe("xx");
  });
});

describe("backend kinds", () => {
  it("refuses to guess at an unknown backend", () => {
    expect(parseBackendKind("tmux")).toBe("tmux");
    expect(parseBackendKind("direct")).toBe("direct");
    expect(parseBackendKind("sessionHost")).toBe("sessionHost");
    // Parsing this as `direct` would claim an unreachable session is reachable.
    expect(parseBackendKind("wayland")).toBeUndefined();
    expect(parseBackendKind("")).toBeUndefined();
  });

  it("knows which sessions outlive the process", () => {
    expect(persistent("tmux")).toBe(true);
    expect(persistent("sessionHost")).toBe(true);
    expect(persistent("direct")).toBe(false);
  });
});

describe("paste sanitising", () => {
  it("does not let pasted text close its own bracket", () => {
    const sanitized = sanitizePaste(`ok${PASTE_END}evil\nnext`);
    expect(sanitized).not.toContain("\u001b");
    expect(sanitized).toContain("\n");
    expect(sanitized).toBe("ok[201~evil\nnext");
  });

  it("keeps the three whitespace controls a prompt needs", () => {
    expect(sanitizePaste("a\tb\r\nc")).toBe("a\tb\r\nc");
    expect(sanitizePaste("a\u0000b\u0007c")).toBe("abc");
  });
});

describe("captured text", () => {
  it("strips escapes for an agent-readable capture", () => {
    const raw = "\u001b[1;32mhi\u001b[0m there\u001b]0;title\u0007!";
    expect(stripEscapes(raw)).toBe("hi there!");
  });

  it("drops the empty rows below the prompt", () => {
    expect(trimCaptured("a\nb\n\n   \n\n")).toBe("a\nb");
    expect(tailLines("a\nb\nc\nd", 2)).toBe("c\nd");
    expect(tailLines("a\nb", 0)).toBe("a\nb");
  });
});

describe("the chunked decoder", () => {
  /**
   * The failure this prevents is permanent rather than transient: a chunk that
   * ends mid-character, decoded alone, becomes U+FFFD on the screen and stays
   * there.
   */
  it("carries a split multi-byte character across chunks", () => {
    const bytes = Buffer.from("终端", "utf8");
    const decoder = new Utf8Decoder("utf8");
    const first = decoder.write(bytes.subarray(0, 4));
    const second = decoder.write(bytes.subarray(4));
    expect(first + second).toBe("终端");
    expect(first + second).not.toContain("�");
  });
});
