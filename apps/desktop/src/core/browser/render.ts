import { Args } from "../collab/refusals";
import type { ArgSource } from "./args";
import type { Lease } from "./model";

/**
 * A few lines back, in prose, because the reader is a model reading its own
 * stdout — and every line is a line in its context window.
 *
 * Three rules run through every line here, and they are the reason this is a
 * module and not a template string at each call site:
 *
 *   * **re-measured, not echoed.** A scroll reports the distance the page
 *     actually moved. A click reports the address afterwards. An answer that
 *     repeats the request cannot tell the reader the page ignored them.
 *   * **counts, not contents.** `type` says how many characters went in; the
 *     snapshot says whether a field is filled. Neither ever says what.
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
  return title === "" ? "（无标题）" : title;
}

function where(value: Result): string {
  const url = text(value, "url");
  return url === "" ? "" : `地址：${url}\n`;
}

function bytes(count: number): string {
  if (count < 1024) return `${count} B`;
  if (count < 1024 * 1024) return `${(count / 1024).toFixed(1)} KB`;
  return `${(count / 1024 / 1024).toFixed(1)} MB`;
}

/** What the verb aimed at, and whether its ref had to be found again. */
function aimed(result: Result): string {
  const target = text(result, "target");
  const note = text(result, "note");
  return `${target === "" ? "" : ` ${target}`}${note === "" ? "" : `（${note}）`}`;
}

/** The answer for one verb. */
export function render(verb: string, source: ArgSource, raw: unknown): string {
  const result = asObject(raw);
  // The action made the page open an alert / confirm / prompt. The page
  // answers nothing else until it is handled, and the next verb would be
  // refused with browser_dialog_pending — say so now instead.
  const dialog =
    result.dialog === true
      ? "页面弹出了对话框，其余动作会被拒绝；先用 dialog --accept 或 --dismiss 处理。\n"
      : "";
  return body(verb, source, result) + dialog + snapshotTail(result);
}

function body(verb: string, source: ArgSource, result: Result): string {
  switch (verb) {
    case "navigate":
    case "back":
    case "forward":
      return `${result.stopped === true ? "已停止加载" : "已导航"}。\n${where(result)}标题：${titled(result)}\n`;
    case "read":
      return readLines(result);
    case "click":
      return `已点击${aimed(result)}。\n${where(result)}`;
    case "hover":
      return `指针已移到${aimed(result)}上。\n`;
    case "drag":
      return `已把 ${text(result, "from")} 拖到 ${text(result, "to")}。\n${where(result)}`;
    case "type":
      return `已输入 ${number(result, "chars")} 个字符${aimed(result)}。\n${where(result)}`;
    case "fill": {
      const fields = array(result, "fields");
      let out = `已填写 ${fields.length} 项：\n`;
      for (const field of fields) {
        out += `  ${text(field, "ref")} ${text(field, "outcome")}\n`;
      }
      return out;
    }
    case "press":
      return `已按下 ${text(result, "key")} ${number(result, "times")} 次。\n${where(result)}`;
    case "select":
      return `已选中：${strings(result, "chosen").join("、")}${aimed(result) === "" ? "" : `（${text(result, "target")}）`}\n`;
    case "scroll": {
      // The MEASURED displacement. A page that refused to move says zero here,
      // which is the fact the caller needs; the requested amount is not.
      const sideways = number(result, "movedX");
      const head =
        text(result, "target") === ""
          ? `已滚动 ${number(result, "moved")} px`
          : `已把${aimed(result)}滚进可视区域，页面滚动 ${number(result, "moved")} px`;
      return `${head}${sideways === 0 ? "" : `，横向 ${sideways} px`}（当前 ${number(result, "position")}/${number(result, "extent")}）。\n`;
    }
    case "wait": {
      const busy =
        typeof result.inFlight === "number" && result.inFlight > 0
          ? `，仍有 ${number(result, "inFlight")} 个请求未完成`
          : "";
      return result.matched === true
        ? `条件在 ${number(result, "waitedMs")} ms 内满足。\n`
        : `等待超时（${number(result, "waitedMs")} ms），条件没有满足${busy}。页面没有被改动。\n`;
    }
    case "capture": {
      const element = text(result, "element");
      return `截图已保存到工作区：${text(result, "path")}${element === "" ? "" : `（${element}）`}\n${number(result, "width")}×${number(result, "height")}，${number(result, "bytes")} 字节，sha256 ${text(result, "sha256")}\n`;
    }
    case "pdf":
      return `PDF 已保存到工作区：${text(result, "path")}\n${number(result, "pages")} 页，${number(result, "bytes")} 字节，sha256 ${text(result, "sha256")}\n`;
    case "resize":
      return result.reset === true
        ? `视口已恢复，现在 ${number(result, "width")}×${number(result, "height")}。\n`
        : `视口现在 ${number(result, "width")}×${number(result, "height")}。\n`;
    case "upload":
      return `已${result.answeredChooser === true ? "回填页面打开的文件选择框" : "填入文件输入框"}：${strings(result, "paths").join("、")}\n`;
    case "download":
      return downloadLines(source, result);
    case "tabs":
    case "close":
      return tabLines(result);
    case "dialog":
      return `已${result.accepted === true ? "确定" : "取消"}对话框（${text(result, "kind")}）：${text(result, "message")}\n`;
    default:
      return `${JSON.stringify(result)}\n`;
  }
}

/** `--snapshot`: the page after the action, or what the action changed. */
function snapshotTail(result: Result): string {
  const snapshot = asObject(result.snapshot);
  const kind = text(snapshot, "kind");
  if (kind === "") return "";
  const cut = snapshot.truncated === true ? "…（已截断）\n" : "";
  if (kind === "full") {
    const lines = strings(snapshot, "lines");
    return `\n页面快照：\n${lines.join("\n")}${lines.length === 0 ? "" : "\n"}${cut}`;
  }
  const added = strings(snapshot, "added");
  const removed = strings(snapshot, "removed");
  if (added.length === 0 && removed.length === 0)
    return "\n页面快照没有变化。\n";
  let out = "\n页面变化：\n";
  for (const line of added) out += `+ ${line.replace(/^- /, "")}\n`;
  for (const line of removed) out += `- ${line.replace(/^- /, "")}\n`;
  return out + cut;
}

function readLines(result: Result): string {
  switch (text(result, "mode")) {
    case "title":
      return `标题：${titled(result)}\n${where(result)}`;
    case "links": {
      let out = where(result);
      for (const link of array(result, "links")) {
        out += `${text(link, "name")} → ${text(link, "href")}\n`;
      }
      return out;
    }
    case "snapshot":
      return snapshotLines(result);
    case "console":
      return consoleLines(result);
    case "network":
      return networkLines(result);
    default: {
      const content = text(result, "text");
      const tail = result.truncated === true ? "\n…（已截断）\n" : "\n";
      return `${where(result)}标题：${titled(result)}\n\n${content}${tail}`;
    }
  }
}

function snapshotLines(result: Result): string {
  const lines = strings(result, "lines");
  let out = `页面：${titled(result)} — ${text(result, "url")}\n`;
  if (lines.length === 0) {
    out +=
      result.interactive === true
        ? "（没有可交互的元素）\n"
        : "（页面是空的）\n";
  } else {
    out += `${lines.join("\n")}\n`;
  }
  const omitted = number(result, "omitted");
  if (result.truncated === true) {
    out += `…（已截断，另有 ${omitted} 项未显示；用 --interactive、--depth 或 --max-bytes 调整）\n`;
  } else if (omitted > 0) {
    out += `…（--depth 之下另有 ${omitted} 项未展开）\n`;
  }
  return out;
}

function consoleLines(result: Result): string {
  const entries = array(result, "entries");
  const total = number(result, "total");
  if (entries.length === 0) return "控制台没有符合条件的记录。\n";
  let out =
    total > entries.length
      ? `控制台：共 ${total} 条，下面是最近 ${entries.length} 条\n`
      : `控制台：${total} 条\n`;
  for (const entry of entries) {
    const at = text(entry, "where");
    const frame = text(entry, "frame") === "iframe" ? " [iframe]" : "";
    const origin = text(entry, "source");
    const tag = origin === "console" ? "" : ` ${origin}`;
    out += `[${text(entry, "level")}${tag}]${frame} ${text(entry, "text")}${at === "" ? "" : `  (${at})`}\n`;
  }
  return out;
}

function networkLines(result: Result): string {
  const entries = array(result, "entries");
  const total = number(result, "total");
  const inFlight = number(result, "inFlight");
  if (entries.length === 0)
    return `没有符合条件的请求${inFlight > 0 ? `（进行中 ${inFlight} 个）` : ""}。\n`;
  let out = `请求：共 ${total} 条${inFlight > 0 ? `，进行中 ${inFlight} 个` : ""}${total > entries.length ? `，下面是最近 ${entries.length} 条` : ""}\n`;
  for (const entry of entries) {
    const failure = text(entry, "failure");
    const status =
      failure !== ""
        ? `失败(${failure})`
        : entry.done === true || number(entry, "status") > 0
          ? String(number(entry, "status"))
          : "进行中";
    const size =
      entry.done === true && failure === ""
        ? ` ${bytes(number(entry, "bytes"))}`
        : "";
    const time =
      entry.done === true ? ` ${number(entry, "durationMs")} ms` : "";
    const cache = entry.fromCache === true ? " 缓存" : "";
    const frame = text(entry, "frame") === "iframe" ? " [iframe]" : "";
    out += `${text(entry, "method")} ${status} ${text(entry, "type").toLowerCase()}${size}${time}${cache}${frame} ${text(entry, "url")}\n`;
  }
  return out;
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
  return out === "" ? "这个浏览器节点现在没有标签页。\n" : out;
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
