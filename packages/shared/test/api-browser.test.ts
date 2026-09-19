import { describe, expect, it } from "vitest";
import {
  browserAvailabilitySchema,
  browserReadSchema,
  browserSessionSchema,
  browserTabListSchema,
  browserUploadedSchema,
  browserViewportSchema,
} from "../src/index.js";

const timestamp = "2026-08-13T00:00:00.000Z";
const uuid = "019ff7d1-5c48-7d75-a0ed-64b52f44e214";
const otherUuid = "019ff7d1-7419-74df-89e2-b1619d36ea7d";

const browserSession = {
  sessionId: uuid,
  generation: 1,
  workspaceId: otherUuid,
  nodeId: otherUuid,
  url: "https://example.test/",
  title: "Example",
  viewport: { width: 1280, height: 720, deviceScaleFactor: 2 },
  state: "ready",
  reasonCode: "",
  navigationEpoch: 3,
  headful: false,
  keepAlive: true,
  canGoBack: true,
  canGoForward: false,
  createdAt: timestamp,
  updatedAt: timestamp,
};

describe("runtime browser API", () => {
  it("models a controlled browser session and its reads", () => {
    const parsed = browserSessionSchema.parse(browserSession);
    expect(parsed.navigationEpoch).toBe(3);
    // 一个 viewport 至少是 1×1，缩放因子默认 1（设计 §8）。
    expect(browserViewportSchema.parse({ width: 800, height: 600 })).toEqual({
      width: 800,
      height: 600,
      deviceScaleFactor: 1,
    });
    expect(
      browserViewportSchema.safeParse({ width: 0, height: 600 }).success,
    ).toBe(false);
    expect(
      browserSessionSchema.safeParse({ ...browserSession, state: "napping" })
        .success,
    ).toBe(false);

    // 读页面的列表字段都可缺省，旧 Runtime 少给一段不该炸。
    const read = browserReadSchema.parse({
      sessionId: uuid,
      navigationEpoch: 3,
      url: "https://example.test/",
      title: "Example",
    });
    expect(read).toMatchObject({
      text: "",
      elements: [],
      console: [],
      network: [],
      truncated: false,
    });

    // 没有浏览器时，找过的路径本身就是给用户看的内容。
    expect(
      browserAvailabilitySchema.parse({
        available: false,
        executable: "",
        source: "none",
        reasonCode: "chrome_not_found",
      }).searched,
    ).toEqual([]);
  });

  it("models a tab strip and an upload receipt", () => {
    const tabs = browserTabListSchema.parse({
      tabs: [
        { tabId: "t1", url: "https://example.test/", title: "Example" },
        {
          tabId: "t2",
          active: true,
          openerTabId: "t1",
          loading: true,
          favicon: "data:image/png;base64,iVBORw0KGgo=",
          pendingDialog: {
            dialogId: "d-1",
            tabId: "t2",
            kind: "confirm",
            message: "Sure?",
            openedAt: timestamp,
          },
        },
      ],
      activeTabId: "t2",
    });
    // 一个只报了 id 的标签也要能解出来：Runtime 在标签刚出现、还没导航完
    // 的那一刻推的就是这个形状。
    expect(tabs.tabs[0]).toMatchObject({ favicon: "", loading: false });
    expect(tabs.tabs[1]?.pendingDialog?.kind).toBe("confirm");
    expect(tabs.limit).toBe(16);
    expect(
      browserTabListSchema.safeParse({
        tabs: [
          {
            tabId: "t1",
            pendingDialog: {
              dialogId: "d",
              tabId: "t1",
              kind: "toast",
              message: "",
              openedAt: timestamp,
            },
          },
        ],
      }).success,
    ).toBe(false);

    expect(browserUploadedSchema.parse({ paths: ["a.png"] })).toEqual({
      paths: ["a.png"],
      tabId: "",
      answeredChooser: false,
    });
  });
});
