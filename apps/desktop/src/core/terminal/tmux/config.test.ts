import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { detect } from "./config";

/**
 * 从访达启动的应用只拿到 launchd 的 PATH，没有 Homebrew。探测必须和后端真正
 * 执行 tmux 时用同一条补过的 PATH，否则打包版会把一个找得到的 tmux 报成「没有」，
 * 悄悄退回 direct。
 */
describe("tmux detection", () => {
  let home: string | undefined;
  afterEach(() => {
    if (home !== undefined) rmSync(home, { recursive: true, force: true });
    home = undefined;
  });

  // 夹具是 `#!/bin/sh` 加执行位，Windows 上没有这件事（tmux 本来也不支持）。
  it.skipIf(process.platform === "win32")(
    "finds tmux on the augmented PATH, not only the launchd one",
    () => {
      home = mkdtempSync(join(tmpdir(), "armadra-tmux-detect-"));
      const bin = join(home, ".local", "bin");
      mkdirSync(bin, { recursive: true });
      const fake = join(bin, "tmux");
      writeFileSync(fake, "#!/bin/sh\necho 'tmux 9.9'\n");
      chmodSync(fake, 0o755);

      const detection = detect(process.platform, {
        HOME: home,
        // launchd 的 PATH 上没有它；留空确保找到的是 ~/.local/bin 那一份。
        PATH: "",
      });
      expect(detection).toEqual({ version: "9.9", usable: true });
    },
  );

  it("reports Windows as unsupported without probing", () => {
    expect(detect("win32").usable).toBe(false);
  });
});
