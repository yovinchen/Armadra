import { describe, expect, it } from "vitest";

import {
  downloadToastKind,
  humanBytes,
  parseDownloadNotice,
} from "./downloads";

describe("parseDownloadNotice", () => {
  it("只认得出结果的那一条", () => {
    expect(parseDownloadNotice({ state: "completed" })).toEqual({
      state: "completed",
      filename: "",
      path: "",
      bytes: 0,
    });
    expect(parseDownloadNotice({ filename: "a.pdf" })).toBeNull();
    expect(parseDownloadNotice({ state: "" })).toBeNull();
    expect(parseDownloadNotice(null)).toBeNull();
  });

  it("字段类型不对就退回默认，而不是原样带过去", () => {
    const notice = parseDownloadNotice({
      state: "completed",
      filename: 7,
      path: null,
      bytes: "12",
    });
    expect(notice).toEqual({
      state: "completed",
      filename: "",
      path: "",
      bytes: 0,
    });
  });
});

describe("downloadToastKind", () => {
  const notice = (state: string) => ({
    state,
    filename: "a.pdf",
    path: "/tmp/a.pdf",
    bytes: 1,
  });

  it("完成说一句，中断说一句", () => {
    expect(downloadToastKind(notice("completed"))).toBe("done");
    expect(downloadToastKind(notice("interrupted"))).toBe("failed");
  });

  it("人自己取消的不复读", () => {
    expect(downloadToastKind(notice("cancelled"))).toBeNull();
    expect(downloadToastKind(notice("progressing"))).toBeNull();
  });
});

describe("humanBytes", () => {
  it("KB 以下不细分", () => {
    expect(humanBytes(812)).toBe("0.8 KB");
    expect(humanBytes(1024)).toBe("1.0 KB");
  });

  it("十以上不要小数", () => {
    expect(humanBytes(1024 * 1024 * 12)).toBe("12 MB");
    expect(humanBytes(1024 * 1024 * 1.5)).toBe("1.5 MB");
  });

  it("没有大小就不说大小", () => {
    expect(humanBytes(0)).toBe("");
    expect(humanBytes(Number.NaN)).toBe("");
    expect(humanBytes(-1)).toBe("");
  });
});
