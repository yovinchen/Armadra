import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  create,
  fromBinary,
  toBinary,
  type DescMessage,
  type MessageInitShape,
} from "@bufbuild/protobuf";
import {
  BrowserActionSchema,
  BrowserDownloadSchema,
  BrowserDownloadState,
  BrowserFrameSchema,
  BrowserInputKind,
  BrowserInputRequestSchema,
  BrowserReadResponseSchema,
  BrowserSessionSchema,
  BrowserSessionState,
} from "../src/index.js";

function fixture(name: string): Uint8Array {
  const hex = readFileSync(
    new URL(`../../../proto/fixtures/${name}.hex`, import.meta.url),
    "utf8",
  ).trim();
  return new Uint8Array(Buffer.from(hex, "hex"));
}

function check<T extends DescMessage>(
  name: string,
  schema: T,
  init: MessageInitShape<T>,
) {
  const expected = create(schema, init);
  const wire = fixture(name);
  expect(fromBinary(schema, wire)).toEqual(expected);
  expect(toBinary(schema, expected)).toEqual(wire);
}

const maxUint64 = 18_446_744_073_709_551_615n;

describe("controlled browser sessions", () => {
  it("keeps the controlled browser surface byte-identical across runtimes", () => {
    check("browser_session", BrowserSessionSchema, {
      sessionId: "browser-1",
      generation: maxUint64,
      workspaceId: "workspace-1",
      nodeId: "node-1",
      url: "http://127.0.0.1:8080/表单",
      title: "受控浏览器 😀",
      viewport: { width: 1000, height: 700, deviceScaleFactor: 2 },
      state: BrowserSessionState.READY,
      navigationEpoch: 9007199254740993n,
      headful: false,
      keepAlive: true,
      createdAtUnixMs: 1788557000000n,
      updatedAtUnixMs: 1788557900000n,
    });
    check("browser_frame", BrowserFrameSchema, {
      sessionId: "browser-1",
      generation: 2n,
      frameSeq: 9007199254740993n,
      navigationEpoch: maxUint64,
      viewportWidth: 1000,
      viewportHeight: 700,
      deviceScaleFactor: 1.5,
      encoding: "jpeg",
      data: new Uint8Array([0, 255, 0xd8, 0xff]),
      capturedAtUnixMs: 1788557900000n,
    });
    check("browser_input", BrowserInputRequestSchema, {
      sessionId: "browser-1",
      navigationEpoch: maxUint64,
      frameSeq: 7n,
      events: [
        {
          kind: BrowserInputKind.MOUSE_PRESSED,
          x: 12.5,
          y: 40,
          button: "left",
          clickCount: 1,
          modifiers: 15,
        },
        { kind: BrowserInputKind.WHEEL, x: 500, y: 550, deltaY: 400 },
        { kind: BrowserInputKind.TEXT, text: "Hello 中文 😀" },
      ],
    });
    check("browser_read", BrowserReadResponseSchema, {
      sessionId: "browser-1",
      navigationEpoch: 3n,
      url: "http://127.0.0.1:8080/",
      title: "Armadra 受控浏览器",
      text: "正文 😀",
      elements: [
        {
          elementRef: "e1",
          role: "button",
          name: "提交",
          selector: "#submit",
          visible: true,
          x: 10,
          y: 20,
          width: 80,
          height: 32,
        },
      ],
      console: [
        {
          atUnixMs: 1788557900000n,
          level: "error",
          text: "boom",
          url: "http://127.0.0.1:8080/",
          line: 12,
        },
      ],
      network: [
        {
          atUnixMs: 1788557900000n,
          method: "GET",
          url: "http://127.0.0.1:8080/a",
          status: 404,
          mimeType: "text/html",
          encodedBytes: 9007199254740993n,
          fromCache: true,
        },
      ],
      truncated: true,
    });
    check("browser_action_capture", BrowserActionSchema, {
      action: {
        case: "capture",
        value: {
          meta: { requestId: "请求-1" },
          sessionId: "browser-1",
          fullPage: true,
          format: "png",
        },
      },
    });
    check("browser_unsupported", BrowserSessionSchema, {
      sessionId: "browser-2",
      state: 999 as BrowserSessionState,
      reasonCode: "chrome_not_found",
    });
    expect(
      fromBinary(BrowserSessionSchema, fixture("browser_unsupported")).state,
    ).toBe(999);
    check("browser_download", BrowserDownloadSchema, {
      downloadId: "d-1",
      sessionId: "browser-1",
      url: "http://127.0.0.1:8080/报告.pdf",
      suggestedFilename: "报告.pdf",
      state: BrowserDownloadState.PENDING,
      path: ".armadra/downloads/报告.pdf",
      totalBytes: 9007199254740993n,
      receivedBytes: 0n,
      createdAtUnixMs: 1788557000000n,
    });
  });
});
