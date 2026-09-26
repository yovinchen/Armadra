/**
 * 回放缓冲 → 一块屏幕：direct 后端的 `capture`（终端宿主设计 §5）。
 *
 * tmux 的 capture 读的是 tmux 自己维护的真屏幕；direct 后端没有屏幕，只有
 * PTY 输出的回放缓冲。去掉转义直接当文本用，对逐行打印的 shell 够用，对全屏
 * 界面不行：Claude 用「跳到第 n 列」代替空格、用「下移 / 定位」代替换行，
 * Codex 每一拍都定位回去重画同几行——读出来要么是一整行粘在一起的字，要么
 * 最后几十行全是动画的碎片（2026-09-26 direct 后端端到端实测）。Agent 读邻居
 * 终端（`context terminal`）、首投放行门看提示符，要的都是「屏幕上此刻是什
 * 么」。
 *
 * 所以在回放上跑一个只管字形与位置的小终端：光标移动、定位、擦除、滚动区、
 * 主 / 备屏幕、换行与自动折行；颜色与属性一概不管。宽字符（CJK、表情）占两
 * 列。这是近似：回放缓冲只留最后一段，开头可能落在某个状态中间；没实现的序列
 * 按「什么都不做」处理。答案是主屏幕滚出去的历史加上当前这一屏，行尾空白去
 * 掉——与 tmux `capture-pane` 读出来的形状一致。
 */

/** 滚出屏幕的历史最多留这么多行；capture 本来也只要最后几百行。 */
const MAX_HISTORY = 2_000;
/** 一次移动或擦除的参数上限：荒唐的参数不造出一大片空白。 */
const MAX_PARAMETER = 10_000;

type Row = string[];

function blankRow(cols: number): Row {
  return new Array<string>(cols).fill(" ");
}

/** 占两列的字符（东亚宽字符与大多数表情），近似 wcwidth。 */
function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0x303e) ||
    (code >= 0x3041 && code <= 0x33ff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xa000 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f64f) ||
    (code >= 0x1f900 && code <= 0x1f9ff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  );
}

/** 不占列的字符：组合用字符、零宽字符、变体选择符。 */
function isZeroWidth(code: number): boolean {
  return (
    (code >= 0x0300 && code <= 0x036f) ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0xfe00 && code <= 0xfe0f) ||
    code === 0x20e3
  );
}

class Screen {
  private main: Row[];
  private alternate: Row[] | undefined;
  private readonly history: string[] = [];
  private x = 0;
  private y = 0;
  private saved = { x: 0, y: 0 };
  private top = 0;
  private bottom: number;
  /** 上一格写到了最后一列：下一个字符先折行（与 xterm 的延迟折行一致）。 */
  private wrapPending = false;

  constructor(
    private readonly cols: number,
    private readonly rows: number,
  ) {
    this.main = Array.from({ length: rows }, () => blankRow(cols));
    this.bottom = rows - 1;
  }

  private get lines(): Row[] {
    return this.alternate ?? this.main;
  }

  /* -------------------------------- 写字 -------------------------------- */

  put(character: string): void {
    const code = character.codePointAt(0) ?? 0;
    if (isZeroWidth(code)) return;
    const width = isWide(code) ? 2 : 1;
    if (this.wrapPending || this.x + width > this.cols) {
      this.wrapPending = false;
      this.x = 0;
      this.lineFeed();
    }
    const row = this.lines[this.y] as Row;
    row[this.x] = character;
    if (width === 2 && this.x + 1 < this.cols) row[this.x + 1] = "";
    this.x += width;
    if (this.x >= this.cols) {
      this.x = this.cols - 1;
      this.wrapPending = true;
    }
  }

  carriageReturn(): void {
    this.x = 0;
    this.wrapPending = false;
  }

  backspace(): void {
    this.x = Math.max(0, this.x - 1);
    this.wrapPending = false;
  }

  tab(): void {
    this.x = Math.min(this.cols - 1, (Math.floor(this.x / 8) + 1) * 8);
  }

  lineFeed(): void {
    this.wrapPending = false;
    if (this.y === this.bottom) this.scrollUp(1);
    else this.y = Math.min(this.rows - 1, this.y + 1);
  }

  reverseIndex(): void {
    if (this.y === this.top) this.scrollDown(1);
    else this.y = Math.max(0, this.y - 1);
  }

  /* -------------------------------- 滚动 -------------------------------- */

  scrollUp(count: number): void {
    const lines = this.lines;
    for (let index = 0; index < count; index += 1) {
      const [gone] = lines.splice(this.top, 1);
      // 只有主屏幕、从顶上滚出去的行进历史；备屏与滚动区中间的不算。
      if (this.alternate === undefined && this.top === 0 && gone) {
        this.history.push(gone.join("").trimEnd());
        if (this.history.length > MAX_HISTORY) this.history.shift();
      }
      lines.splice(this.bottom, 0, blankRow(this.cols));
    }
  }

  scrollDown(count: number): void {
    const lines = this.lines;
    for (let index = 0; index < count; index += 1) {
      lines.splice(this.bottom, 1);
      lines.splice(this.top, 0, blankRow(this.cols));
    }
  }

  /* -------------------------------- 光标 -------------------------------- */

  moveTo(row: number, column: number): void {
    this.y = Math.min(Math.max(row, 0), this.rows - 1);
    this.x = Math.min(Math.max(column, 0), this.cols - 1);
    this.wrapPending = false;
  }

  moveBy(rows: number, columns: number): void {
    this.moveTo(this.y + rows, this.x + columns);
  }

  column(value: number): void {
    this.moveTo(this.y, value);
  }

  row(value: number): void {
    this.moveTo(value, this.x);
  }

  save(): void {
    this.saved = { x: this.x, y: this.y };
  }

  restore(): void {
    this.moveTo(this.saved.y, this.saved.x);
  }

  region(top: number, bottom: number): void {
    const upper = Math.min(Math.max(top, 0), this.rows - 1);
    const lower = Math.min(Math.max(bottom, upper), this.rows - 1);
    this.top = upper;
    this.bottom = lower;
    this.moveTo(0, 0);
  }

  /* -------------------------------- 擦除 -------------------------------- */

  eraseInLine(mode: number): void {
    const row = this.lines[this.y] as Row;
    const [from, to] =
      mode === 1
        ? [0, this.x + 1]
        : mode === 2
          ? [0, this.cols]
          : [this.x, this.cols];
    for (let column = from; column < to; column += 1) row[column] = " ";
  }

  eraseInDisplay(mode: number): void {
    const lines = this.lines;
    if (mode === 2 || mode === 3) {
      for (let index = 0; index < this.rows; index += 1)
        lines[index] = blankRow(this.cols);
      if (mode === 3 && this.alternate === undefined) this.history.length = 0;
      return;
    }
    this.eraseInLine(mode === 1 ? 1 : 0);
    if (mode === 1) {
      for (let index = 0; index < this.y; index += 1)
        lines[index] = blankRow(this.cols);
    } else {
      for (let index = this.y + 1; index < this.rows; index += 1)
        lines[index] = blankRow(this.cols);
    }
  }

  eraseCharacters(count: number): void {
    const row = this.lines[this.y] as Row;
    for (
      let column = this.x;
      column < Math.min(this.cols, this.x + count);
      column += 1
    )
      row[column] = " ";
  }

  deleteCharacters(count: number): void {
    const row = this.lines[this.y] as Row;
    row.splice(this.x, Math.min(count, this.cols - this.x));
    while (row.length < this.cols) row.push(" ");
  }

  insertBlanks(count: number): void {
    const row = this.lines[this.y] as Row;
    row.splice(this.x, 0, ...blankRow(Math.min(count, this.cols - this.x)));
    row.length = this.cols;
  }

  insertLines(count: number): void {
    if (this.y < this.top || this.y > this.bottom) return;
    const lines = this.lines;
    for (let index = 0; index < count; index += 1) {
      lines.splice(this.bottom, 1);
      lines.splice(this.y, 0, blankRow(this.cols));
    }
  }

  deleteLines(count: number): void {
    if (this.y < this.top || this.y > this.bottom) return;
    const lines = this.lines;
    for (let index = 0; index < count; index += 1) {
      lines.splice(this.y, 1);
      lines.splice(this.bottom, 0, blankRow(this.cols));
    }
  }

  /* ------------------------------ 主 / 备屏 ------------------------------ */

  useAlternate(on: boolean): void {
    if (on && this.alternate === undefined) {
      this.save();
      this.alternate = Array.from({ length: this.rows }, () =>
        blankRow(this.cols),
      );
    } else if (!on && this.alternate !== undefined) {
      this.alternate = undefined;
      this.restore();
    }
  }

  reset(): void {
    this.main = Array.from({ length: this.rows }, () => blankRow(this.cols));
    this.alternate = undefined;
    this.moveTo(0, 0);
    this.top = 0;
    this.bottom = this.rows - 1;
  }

  /**
   * 换一个尺寸：列多了补空、少了截掉；行少了把顶上的挪进历史（与 tmux 缩小
   * 窗口时一样），行多了在底下补空行。不重排折过的行。
   */
  resized(cols: number, rows: number): Screen {
    const next = new Screen(cols, rows);
    next.history.push(...this.history);
    const fit = (row: Row): Row => {
      const copy = row.slice(0, cols);
      while (copy.length < cols) copy.push(" ");
      return copy;
    };
    const lines = this.main.map(fit);
    const overflow = Math.max(0, lines.length - rows);
    for (const row of lines.slice(0, overflow))
      next.history.push(row.join("").trimEnd());
    next.main = [
      ...lines.slice(overflow),
      ...Array.from({ length: Math.max(0, rows - lines.length) }, () =>
        blankRow(cols),
      ),
    ];
    if (this.alternate !== undefined) {
      const alternate = this.alternate.map(fit).slice(-rows);
      next.alternate = [
        ...alternate,
        ...Array.from({ length: rows - alternate.length }, () =>
          blankRow(cols),
        ),
      ];
    }
    next.moveTo(Math.max(0, this.y - overflow), this.x);
    return next;
  }

  text(): string {
    const screen = this.lines.map((row) => row.join("").trimEnd());
    return [...this.history, ...screen].join("\n");
  }
}

function numbers(parameters: string): number[] {
  return parameters
    .split(";")
    .map((part) => Math.min(Number.parseInt(part, 10) || 0, MAX_PARAMETER));
}

function csi(screen: Screen, parameters: string, final: string): void {
  const privateMode = parameters.startsWith("?");
  const values = numbers(privateMode ? parameters.slice(1) : parameters);
  const first = values[0] ?? 0;
  const count = Math.max(first, 1);
  if (privateMode) {
    if (final === "h" || final === "l") {
      for (const mode of values) {
        if (mode === 1049 || mode === 1047 || mode === 47)
          screen.useAlternate(final === "h");
      }
    }
    return;
  }
  // 带中间字节的（`CSI > …`、`CSI … $ y` 之类）都与屏幕上的字无关。
  if (/[^\d;]/.test(parameters)) return;
  switch (final) {
    case "A":
      screen.moveBy(-count, 0);
      break;
    case "B":
    case "e":
      screen.moveBy(count, 0);
      break;
    case "C":
    case "a":
      screen.moveBy(0, count);
      break;
    case "D":
      screen.moveBy(0, -count);
      break;
    case "E":
      screen.moveBy(count, 0);
      screen.carriageReturn();
      break;
    case "F":
      screen.moveBy(-count, 0);
      screen.carriageReturn();
      break;
    case "G":
    case "`":
      screen.column(count - 1);
      break;
    case "d":
      screen.row(count - 1);
      break;
    case "H":
    case "f":
      screen.moveTo(count - 1, Math.max(values[1] ?? 1, 1) - 1);
      break;
    case "J":
      screen.eraseInDisplay(first);
      break;
    case "K":
      screen.eraseInLine(first);
      break;
    case "X":
      screen.eraseCharacters(count);
      break;
    case "P":
      screen.deleteCharacters(count);
      break;
    case "@":
      screen.insertBlanks(count);
      break;
    case "L":
      screen.insertLines(count);
      break;
    case "M":
      screen.deleteLines(count);
      break;
    case "S":
      screen.scrollUp(count);
      break;
    case "T":
      screen.scrollDown(count);
      break;
    case "r": {
      const top = Math.max(values[0] ?? 1, 1) - 1;
      const bottom = values[1] ? values[1] - 1 : Number.MAX_SAFE_INTEGER;
      screen.region(top, bottom);
      break;
    }
    case "s":
      screen.save();
      break;
    case "u":
      screen.restore();
      break;
    default:
      break;
  }
}

/** 一条没收完的转义序列最多等这么长；再长就当它坏了，扔掉。 */
const MAX_CARRY = 4_096;

/**
 * 一个会话的屏幕：输出一块一块喂进来（转义序列可以断在两块之间），随时读得
 * 出当前的样子。direct 后端每个会话一个，从会话开始喂到结束——回放环只留最
 * 后一段，只画过一次的静态内容（Codex 的输入框）早被动画的重画挤出去了。
 */
export class ReplayScreen {
  private screen: Screen;
  /** 上一块末尾没收完的转义序列。 */
  private carry = "";

  constructor(
    private cols: number,
    private rows: number,
  ) {
    this.screen = new Screen(clampSize(cols), clampSize(rows));
  }

  write(chunk: string): void {
    const text = this.carry + chunk;
    this.carry = "";
    const characters = [...text];
    const screen = this.screen;
    let index = 0;
    while (index < characters.length) {
      const start = index;
      const character = characters[index] as string;
      index += 1;
      switch (character) {
        case "\r":
          screen.carriageReturn();
          continue;
        case "\n":
        case "\u000b":
        case "\u000c":
          screen.lineFeed();
          continue;
        case "\b":
          screen.backspace();
          continue;
        case "\t":
          screen.tab();
          continue;
        case "\u001b":
          break;
        default:
          if ((character.codePointAt(0) ?? 0) >= 0x20 && character !== "\u007f")
            screen.put(character);
          continue;
      }
      const consumed = this.escape(characters, index);
      if (consumed === undefined) {
        // 序列断在这一块的末尾：留到下一块接着读。
        const rest = characters.slice(start).join("");
        this.carry = rest.length <= MAX_CARRY ? rest : "";
        return;
      }
      index = consumed;
    }
  }

  /** 读 `ESC` 之后的一条序列，答读完之后的位置；没收完答 `undefined`。 */
  private escape(characters: string[], from: number): number | undefined {
    const screen = this.screen;
    let index = from;
    const next = characters[index];
    if (next === undefined) return undefined;
    index += 1;
    if (next === "[") {
      let parameters = "";
      while (index < characters.length) {
        const current = characters[index] as string;
        index += 1;
        const code = current.codePointAt(0) ?? 0;
        if (code >= 0x40 && code <= 0x7e) {
          csi(screen, parameters, current);
          return index;
        }
        parameters += current;
      }
      return undefined;
    }
    if (next === "]" || next === "P" || next === "_" || next === "^") {
      // OSC / DCS / APC / PM：一直到 BEL 或 ST。
      while (index < characters.length) {
        const current = characters[index] as string;
        index += 1;
        if (current === "\u0007") return index;
        if (current === "\u001b") {
          if (index >= characters.length) return undefined;
          if (characters[index] === "\\") return index + 1;
        }
      }
      return undefined;
    }
    switch (next) {
      case "7":
        screen.save();
        break;
      case "8":
        screen.restore();
        break;
      case "M":
        screen.reverseIndex();
        break;
      case "D":
        screen.lineFeed();
        break;
      case "E":
        screen.carriageReturn();
        screen.lineFeed();
        break;
      case "c":
        screen.reset();
        break;
      case "(":
      case ")":
      case "*":
      case "+":
      case "#":
        // 字符集与行属性：再吃一个字节。
        return index < characters.length ? index + 1 : undefined;
      default:
        break;
    }
    return index;
  }

  resize(cols: number, rows: number): void {
    if (clampSize(cols) === this.cols && clampSize(rows) === this.rows) return;
    this.cols = clampSize(cols);
    this.rows = clampSize(rows);
    this.screen = this.screen.resized(this.cols, this.rows);
  }

  text(): string {
    return this.screen.text();
  }
}

function clampSize(value: number): number {
  return Math.min(Math.max(2, Math.trunc(value) || 2), 1_000);
}

/**
 * 把一段 PTY 输出放到一块 `cols × rows` 的屏幕上，答滚出去的历史加当前这一
 * 屏的文本（行尾空白去掉）。
 */
export function renderScreen(text: string, cols: number, rows: number): string {
  const screen = new ReplayScreen(cols, rows);
  screen.write(text);
  return screen.text();
}
