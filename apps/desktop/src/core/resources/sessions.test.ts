import { describe, expect, it } from "vitest";
import { join } from "node:path";

import { TmuxControl } from "../terminal/tmux/control";
import { tmuxServerArgs } from "./sessions";

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
