import { beforeEach, describe, expect, it, vi } from "vitest";

const uploadAsset = vi.fn();
const assetUrl = vi.fn(
  (workspaceId: string, assetId: string) =>
    `http://127.0.0.1:43120/api/workspaces/${workspaceId}/assets/${assetId}`,
);
const error = vi.fn();

vi.mock("../api/client", () => ({
  runtimeApi: {
    uploadAsset: (...args: unknown[]) => uploadAsset(...args),
    assetUrl: (workspaceId: string, assetId: string) =>
      assetUrl(workspaceId, assetId),
  },
}));

vi.mock("sonner", () => ({ toast: { error: (...args: unknown[]) => error(...args) } }));

const { AssetTooLargeError, createAssetStore, MAX_UPLOAD_BYTES } = await import(
  "./assets",
);

function fileOf(bytes: number): File {
  const file = new File(["x"], "shot.png", { type: "image/png" });
  Object.defineProperty(file, "size", { value: bytes });
  return file;
}

const asset = {
  id: "asset:1",
  typeName: "asset",
  type: "image",
  props: { src: null, w: 10, h: 10 },
  meta: {},
} as never;

describe("createAssetStore", () => {
  beforeEach(() => {
    uploadAsset.mockReset();
    error.mockReset();
  });

  it("上传后回 Runtime URL，并把工作区相对路径写进 meta.armadra.path", async () => {
    uploadAsset.mockResolvedValue({
      id: "0a1bf7.png",
      path: ".armadra/assets/0a1bf7.png",
      url: "/api/workspaces/w1/assets/0a1bf7.png",
      mimeType: "image/png",
      bytes: 12,
    });

    const store = createAssetStore(() => "w1");
    const result = await store.upload(asset, fileOf(1024));

    expect(uploadAsset).toHaveBeenCalledWith("w1", expect.any(File));
    expect(result.src).toBe(
      "http://127.0.0.1:43120/api/workspaces/w1/assets/0a1bf7.png",
    );
    expect(result.meta).toEqual({ armadra: { path: ".armadra/assets/0a1bf7.png" } });
  });

  it("超过 8 MiB 时 toast 并拒绝，不发请求", async () => {
    const store = createAssetStore(() => "w1");
    await expect(
      store.upload(asset, fileOf(MAX_UPLOAD_BYTES + 1)),
    ).rejects.toBeInstanceOf(AssetTooLargeError);
    expect(uploadAsset).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
  });

  it("没有工作区时直接拒绝", async () => {
    const store = createAssetStore(() => null);
    await expect(store.upload(asset, fileOf(10))).rejects.toThrow();
    expect(uploadAsset).not.toHaveBeenCalled();
  });

  it("resolve 原样返回 src", () => {
    const store = createAssetStore(() => "w1");
    expect(
      store.resolve?.({ props: { src: "http://x/y.png" } } as never, {} as never),
    ).toBe("http://x/y.png");
    expect(store.resolve?.({ props: {} } as never, {} as never)).toBeNull();
  });
});

it("managed assets use the current runtime URL after reopening in desktop or web", () => {
  const store = createAssetStore(() => "current-workspace");
  const managed = { props: { src: "http://127.0.0.1:9999/old.png" }, meta: { armadra: { path: ".armadra/assets/0123456789abcdef.png" } } };
  expect(store.resolve?.(managed as never, {} as never)).toBe("http://127.0.0.1:43120/api/workspaces/current-workspace/assets/0123456789abcdef.png");
});
