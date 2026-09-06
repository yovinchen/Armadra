import { beforeEach, describe, expect, it, vi } from "vitest";

const uploadAsset = vi.fn();
const error = vi.fn();

vi.mock("../api/client", () => ({
  runtimeApi: {
    uploadAsset: (...args: unknown[]) => uploadAsset(...args),
    assetUrl: (workspaceId: string, assetId: string) =>
      `http://127.0.0.1:43120/api/workspaces/${workspaceId}/assets/${assetId}`,
  },
}));

vi.mock("sonner", () => ({
  toast: { error: (...args: unknown[]) => error(...args) },
}));

const {
  AssetTooLargeError,
  assetIdOf,
  assetUrlFor,
  MAX_UPLOAD_BYTES,
  megabytes,
  uploadAsset: upload,
  withinUploadLimit,
} = await import("./assets");

/**
 * 白板资产（React Flow 计划 F26）。
 *
 * 旧引擎的资产仓库接口没有了，剩下三件事：上传、限额、路径解析。
 * 最要紧的一条是**显示地址现算**——存下来的 localhost 地址会在下一次
 * 启动时指向别人的端口，那样重开应用所有图片都会碎掉。
 */

function fileOf(bytes: number): File {
  const file = new File(["x"], "shot.png", { type: "image/png" });
  Object.defineProperty(file, "size", { value: bytes });
  return file;
}

beforeEach(() => {
  uploadAsset.mockReset();
  error.mockReset();
});

describe("uploadAsset", () => {
  it("上传成功后返回工作区相对路径（白板文档里只留这个）", async () => {
    uploadAsset.mockResolvedValue({
      id: "0a1bf70011223344.png",
      path: ".armadra/assets/0a1bf70011223344.png",
      url: "/api/workspaces/w1/assets/0a1bf70011223344.png",
      mimeType: "image/png",
      bytes: 12,
    });
    await expect(upload("w1", fileOf(1024))).resolves.toBe(
      ".armadra/assets/0a1bf70011223344.png",
    );
    expect(uploadAsset).toHaveBeenCalledWith("w1", expect.any(File));
  });

  it("超过 8 MiB 时提示一次并拒绝，不发请求", async () => {
    await expect(
      upload("w1", fileOf(MAX_UPLOAD_BYTES + 1)),
    ).rejects.toBeInstanceOf(AssetTooLargeError);
    expect(uploadAsset).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
  });
});

describe("限额", () => {
  it("withinUploadLimit 卡在 8 MiB", () => {
    expect(withinUploadLimit(8 * 1024 * 1024)).toBe(true);
    expect(withinUploadLimit(8 * 1024 * 1024 + 1)).toBe(false);
  });

  it("megabytes 用来拼提示语", () => {
    expect(megabytes(8 * 1024 * 1024)).toBe("8");
  });
});

describe("路径解析", () => {
  it("从工作区相对路径里取回资产 id", () => {
    expect(assetIdOf(".armadra/assets/0123456789abcdef.png")).toBe(
      "0123456789abcdef.png",
    );
  });

  it("不是资产路径的一律 null（导入副本、绝对路径、空）", () => {
    for (const path of [
      ".armadra/imports/a/notes.md",
      "/tmp/shot.png",
      ".armadra/assets/../../etc/passwd",
      "",
      null,
      undefined,
    ]) {
      expect(assetIdOf(path), String(path)).toBeNull();
    }
  });

  it("显示地址现算：换了 Runtime 端口也不会指向上一次那个", () => {
    expect(assetUrlFor("w1", ".armadra/assets/0123456789abcdef.png")).toBe(
      "http://127.0.0.1:43120/api/workspaces/w1/assets/0123456789abcdef.png",
    );
  });

  it("没有工作区或路径不对时没有地址", () => {
    expect(
      assetUrlFor(null, ".armadra/assets/0123456789abcdef.png"),
    ).toBeNull();
    expect(assetUrlFor("w1", "/tmp/x.png")).toBeNull();
  });
});
