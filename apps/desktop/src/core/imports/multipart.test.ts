import { describe, expect, it } from "vitest";
import { DomainError } from "../workspaces/support";
import { boundaryOf, parseMultipart } from "./multipart";

/**
 * The parser's own tests. There is no Rust counterpart — `axum`'s `Multipart`
 * is a dependency there — so these cover the shapes the import routes depend
 * on: the manifest coming first, a filename that must not be believed, binary
 * bytes surviving intact, and a truncated body being a refusal rather than a
 * short read.
 */

const CRLF = "\r\n";

function body(
  boundary: string,
  parts: readonly { headers: string; bytes: Buffer }[],
  closed = true,
): Buffer {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    chunks.push(
      Buffer.from(`--${boundary}${CRLF}${part.headers}${CRLF}${CRLF}`, "utf8"),
    );
    chunks.push(part.bytes);
    chunks.push(Buffer.from(CRLF, "utf8"));
  }
  chunks.push(Buffer.from(closed ? `--${boundary}--${CRLF}` : "", "utf8"));
  return Buffer.concat(chunks);
}

describe("the multipart parser", () => {
  it("reads the boundary out of a content type", () => {
    expect(boundaryOf("multipart/form-data; boundary=abc")).toBe("abc");
    expect(boundaryOf('multipart/form-data; boundary="a b"')).toBe("a b");
    expect(boundaryOf("MULTIPART/FORM-DATA; BOUNDARY=abc")).toBe("abc");
    expect(boundaryOf("application/json")).toBeUndefined();
    expect(boundaryOf(undefined)).toBeUndefined();
    expect(boundaryOf("multipart/form-data")).toBeUndefined();
  });

  it("keeps the order and the bytes of every part", () => {
    const binary = Buffer.from([
      0x25, 0x50, 0x44, 0x46, 0x00, 0x0d, 0x0a, 0xff,
    ]);
    const fields = parseMultipart(
      body("test-boundary", [
        {
          headers: 'Content-Disposition: form-data; name="manifest"',
          bytes: Buffer.from('{"paths":["report.pdf"]}', "utf8"),
        },
        {
          headers:
            'Content-Disposition: form-data; name="0"; filename="ignored.pdf"' +
            `${CRLF}Content-Type: application/pdf`,
          bytes: binary,
        },
      ]),
      "multipart/form-data; boundary=test-boundary",
    );
    expect(fields.map((field) => field.name)).toEqual(["manifest", "0"]);
    expect(fields[0]?.bytes.toString("utf8")).toBe('{"paths":["report.pdf"]}');
    // A `\r\n` inside the payload is content, not a delimiter.
    expect(fields[1]?.bytes).toEqual(binary);
    // The filename is parsed so it can be shown, and is never a destination.
    expect(fields[1]?.filename).toBe("ignored.pdf");
  });

  it("refuses a body with no boundary and one that never closes", () => {
    const one = body("b", [
      {
        headers: 'Content-Disposition: form-data; name="manifest"',
        bytes: Buffer.from("{}", "utf8"),
      },
    ]);
    expect(() => parseMultipart(one, "application/json")).toThrow(DomainError);
    expect(() =>
      parseMultipart(
        Buffer.from("not multipart at all", "utf8"),
        "multipart/form-data; boundary=b",
      ),
    ).toThrow(DomainError);
    const truncated = body(
      "b",
      [
        {
          headers: 'Content-Disposition: form-data; name="manifest"',
          bytes: Buffer.from("{}", "utf8"),
        },
      ],
      false,
    );
    expect(() =>
      parseMultipart(truncated, "multipart/form-data; boundary=b"),
    ).toThrow(DomainError);
  });

  it("refuses a part with no name", () => {
    const anonymous = body("b", [
      { headers: "Content-Type: text/plain", bytes: Buffer.from("x", "utf8") },
    ]);
    expect(() =>
      parseMultipart(anonymous, "multipart/form-data; boundary=b"),
    ).toThrow(DomainError);
  });
});
