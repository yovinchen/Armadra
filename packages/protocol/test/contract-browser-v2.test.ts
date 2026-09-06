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
  BrowserActionResultSchema,
  BrowserActivitySchema,
  BrowserAvailabilitySchema,
  BrowserBandwidthClass,
  BrowserDialogKind,
  BrowserDownloadSchema,
  BrowserDownloadState,
  BrowserElementSchema,
  BrowserInputKind,
  BrowserLeaseAction,
  BrowserLeaseSchema,
  BrowserLeaseState,
  BrowserManagedInstallState,
  BrowserManagedStateSchema,
  BrowserSessionSchema,
  BrowserSessionState,
  BrowserStreamClientSchema,
  BrowserStreamFrameSchema,
  BrowserSubscriptionSchema,
  BrowserTabAction,
  BrowserTabListSchema,
  BrowserVisibility,
} from "../src/index.js";

/**
 * 受控浏览器补全的线格式（remote-and-browser-completion §2.11）：受管二进制、
 * 标签与 frame、控制租约、对话框与选择器、新动词、专用帧流。与首轮的
 * `contract.test.ts` 分文件，首轮的 golden 字节不会被这一轮改动。
 */
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

describe("controlled browser: tabs, lease, dialogs, managed binary, stream", () => {
  it("carries tabs, a lease, a blocked dialog and a chooser on the session", () => {
    check("browser_control_session", BrowserSessionSchema, {
      sessionId: "browser-1",
      generation: 3n,
      workspaceId: "workspace-1",
      nodeId: "node-1",
      url: "http://127.0.0.1:8080/表单",
      title: "受控浏览器 😀",
      viewport: { width: 1000, height: 700, deviceScaleFactor: 2 },
      state: BrowserSessionState.READY,
      activeTabId: "t2",
      tabCount: 3,
      lease: {
        state: BrowserLeaseState.AGENT,
        generation: 7n,
        expiresAtUnixMs: 1788557900000n,
        holder: {
          case: "agent",
          value: {
            nodeId: "node-2",
            sessionId: "agent-1",
            displayName: "评审 Agent",
          },
        },
      },
      pendingDialog: {
        dialogId: "d-1",
        tabId: "t2",
        kind: BrowserDialogKind.PROMPT,
        message: "确认提交？",
        defaultPrompt: "默认",
        url: "http://127.0.0.1:8080/表单",
        openedAtUnixMs: 1788557900000n,
      },
      pendingFileChooser: {
        chooserId: "c-1",
        tabId: "t2",
        frameId: "f3",
        multiple: true,
        accept: ".png,.jpg",
        openedAtUnixMs: 1788557900001n,
      },
      leaseGeneration: maxUint64,
      createdAtUnixMs: 1788557000000n,
      updatedAtUnixMs: 1788557900000n,
    });
  });

  it("reports a managed install honestly, including the paths it cannot take", () => {
    check("browser_managed_unsupported", BrowserManagedStateSchema, {
      state: BrowserManagedInstallState.FAILED,
      version: "131.0.6778.85",
      reasonCode: "manifest_missing_target",
      supported: false,
    });
    check("browser_managed_progress", BrowserManagedStateSchema, {
      state: BrowserManagedInstallState.DOWNLOADING,
      version: "131.0.6778.85",
      receivedBytes: 9007199254740993n,
      totalBytes: maxUint64,
      supported: true,
    });
    check("browser_availability_managed", BrowserAvailabilitySchema, {
      available: true,
      executable:
        "/data/browser-managed/131.0.6778.85-macos-arm64/Chrome.app/Contents/MacOS/Chrome",
      source: "managed",
      searched: [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      ],
      managed: {
        state: BrowserManagedInstallState.INSTALLED,
        version: "131.0.6778.85",
        totalBytes: 172_000_000n,
        supported: true,
        executable:
          "/data/browser-managed/131.0.6778.85-macos-arm64/Chrome.app/Contents/MacOS/Chrome",
      },
    });
    check("browser_result_managed", BrowserActionResultSchema, {
      requestId: "请求-managed",
      result: {
        case: "managed",
        value: {
          state: BrowserManagedInstallState.FAILED,
          version: "131.0.6778.85",
          reasonCode: "sha256_mismatch",
          supported: true,
        },
      },
    });
  });

  it("names tabs and binds element references to a tab and a frame", () => {
    check("browser_tab_list", BrowserTabListSchema, {
      tabs: [
        {
          tabId: "t1",
          url: "http://127.0.0.1:8080/",
          title: "首页",
          navigationEpoch: 4n,
        },
        {
          tabId: "t2",
          url: "http://127.0.0.1:8081/弹窗",
          title: "弹窗 😀",
          active: true,
          openerTabId: "t1",
          navigationEpoch: maxUint64,
          loading: true,
          pendingDialog: {
            dialogId: "d-2",
            tabId: "t2",
            kind: BrowserDialogKind.BEFORE_UNLOAD,
            message: "离开此页？",
          },
        },
      ],
      activeTabId: "t2",
      limit: 16,
    });
    check("browser_element_frame", BrowserElementSchema, {
      elementRef: "e4-12@t2/f3",
      role: "textbox",
      name: "邮箱",
      value: "a@b.c",
      selector: "#email",
      visible: true,
      x: 10,
      y: 20,
      width: 200,
      height: 32,
      tabId: "t2",
      frameId: "f3",
    });
    check("browser_download_hashed", BrowserDownloadSchema, {
      downloadId: "d-1",
      sessionId: "browser-1",
      url: "http://127.0.0.1:8080/报告.pdf",
      suggestedFilename: "报告.pdf",
      state: BrowserDownloadState.COMPLETED,
      path: ".armadra/downloads/报告.pdf",
      totalBytes: 4096n,
      receivedBytes: 4096n,
      createdAtUnixMs: 1788557000000n,
      tabId: "t2",
      sha256: new Uint8Array([
        0x00, 0xff, 0x10, 0x20, 0x30, 0x40, 0x50, 0x60, 0x70, 0x80, 0x90, 0xa0,
        0xb0, 0xc0, 0xd0, 0xe0, 0xf0, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07,
        0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f,
      ]),
    });
  });

  it("keeps an unknown lease state unknown instead of reading it as free", () => {
    check("browser_lease_takeover", BrowserLeaseSchema, {
      state: BrowserLeaseState.HUMAN_TAKEOVER,
      generation: 9007199254740993n,
      holder: {
        case: "human",
        value: { deviceId: "device-1", displayName: "手机📱" },
      },
    });
    check("browser_lease_free", BrowserLeaseSchema, {
      state: BrowserLeaseState.FREE,
      generation: 1n,
    });
    expect(
      fromBinary(BrowserLeaseSchema, fixture("browser_lease_unknown")).state,
    ).toBe(999);
  });

  it("gives every new verb a target and the lease generation it is judged by", () => {
    check("browser_action_select", BrowserActionSchema, {
      action: {
        case: "select",
        value: {
          meta: { requestId: "请求-select" },
          sessionId: "browser-1",
          navigationEpoch: 4n,
          elementRef: "e4-2",
          values: ["cn", "jp"],
          labels: ["中国", "日本"],
          target: { tabId: "t2", frameId: "f3" },
          leaseGeneration: 7n,
        },
      },
    });
    check("browser_action_press", BrowserActionSchema, {
      action: {
        case: "press",
        value: {
          meta: { requestId: "请求-press" },
          sessionId: "browser-1",
          navigationEpoch: 4n,
          key: "Enter",
          modifiers: 15,
          repeat: 2,
          leaseGeneration: 7n,
        },
      },
    });
    check("browser_action_scroll", BrowserActionSchema, {
      action: {
        case: "scroll",
        value: {
          meta: { requestId: "请求-scroll" },
          sessionId: "browser-1",
          navigationEpoch: 4n,
          direction: "down",
          amount: 480.5,
          leaseGeneration: 7n,
        },
      },
    });
    check("browser_action_upload", BrowserActionSchema, {
      action: {
        case: "upload",
        value: {
          meta: { requestId: "请求-upload" },
          sessionId: "browser-1",
          chooserId: "c-1",
          paths: ["docs/报告.pdf", "assets/图.png"],
          target: { tabId: "t2" },
          leaseGeneration: 7n,
        },
      },
    });
    check("browser_action_dialog", BrowserActionSchema, {
      action: {
        case: "dialog",
        value: {
          meta: { requestId: "请求-dialog" },
          sessionId: "browser-1",
          tabId: "t2",
          dialogId: "d-1",
          accept: true,
          promptText: "确认 😀",
          leaseGeneration: 7n,
        },
      },
    });
    check("browser_action_tabs", BrowserActionSchema, {
      action: {
        case: "tabs",
        value: {
          meta: { requestId: "请求-tabs" },
          sessionId: "browser-1",
          action: BrowserTabAction.NEW,
          url: "http://127.0.0.1:8081/",
        },
      },
    });
    check("browser_action_lease", BrowserActionSchema, {
      action: {
        case: "lease",
        value: {
          meta: { requestId: "请求-lease" },
          sessionId: "browser-1",
          action: BrowserLeaseAction.TAKEOVER,
          leaseGeneration: 7n,
          deviceId: "设备-1",
          displayName: "iPhone",
        },
      },
    });
    check("browser_action_close_tab", BrowserActionSchema, {
      action: {
        case: "closeTab",
        value: {
          meta: { requestId: "请求-close-tab" },
          sessionId: "browser-1",
          tabId: "t2",
          leaseGeneration: 7n,
        },
      },
    });
    check("browser_action_managed_install", BrowserActionSchema, {
      action: {
        case: "managedInstall",
        value: { meta: { requestId: "请求-managed" }, install: true },
      },
    });
    check("browser_result_tabs", BrowserActionResultSchema, {
      requestId: "请求-tabs",
      result: {
        case: "tabs",
        value: {
          tabs: [{ tabId: "t1", url: "http://127.0.0.1:8080/", active: true }],
          activeTabId: "t1",
          limit: 16,
        },
      },
    });
  });

  it("streams raw frames down and a closed set of messages up", () => {
    check("browser_stream_frame", BrowserStreamFrameSchema, {
      sessionId: "browser-1",
      generation: 3n,
      frameSeq: 9007199254740993n,
      navigationEpoch: maxUint64,
      tabId: "t2",
      viewportWidth: 1280,
      viewportHeight: 800,
      deviceScaleFactor: 1.5,
      encoding: "jpeg",
      data: new Uint8Array([0xff, 0xd8, 0x00, 0xff]),
      capturedAtUnixMs: 1788557900000n,
    });
    check("browser_stream_hello", BrowserStreamClientSchema, {
      message: {
        case: "hello",
        value: {
          sessionId: "browser-1",
          subscriptionId: "sub-1",
          visibility: BrowserVisibility.FOCUSED,
          bandwidthClass: BrowserBandwidthClass.METERED,
          maxWidth: 960,
        },
      },
    });
    check("browser_stream_ack", BrowserStreamClientSchema, {
      message: { case: "ack", value: maxUint64 },
    });
    check("browser_stream_input", BrowserStreamClientSchema, {
      message: {
        case: "input",
        value: {
          sessionId: "browser-1",
          navigationEpoch: 4n,
          frameSeq: 7n,
          events: [{ kind: BrowserInputKind.TOUCH_START, x: 100, y: 200 }],
          target: { tabId: "t2" },
          leaseGeneration: 7n,
        },
      },
    });
    check("browser_subscription_degraded", BrowserSubscriptionSchema, {
      subscriptionId: "sub-1",
      expiresAtUnixMs: 1788557900000n,
      quality: 45,
      maxFps: 4,
      maxWidth: 960,
    });
    check("browser_activity_refused", BrowserActivitySchema, {
      sessionId: "browser-1",
      actor: "agent",
      actorId: "node-2",
      verb: "click",
      target: "e4-12@t2/f3",
      outcome: "refused",
      reasonCode: "LEASE_REVOKED",
      atUnixMs: 1788557900000n,
    });
  });
});
