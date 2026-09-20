import { Args } from "../collab/refusals";
import type { ArgSource } from "./args";
import type { Lease } from "./model";

/**
 * One line back, in prose, because the reader is a model reading its own
 * stdout.
 *
 * Ported from the pre-merge implementation.
 * Three rules run through every line here, and they are the reason this is a
 * module and not a template string at each call site:
 *
 *   * **re-measured, not echoed.** A scroll reports the distance the page
 *     actually moved. A click reports the address afterwards. An answer that
 *     repeats the request cannot tell the reader the page ignored them.
 *   * **counts, not contents.** `type` says how many characters went in.
 *     `read --map` says whether a field is filled. Neither ever says what.
 *   * **no coordinates.** Where an element happens to sit is a fact about this
 *     window at this zoom, and repeating it invites an agent to aim at a
 *     number instead of at a ref.
 */

type Result = Record<string, unknown>;

function asObject(value: unknown): Result {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Result)
    : {};
}

function text(value: Result, field: string): string {
  const found = value[field];
  return typeof found === "string" ? found : "";
}

function number(value: Result, field: string): number {
  const found = value[field];
  if (typeof found === "number" && Number.isFinite(found)) {
    return Math.trunc(found);
  }
  return 0;
}

function array(value: Result, field: string): Result[] {
  const found = value[field];
  return Array.isArray(found) ? found.map(asObject) : [];
}

function strings(value: Result, field: string): string[] {
  const found = value[field];
  if (!Array.isArray(found)) return [];
  return found.filter((entry): entry is string => typeof entry === "string");
}

function titled(value: Result): string {
  const title = text(value, "title");
  return title === "" ? "（未知）" : title;
}

/** The answer for one verb. */
export function render(verb: string, source: ArgSource, raw: unknown): string {
  const result = asObject(raw);
  switch (verb) {
    case "navigate":
    case "back":
    case "forward":
      return `已导航。\n当前地址：${text(result, "url")}\n标题：${titled(result)}\n导航序号：${number(result, "generation")}\n`;
    case "read":
      return readLines(result);
    case "click":
      return `已点击${described(result)}。\n当前地址：${text(result, "url")}\n导航序号：${number(result, "generation")}\n`;
    case "type":
      return `已输入 ${number(result, "chars")} 个字符。\n当前地址：${text(result, "url")}\n导航序号：${number(result, "generation")}\n`;
    case "press":
      return `已按下 ${text(result, "key")} ${number(result, "times")} 次。\n`;
    case "select":
      return `已选中：${strings(result, "chosen").join("、")}\n`;
    case "scroll":
      // The MEASURED displacement. A page that refused to move says zero here,
      // which is the fact the caller needs; the requested amount is not.
      return `已滚动 ${number(result, "moved")} px（当前 ${number(result, "position")}/${number(result, "extent")}）。\n`;
    case "wait":
      return result.matched === true
        ? `条件在 ${number(result, "waitedMs")} ms 内满足。\n`
        : `等待超时（${number(result, "waitedMs")} ms），条件没有满足。页面没有被改动。\n`;
    case "capture":
      return `截图已保存到工作区：${text(result, "path")}\n${number(result, "width")}×${number(result, "height")}，${number(result, "bytes")} 字节，sha256 ${text(result, "sha256")}\n`;
    case "upload":
      return `已${result.answeredChooser === true ? "回填页面打开的文件选择器" : "填入文件输入框"}：${strings(result, "paths").join("、")}\n`;
    case "download":
      return downloadLines(source, result);
    case "tabs":
    case "close":
      return tabLines(result);
    case "dialog":
      return `已${result.accepted === true ? "接受" : "取消"}对话框（${text(result, "kind")}）：${text(result, "message")}\n`;
    default:
      return `${JSON.stringify(raw)}\n`;
  }
}

function described(result: Result): string {
  const name = text(result, "name");
  const role = text(result, "role");
  if (name === "" && role === "") return "";
  if (name === "") return `（${role}）`;
  return `（${role}「${name}」）`;
}

function readLines(result: Result): string {
  switch (text(result, "mode")) {
    case "title":
      return `标题：${titled(result)}\n地址：${text(result, "url")}\n`;
    case "links": {
      let out = `地址：${text(result, "url")}\n`;
      for (const link of array(result, "links")) {
        out += `${text(link, "name")} → ${text(link, "href")}\n`;
      }
      return out;
    }
    case "map": {
      let out = `地址：${text(result, "url")}\n标题：${titled(result)}\n`;
      for (const element of array(result, "elements")) {
        // `detail` is "filled or not", never what is in it — the filtering
        // that produced it happened inside the shell's frozen reader, where no
        // caller can skip it.
        const detail = text(element, "detail");
        out += `${text(element, "ref")} ${text(element, "role")} 「${text(element, "name")}」${detail === "" ? "" : `（${detail}）`}\n`;
      }
      return out;
    }
    default: {
      const body = text(result, "text");
      const tail = result.truncated === true ? "\n…（已截断）\n" : "\n";
      return `地址：${text(result, "url")}\n标题：${titled(result)}\n\n${body}${tail}`;
    }
  }
}

function downloadLines(source: ArgSource, result: Result): string {
  const queue = result.downloads;
  if (Array.isArray(queue)) {
    if (queue.length === 0) return "下载队列是空的。\n";
    return queue
      .map(asObject)
      .map(
        (entry) =>
          `${text(entry, "id")}  ${text(entry, "suggestedFilename")}  ${number(entry, "bytes")} 字节  ${text(entry, "state")}\n`,
      )
      .join("");
  }
  if (new Args(source).flag("accept")) {
    const sha = text(result, "sha256");
    return `已保存到工作区：${text(result, "path")}\nsha256 ${sha === "" ? "（未知）" : sha}\n`;
  }
  return `已丢弃暂存文件：${text(result, "suggestedFilename")}\n`;
}

function tabLines(result: Result): string {
  const active = text(result, "activeTabId");
  let out = "";
  for (const tab of array(result, "tabs")) {
    const id = text(tab, "id");
    out += `${id === active ? "* " : "  "}${id}  ${text(tab, "title")}  ${text(tab, "url")}\n`;
  }
  return out === "" ? "这个浏览器节点现在没有标签。\n" : out;
}

/**
 * Who is driving, in one line. An agent that has just been refused reads this
 * to say *why* instead of retrying.
 */
export function renderLease(lease: Lease): string {
  let who: string;
  if (lease.state === "free") {
    who = "没有人在操作";
  } else if (lease.holder === undefined) {
    who = "有人在操作";
  } else {
    const name =
      lease.holder.displayName === ""
        ? lease.holder.id
        : lease.holder.displayName;
    who =
      lease.state === "humanTakeover"
        ? `人已接管：${name}`
        : lease.state === "human"
          ? `人正在操作：${name}`
          : `Agent 正在操作：${name}`;
  }
  const until =
    lease.expiresAt === "" ? "，不会自动释放" : `，${lease.expiresAt} 前有效`;
  return `${who}（世代 ${lease.generation}）${until}\n`;
}
