import { afterEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TmuxControl } from "../terminal/tmux/control";
import { panePids, tmuxServerArgs } from "./sessions";

/**
 * 采样问的必须是 core 自己那台 tmux 服务器。
 *
 * 少了 `-S <dataDir>/tmux.sock`，`tmux list-panes -a` 问的是用户默认的那台
 * （`/tmp/tmux-<uid>/default`），而 core 的每个会话都活在自己那台上
 * （`terminal/tmux/control.ts`）。两台互不知情，于是**每个终端会话都报
 * `no-pid`**：面板里没有进程号、没有 CPU、没有内存、没有进程树，`no-row` 孤立
 * 会话也永远扫不出来。真机上量过：默认服务器答「no server running」，core 的
 * 那台答出 pane pid。
 */
describe("tmuxServerArgs", () => {
  it("寻址的是数据目录里那台服务器，不是默认那台", () => {
    expect(tmuxServerArgs("/tmp/armadra-data")).toEqual([
      "-S",
      join("/tmp/armadra-data", "tmux.sock"),
      "-f",
      join("/tmp/armadra-data", "tmux.conf"),
    ]);
  });

  /**
   * 两处各自拼一遍路径，拼错一处就是「采样看不见终端域建的会话」。所以这一条
   * 直接拿终端域那份做基准，而不是再写一遍字面量。
   */
  it("套接字与配置路径和终端域用的完全一致", () => {
    const control = new TmuxControl("/tmp/armadra-data");
    const args = tmuxServerArgs("/tmp/armadra-data");
    expect(args[args.indexOf("-S") + 1]).toBe(control.socket);
    expect(args[args.indexOf("-f") + 1]).toBe(control.conf);
  });

  it("没有数据目录时退回裸 tmux，而不是拼出一个空路径", () => {
    expect(tmuxServerArgs(undefined)).toEqual([]);
  });
});

/**
 * 从访达启动的打包版只拿到 launchd 的 PATH，没有 Homebrew。终端域执行 tmux 时
 * 用的是补过的 PATH（`agentPath`），采样若还用继承来的那条，就找不到 tmux，
 * 表是空的——资源面板里每个会话都报「没有可用的进程号」，而会话明明活着。
 * 打包版实测复现过。
 */
describe("panePids", () => {
  let home: string | undefined;
  afterEach(() => {
    if (home !== undefined) rmSync(home, { recursive: true, force: true });
    home = undefined;
  });

  // 夹具是 `#!/bin/sh` 加执行位，Windows 上没有这件事（tmux 本来也不支持）。
  it.skipIf(process.platform === "win32")(
    "在补过的 PATH 上找 tmux，而不只是 launchd 那条",
    () => {
      home = mkdtempSync(join(tmpdir(), "armadra-pane-pids-"));
      const bin = join(home, ".local", "bin");
      mkdirSync(bin, { recursive: true });
      const fake = join(bin, "tmux");
      writeFileSync(fake, "#!/bin/sh\necho 'armadra-probe 4242'\n");
      chmodSync(fake, 0o755);

      // PATH 留空：找到的只能是 ~/.local/bin 那一份。
      const pids = panePids(join(home, "data"), { HOME: home, PATH: "" });
      expect(pids.get("armadra-probe")).toBe(4242);
    },
  );
});
