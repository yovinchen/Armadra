import { describe, expect, it } from "vitest";

import { ReplayScreen, renderScreen } from "./replay-screen";

const ESC = "\u001b";

describe("回放缓冲放到屏幕上", () => {
  it("逐行打印的 shell 输出原样读出来", () => {
    expect(renderScreen("probe% ls\r\nREADME.md\r\nprobe% ", 40, 5)).toBe(
      "probe% ls\nREADME.md\nprobe%\n\n",
    );
  });

  // Claude Code 2.1.260 实际的输出形状（节选自 direct 后端的回放）：跳列代替
  // 空格，下移与定位代替换行。
  it("跳列、下移与定位还原成屏幕上的行与空格", () => {
    const raw =
      `${ESC}[H${ESC}[1B ▐▛███▛█${ESC}[12GClaude Code${ESC}[24Gv2.1.260` +
      `${ESC}[1B\r▝▜█████▀${ESC}[12GSonnet 5` +
      `${ESC}[6;1H${ESC}[2GQuick${ESC}[8Gsafety${ESC}[15Gcheck:` +
      `${ESC}[9;3H? for shortcuts`;
    const lines = renderScreen(raw, 60, 10).split("\n");
    expect(lines[1]).toBe(" ▐▛███▛█   Claude Code v2.1.260");
    expect(lines[2]).toBe("▝▜█████▀   Sonnet 5");
    expect(lines[5]).toBe(" Quick safety check:");
    expect(lines[8]).toBe("  ? for shortcuts");
  });

  // Codex 每一拍都定位回同几行重画：屏幕上只剩最后一帧，不是一长串碎片。
  it("反复重画同几行，读到的是最后一帧", () => {
    let raw = `${ESC}[3;1H› Ask Codex to do anything`;
    for (let frame = 0; frame < 500; frame += 1) {
      raw += `${ESC}[1;1H${ESC}[K⠋ frame ${frame}${ESC}[2;1H${ESC}[K⠙ ${frame}`;
    }
    const text = renderScreen(raw, 40, 4);
    expect(text.split("\n")).toHaveLength(4);
    expect(text).toContain("frame 499");
    expect(text).toContain("› Ask Codex to do anything");
    expect(text).not.toContain("frame 498");
  });

  it("滚出屏幕的行进历史，备屏的不进", () => {
    const lines = Array.from({ length: 6 }, (_, index) => `line ${index}`);
    const main = renderScreen(lines.join("\r\n"), 20, 3);
    expect(main.split("\n")).toEqual(lines);
    const alternate = renderScreen(
      `before\r\n${ESC}[?1049h${lines.join("\r\n")}${ESC}[?1049l`,
      20,
      3,
    );
    // 退出备屏回到主屏：备屏上的东西不留，主屏还是原来那样。
    expect(alternate.split("\n")[0]).toBe("before");
    expect(alternate).not.toContain("line 5");
  });

  it("擦除、插入与删除字符", () => {
    expect(renderScreen(`abcdef${ESC}[3G${ESC}[K`, 20, 2).split("\n")[0]).toBe(
      "ab",
    );
    expect(renderScreen(`abcdef${ESC}[2G${ESC}[2P`, 20, 2).split("\n")[0]).toBe(
      "adef",
    );
    expect(renderScreen(`abcdef${ESC}[2G${ESC}[2@`, 20, 2).split("\n")[0]).toBe(
      "a  bcdef",
    );
    expect(renderScreen(`one\r\ntwo${ESC}[2J${ESC}[Hx`, 20, 2)).toBe("x\n");
  });

  it("宽字符占两列，写满一行自动折行", () => {
    expect(renderScreen(`中文${ESC}[5Gx`, 20, 2).split("\n")[0]).toBe("中文x");
    expect(renderScreen("abcdefgh", 5, 3).split("\n").slice(0, 2)).toEqual([
      "abcde",
      "fgh",
    ]);
  });

  it("滚动区里滚动，区外的行不动", () => {
    const raw = `header\r\n${ESC}[2;3r${ESC}[2;1Ha\r\nb\r\nc\r\nd`;
    const lines = renderScreen(raw, 20, 4).split("\n");
    expect(lines[0]).toBe("header");
    expect(lines.slice(1, 3)).toEqual(["c", "d"]);
  });

  it("颜色、标题与查询都不影响字", () => {
    const raw = `${ESC}]0;title\u0007${ESC}[1;32mok${ESC}[0m ${ESC}[>0q${ESC}[c${ESC}(Bdone`;
    expect(renderScreen(raw, 20, 2).split("\n")[0]).toBe("ok done");
  });

  it("转义序列与多字节字符断在两块之间也读得对", () => {
    const screen = new ReplayScreen(20, 3);
    const raw = `${ESC}[2;3Hok${ESC}]0;title\u0007${ESC}[1;5H中`;
    // 一个字符一个字符地喂。
    for (const character of raw) screen.write(character);
    screen.write(`${ESC}[`);
    screen.write("2;1");
    screen.write("Hx");
    const lines = screen.text().split("\n");
    expect(lines[0]).toBe("    中");
    expect(lines[1]).toBe("x ok");
  });

  it("改尺寸：顶上放不下的行进历史，列少了截掉", () => {
    const screen = new ReplayScreen(10, 4);
    screen.write("a\r\nb\r\nc\r\nd-longer");
    screen.resize(6, 2);
    expect(screen.text().split("\n")).toEqual(["a", "b", "c", "d-long"]);
    screen.write("\r\nnext");
    expect(screen.text().split("\n").slice(-2)).toEqual(["d-long", "next"]);
  });
});
