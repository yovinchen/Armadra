import { describe, expect, it } from "vitest";

import { assetPath, megabytes, withinUploadLimit } from "../assets";
import {
  IMAGE_GAP,
  MAX_IMAGE_DIMENSION,
  baseName,
  extensionOf,
  imageShapeSize,
  isImagePath,
  layoutImages,
  offsetBy,
  routeFile,
  routePath,
} from "./external-content";

const file = (name: string, type: string) => ({ name, type });

describe("routeFile", () => {
  it("认 MIME 白名单里的图片", () => {
    expect(routeFile(file("a.png", "image/png"))).toBe("image");
    expect(routeFile(file("a.svg", "image/svg+xml"))).toBe("image");
    expect(routeFile(file("a.avif", "image/avif"))).toBe("image");
  });

  it("MIME 为空时退回扩展名", () => {
    expect(routeFile(file("shot.JPEG", ""))).toBe("image");
    expect(routeFile(file("no-extension", ""))).toBe("file");
  });

  it("非图片一律持久化为文件", () => {
    expect(routeFile(file("notes.md", "text/markdown"))).toBe("file");
    expect(routeFile(file("main.rs", ""))).toBe("file");
    // Runtime 不收的图片格式也不当图片（会被资产接口 400）。
    expect(routeFile(file("clip.mp4", "video/mp4"))).toBe("file");
    expect(routeFile(file("x.tiff", "image/tiff"))).toBe("file");
  });
});

describe("routePath", () => {
  it("目录 → files 节点，文件 → editor 节点", () => {
    expect(routePath(true)).toBe("files");
    expect(routePath(false)).toBe("editor");
  });
});

describe("路径小工具", () => {
  it("baseName 认两种分隔符", () => {
    expect(baseName("/a/b/c.png")).toBe("c.png");
    expect(baseName("C:\\a\\b\\c.png")).toBe("c.png");
    expect(baseName("c.png")).toBe("c.png");
  });

  it("extensionOf 忽略大小写、不认隐藏文件的前导点", () => {
    expect(extensionOf("/a/B.PNG")).toBe("png");
    expect(extensionOf(".gitignore")).toBe("");
    expect(extensionOf("Makefile")).toBe("");
  });

  it("isImagePath 覆盖八种扩展名", () => {
    for (const ext of [
      "png",
      "jpg",
      "jpeg",
      "gif",
      "webp",
      "avif",
      "bmp",
      "svg",
    ]) {
      expect(isImagePath(`/tmp/a.${ext}`)).toBe(true);
    }
    expect(isImagePath("/tmp/a.txt")).toBe(false);
  });
});

describe("imageShapeSize", () => {
  it("小图保持自然尺寸", () => {
    expect(imageShapeSize({ w: 320, h: 200 })).toEqual({ w: 320, h: 200 });
    expect(imageShapeSize({ w: MAX_IMAGE_DIMENSION, h: 400 })).toEqual({
      w: MAX_IMAGE_DIMENSION,
      h: 400,
    });
  });

  it("按最大边等比缩到 800", () => {
    expect(imageShapeSize({ w: 4000, h: 2000 })).toEqual({ w: 800, h: 400 });
    expect(imageShapeSize({ w: 1000, h: 3000 })).toEqual({ w: 267, h: 800 });
  });

  it("尺寸不合法时退回正方形", () => {
    expect(imageShapeSize({ w: 0, h: 0 })).toEqual({ w: 800, h: 800 });
    expect(imageShapeSize({ w: Number.NaN, h: Number.NaN })).toEqual({
      w: 800,
      h: 800,
    });
  });

  it("最大边可覆盖", () => {
    expect(imageShapeSize({ w: 400, h: 200 }, 100)).toEqual({ w: 100, h: 50 });
  });
});

describe("layoutImages", () => {
  it("单张图居中在落点上", () => {
    expect(layoutImages([{ w: 200, h: 100 }], { x: 50, y: 30 })).toEqual([
      { x: -50, y: -20 },
    ]);
  });

  it("多张图横排、整排居中、间距固定", () => {
    const points = layoutImages(
      [
        { w: 100, h: 100 },
        { w: 100, h: 50 },
      ],
      { x: 0, y: 0 },
    );
    const total = 100 + 100 + IMAGE_GAP;
    expect(points[0]).toEqual({ x: -total / 2, y: -50 });
    expect(points[1]).toEqual({ x: -total / 2 + 100 + IMAGE_GAP, y: -25 });
  });

  it("空数组不产生落点", () => {
    expect(layoutImages([], { x: 0, y: 0 })).toEqual([]);
  });
});

describe("offsetBy", () => {
  it("每个节点错开 28px", () => {
    expect(offsetBy({ x: 10, y: 20 }, 0)).toEqual({ x: 10, y: 20 });
    expect(offsetBy({ x: 10, y: 20 }, 2)).toEqual({ x: 66, y: 76 });
  });
});

describe("资产 meta", () => {
  it("withinUploadLimit 卡在 8 MiB", () => {
    expect(withinUploadLimit(8 * 1024 * 1024)).toBe(true);
    expect(withinUploadLimit(8 * 1024 * 1024 + 1)).toBe(false);
  });

  it("megabytes 用来拼提示语", () => {
    expect(megabytes(8 * 1024 * 1024)).toBe("8");
  });

  it("assetPath 读 meta.armadra.path", () => {
    expect(
      assetPath({ meta: { armadra: { path: ".armadra/assets/ab.png" } } }),
    ).toBe(".armadra/assets/ab.png");
  });

  it("旧资产（没有 meta.armadra）回 null", () => {
    expect(assetPath({ meta: {} })).toBeNull();
    expect(assetPath({ meta: { armadra: {} } })).toBeNull();
    expect(assetPath({ meta: { armadra: "nope" } })).toBeNull();
    expect(assetPath(undefined)).toBeNull();
  });
});
