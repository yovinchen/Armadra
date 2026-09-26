/**
 * Flag values that come from stdin or a file instead of the command line.
 *
 * `canvas send --body`, `post --body`, `open-agent --task`, `team --member`,
 * `browser type --text`, `fill --field` … carry arbitrary text, and a command
 * line is a poor carrier for it: every shell has its own quoting, and on
 * Windows a `.cmd` in the chain re-reads the line through `cmd.exe`. So any
 * `--flag` can take its value from elsewhere:
 *
 *   * `--body -` (or `--body=-`) reads stdin — once per invocation, since
 *     stdin can only be read once;
 *   * `--body-file <path>` reads that file; `--text-file`, `--task-file`,
 *     `--member-file` … the same, for any flag name. A repeated `--member-file`
 *     appends like a repeated `--member`.
 *
 * Both are read as UTF-8 unless a byte-order mark says UTF-16 (what Windows
 * PowerShell 5.1's `>` writes); CRLF becomes LF (a Windows editor's line
 * ending would otherwise type an extra Enter into a terminal) and one trailing
 * line break is dropped (the one every editor and heredoc adds). Everything
 * else arrives byte for byte.
 */

import * as fs from "node:fs";
import * as tty from "node:tty";

import { MAX_PAYLOAD_BYTES } from "./usage.js";

/** The suffix that turns `--name-file PATH` into `--name <contents>`. */
export const FILE_SUFFIX = "-file";

/** The value that means "read stdin". */
export const STDIN_VALUE = "-";

/** Where file and stdin text come from; injectable for tests. */
export interface TextSources {
  readFile(path: string): Buffer;
  readStdin(): Buffer;
  /** True when stdin is an interactive terminal, i.e. nothing was piped. */
  stdinIsTerminal(): boolean;
}

export const processSources: TextSources = {
  readFile: (path) => fs.readFileSync(path),
  readStdin: () => {
    try {
      return fs.readFileSync(0);
    } catch (error) {
      // A Windows pipe whose writer already closed reports EOF instead of
      // returning nothing.
      if ((error as NodeJS.ErrnoException).code === "EOF")
        return Buffer.alloc(0);
      throw error;
    }
  },
  stdinIsTerminal: () => tty.isatty(0),
};

/** Decodes file or stdin bytes into the text a flag carries. */
export function decodeText(bytes: Buffer): string {
  let text: string;
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    text = bytes.subarray(2).toString("utf16le");
  } else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const swapped = Buffer.from(bytes.subarray(2));
    swapped.swap16();
    text = swapped.toString("utf16le");
  } else if (
    bytes.length >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf
  ) {
    text = bytes.subarray(3).toString("utf8");
  } else {
    text = bytes.toString("utf8");
  }
  text = text.replace(/\r\n/g, "\n");
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}

/** Resolves flag values from stdin and files, remembering that stdin is spent. */
export class TextReader {
  private stdinUsedBy: string | undefined;

  constructor(private readonly sources: TextSources = processSources) {}

  /** `--name -`: the whole of stdin. */
  stdin(flag: string): { ok: string } | { error: string } {
    if (this.stdinUsedBy !== undefined) {
      return {
        error: `--${flag} - and --${this.stdinUsedBy} - both want stdin; pass one of them with --<flag>${FILE_SUFFIX}`,
      };
    }
    this.stdinUsedBy = flag;
    if (this.sources.stdinIsTerminal()) {
      return {
        error: `--${flag} - reads stdin, but nothing is piped in; pipe the text or use --${flag}${FILE_SUFFIX} <path>`,
      };
    }
    let bytes: Buffer;
    try {
      bytes = this.sources.readStdin();
    } catch (error) {
      return { error: `could not read stdin for --${flag}: ${reason(error)}` };
    }
    return this.checked(`--${flag} -`, bytes);
  }

  /** `--name-file PATH`: that file. */
  file(flag: string, path: string): { ok: string } | { error: string } {
    let bytes: Buffer;
    try {
      bytes = this.sources.readFile(path);
    } catch (error) {
      return {
        error: `could not read --${flag}${FILE_SUFFIX} ${path}: ${reason(error)}`,
      };
    }
    return this.checked(`--${flag}${FILE_SUFFIX} ${path}`, bytes);
  }

  private checked(
    source: string,
    bytes: Buffer,
  ): { ok: string } | { error: string } {
    if (bytes.length > MAX_PAYLOAD_BYTES) {
      return {
        error: `${source} is ${bytes.length} bytes; the limit is ${MAX_PAYLOAD_BYTES}`,
      };
    }
    return { ok: decodeText(bytes) };
  }
}

function reason(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code !== undefined) return code;
  return error instanceof Error ? error.message : String(error);
}
