import { describe, expect, it } from "vitest";

import { parseFlags } from "./control.js";
import type { Args } from "./control.js";
import { decodeText } from "./text-input.js";
import type { TextSources } from "./text-input.js";
import { MAX_PAYLOAD_BYTES } from "./usage.js";

/** Everything cmd.exe, bash and PowerShell each treat specially, and then some. */
const AWKWARD =
  'a & b | c "quoted" 100% ^caret %PATH% !x! $HOME `tick` 中文\n第二行';

function sources(
  files: Record<string, Buffer | string> = {},
  stdin?: Buffer | string,
): TextSources & { stdinReads: number } {
  const state = {
    stdinReads: 0,
    readFile(path: string): Buffer {
      const found = files[path];
      if (found === undefined)
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return Buffer.isBuffer(found) ? found : Buffer.from(found, "utf8");
    },
    readStdin(): Buffer {
      state.stdinReads += 1;
      if (stdin === undefined) throw new Error("no stdin in this test");
      return Buffer.isBuffer(stdin) ? stdin : Buffer.from(stdin, "utf8");
    },
    stdinIsTerminal: () => stdin === undefined,
  };
  return state;
}

function flags(args: string[], from: TextSources): Args {
  const parsed = parseFlags(args, from);
  if ("error" in parsed) throw new Error(parsed.error);
  return parsed.ok;
}

function failure(args: string[], from: TextSources): string {
  const parsed = parseFlags(args, from);
  if (!("error" in parsed)) throw new Error("expected a failure");
  return parsed.error;
}

describe("--flag - reads stdin", () => {
  it("takes the value from stdin, in both spellings", () => {
    expect(
      flags(["--to", "peer", "--body", "-"], sources({}, `${AWKWARD}\n`)),
    ).toEqual({ to: "peer", body: AWKWARD });
    expect(flags(["--body=-"], sources({}, AWKWARD))).toEqual({
      body: AWKWARD,
    });
  });

  it("works for any flag, and a later flag still parses", () => {
    expect(flags(["--text", "-", "--submit"], sources({}, "hello"))).toEqual({
      text: "hello",
      submit: true,
    });
  });

  it("reads stdin at most once", () => {
    const from = sources({}, "one");
    expect(failure(["--body", "-", "--task", "-"], from)).toMatch(
      /both want stdin/,
    );
    expect(from.stdinReads).toBe(1);
  });

  it("refuses when nothing is piped instead of waiting for a keyboard", () => {
    const from = sources();
    expect(failure(["--body", "-"], from)).toMatch(/nothing is piped/);
    expect(from.stdinReads).toBe(0);
  });

  it("keeps empty stdin empty rather than making it up", () => {
    expect(flags(["--body", "-"], sources({}, ""))).toEqual({ body: "" });
  });

  it("does not treat a dash inside a value as stdin", () => {
    const from = sources();
    expect(flags(["--title", "a-b", "--body=--"], from)).toEqual({
      title: "a-b",
      body: "--",
    });
    expect(from.stdinReads).toBe(0);
  });
});

describe("--flag-file PATH reads a file", () => {
  it("stores the contents under the flag without the suffix", () => {
    const from = sources({ "msg.txt": `${AWKWARD}\n` });
    expect(flags(["--to", "peer", "--body-file", "msg.txt"], from)).toEqual({
      to: "peer",
      body: AWKWARD,
    });
    expect(flags(["--body-file=msg.txt"], from)).toEqual({ body: AWKWARD });
  });

  it("appends a repeated file flag like the repeated flag it stands for", () => {
    const from = sources({ a: "claude|A|one", b: "codex|B|two" });
    expect(
      flags(
        ["--member", "x|X|zero", "--member-file", "a", "--member-file", "b"],
        from,
      ),
    ).toEqual({ member: ["x|X|zero", "claude|A|one", "codex|B|two"] });
  });

  it("names the file and the reason when it cannot be read", () => {
    expect(failure(["--body-file", "nope.txt"], sources())).toBe(
      "could not read --body-file nope.txt: ENOENT",
    );
  });

  it("needs a path", () => {
    expect(failure(["--body-file"], sources())).toBe(
      "--body-file needs a path",
    );
    expect(failure(["--body-file="], sources())).toBe(
      "--body-file needs a path",
    );
    expect(failure(["--body-file", "--to", "x"], sources())).toBe(
      "--body-file needs a path",
    );
  });

  it("leaves a flag literally named --file alone", () => {
    expect(flags(["--file", "x.txt"], sources())).toEqual({ file: "x.txt" });
  });

  it("combines with stdin in one invocation", () => {
    const from = sources({ task: "the task" }, "the body");
    expect(flags(["--body", "-", "--task-file", "task"], from)).toEqual({
      body: "the body",
      task: "the task",
    });
  });

  it("refuses a file over the payload limit", () => {
    const from = sources({ big: Buffer.alloc(MAX_PAYLOAD_BYTES + 1, 0x61) });
    expect(failure(["--body-file", "big"], from)).toMatch(/limit/);
  });
});

describe("decoding", () => {
  it("drops exactly one trailing line break", () => {
    expect(decodeText(Buffer.from("x\n\n"))).toBe("x\n");
    expect(decodeText(Buffer.from("x"))).toBe("x");
  });

  it("turns CRLF into LF", () => {
    expect(decodeText(Buffer.from("a\r\nb\r\n"))).toBe("a\nb");
  });

  it("strips a UTF-8 byte-order mark", () => {
    expect(
      decodeText(
        Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("中文")]),
      ),
    ).toBe("中文");
  });

  it("reads UTF-16 with a byte-order mark, as Windows PowerShell writes it", () => {
    const little = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from(`${AWKWARD}\r\n`, "utf16le"),
    ]);
    expect(decodeText(little)).toBe(AWKWARD);
    const big = Buffer.from(Buffer.from(AWKWARD, "utf16le")).swap16();
    expect(decodeText(Buffer.concat([Buffer.from([0xfe, 0xff]), big]))).toBe(
      AWKWARD,
    );
  });
});
