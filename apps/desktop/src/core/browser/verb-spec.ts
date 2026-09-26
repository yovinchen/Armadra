/**
 * 浏览器动词的唯一清单：动词名、参数、一句话说明，全在这里。
 *
 * 四个地方读它，谁都不许再抄一份：
 *
 *   * `armadra-hook --help` 的浏览器段由它生成（`cli/armadra-hook/usage.ts`）；
 *   * 技能正文的浏览器动词表由它生成（`core/collab/skill.ts`）；
 *   * core 的动词白名单 `VERBS`、桌面壳 drive 通道的 `DRIVE_VERBS` 都从它派生；
 *   * `verb-spec.test.ts` 逐条核对：清单里写的每个参数，`shellArgs` 真的转发；
 *     清单里点名的每个错误码、每个按键，实现里真的有。
 *
 * 以前 help 是一段手写文字，与实现对不上八处（ref 的格式、两个不存在的错误码、
 * 没实现的两种读法、白名单外的按键、没转发的三个参数、一个落进 goto 分支的
 * `stop`、往下滚的「向左」）。清单与实现同源之后，这种漂移是一条失败的测试。
 *
 * 这个文件不 import 任何东西：hook 客户端是单独打包的小程序，引它不该把 core
 * 的依赖一起拖进去。
 */

/** 一个参数。`value` 是 help 里写在参数后面的占位符；没有就是开关。 */
export interface BrowserFlagSpec {
  readonly name: string;
  readonly value?: string;
  /** 可以重复给多次（`--field a=1 --field b=2`）。 */
  readonly repeat?: boolean;
  readonly help: string;
  readonly helpZh: string;
  /**
   * 一致性测试用的样例值：传进 `shellArgs` 之后，转发出去的参数必须与不传时
   * 不同。缺省时开关用 `true`，带值的用 `"7"`。
   */
  readonly sample?: string | boolean;
  /** 由 core 自己消费、不进 drive 通道的参数（`--node` 选节点）。 */
  readonly coreOnly?: boolean;
}

/** 一个动词。 */
export interface BrowserVerbSpec {
  readonly name: string;
  /** help 里那一行的写法，不含动词名本身。 */
  readonly synopsis: string;
  readonly help: string;
  readonly helpZh: string;
  readonly flags: readonly BrowserFlagSpec[];
  /**
   * 是否取控制租约：`always` 总取；`never` 是读，人正在操作时也能用；
   * `flag` 视参数而定（`tabs --switch`、`download --accept`）。
   */
  readonly lease: "always" | "never" | "flag";
  /** 会改页面的动作，接受 `--snapshot` 顺带回一份差异快照。 */
  readonly changesPage: boolean;
  /** 接受定位参数（`--ref` / `--role --name` / `--selector` / `--x --y`）。 */
  readonly targets: boolean;
}

/** 定位一个元素的四种说法。 */
export const TARGET_FLAGS: readonly BrowserFlagSpec[] = [
  {
    name: "ref",
    value: "REF",
    help: "a ref from `read` (e12)",
    helpZh: "`read` 给出的引用（e12）",
    sample: "e3",
  },
  {
    name: "role",
    value: "ROLE",
    help: "semantic locator: an accessibility role (button, link, textbox…)",
    helpZh: "语义定位：无障碍角色（button、link、textbox……）",
    sample: "button",
  },
  {
    name: "name",
    value: "TEXT",
    help: "with --role: the accessible name; exact first, then substring",
    helpZh: "配合 --role：无障碍名称，先精确匹配再按包含匹配",
    sample: "提交",
  },
  {
    name: "selector",
    value: "CSS",
    help: "a CSS selector in the main frame",
    helpZh: "主框架里的 CSS 选择器",
    sample: "#go",
  },
  {
    name: "x",
    value: "N",
    help: "with --y: a point in the visible page",
    helpZh: "配合 --y：可见区域里的一个点",
    sample: "5",
  },
  {
    name: "y",
    value: "N",
    help: "with --x",
    helpZh: "配合 --x",
    sample: "5",
  },
];

/** 每个动词都认的参数。 */
export const COMMON_FLAGS: readonly BrowserFlagSpec[] = [
  {
    name: "node",
    value: "ID|TITLE",
    help: "which linked browser node (defaults to the only one)",
    helpZh: "操作哪个连着的浏览器节点（只连了一个时可省）",
    coreOnly: true,
  },
  {
    name: "tab",
    value: "ID",
    help: "which tab (ids from `tabs`); defaults to the active one",
    helpZh: "操作哪个标签页（编号见 `tabs`），缺省是当前标签页",
    sample: "t2",
  },
  {
    name: "snapshot",
    help: "after a page-changing verb, append what changed on the page",
    helpZh: "改页面的动作之后顺带回一份差异快照，省一次 read",
  },
];

const flag = (
  name: string,
  help: string,
  helpZh: string,
  extra: Partial<BrowserFlagSpec> = {},
): BrowserFlagSpec => ({ name, help, helpZh, ...extra });

/** 全部动词，按一个 Agent 通常用到的顺序。 */
export const BROWSER_VERB_SPECS: readonly BrowserVerbSpec[] = [
  {
    name: "navigate",
    synopsis: "--url URL | --action back|forward|reload|stop",
    help: "open an address, or walk/reload/stop the current tab",
    helpZh: "打开一个地址，或者后退、前进、刷新、停止加载",
    lease: "always",
    changesPage: true,
    targets: false,
    flags: [
      flag("url", "http(s) address", "http(s) 地址", {
        value: "URL",
        sample: "https://example.com/",
      }),
      flag(
        "action",
        "back, forward, reload or stop instead of opening",
        "back / forward / reload / stop，代替打开地址",
        { value: "ACTION", sample: "stop" },
      ),
    ],
  },
  {
    name: "back",
    synopsis: "",
    help: "go back in the current tab's history",
    helpZh: "当前标签页后退一步",
    lease: "always",
    changesPage: true,
    targets: false,
    flags: [],
  },
  {
    name: "forward",
    synopsis: "",
    help: "go forward in the current tab's history",
    helpZh: "当前标签页前进一步",
    lease: "always",
    changesPage: true,
    targets: false,
    flags: [],
  },
  {
    name: "read",
    synopsis:
      "[--mode snapshot|text|links|title|console|network] [--interactive] [--depth N] [--max-bytes N] [--limit N]",
    help: "read the page; snapshot (default) is the accessibility tree with refs, iframes included",
    helpZh:
      "读页面；snapshot（缺省）是带引用的无障碍树，含同源与跨源 iframe；console 是控制台，network 是请求元数据",
    lease: "never",
    changesPage: false,
    targets: false,
    flags: [
      flag(
        "mode",
        "snapshot (default), text, links, title, console, network; elements = snapshot --interactive",
        "snapshot（缺省）、text、links、title、console、network；elements 等于 snapshot --interactive",
        { value: "MODE", sample: "text" },
      ),
      flag(
        "interactive",
        "snapshot: only what can be clicked or typed into",
        "snapshot：只列可交互的元素",
      ),
      flag("depth", "snapshot: stop N levels deep", "snapshot：只展开 N 层", {
        value: "N",
      }),
      flag(
        "max-bytes",
        "cap the answer (snapshot 16 KB, text 24 KB by default)",
        "回答的字节上限（snapshot 缺省 16 KB，text 缺省 24 KB）",
        { value: "N", sample: "2048" },
      ),
      flag(
        "limit",
        "links / console / network: newest N entries (-n works too)",
        "links / console / network：最近 N 条（也可写 -n）",
        { value: "N" },
      ),
      flag(
        "level",
        "console: error, warning, info, log or debug and above",
        "console：只看这一级及以上（error / warning / info / log / debug）",
        { value: "LEVEL", sample: "error" },
      ),
      flag(
        "filter",
        "console / network: only entries containing TEXT",
        "console / network：只看含 TEXT 的条目",
        { value: "TEXT", sample: "api" },
      ),
      flag(
        "failed",
        "network: only failed requests and 4xx/5xx",
        "network：只看失败与 4xx/5xx",
      ),
      flag(
        "type",
        "network: resource type (document, xhr, fetch, script…)",
        "network：资源类型（document、xhr、fetch、script……）",
        { value: "TYPE", sample: "fetch" },
      ),
      flag(
        "clear",
        "console / network: empty the buffer after reading",
        "console / network：读完清空缓冲",
      ),
    ],
  },
  {
    name: "click",
    synopsis: "<target> [--double]",
    help: "click an element",
    helpZh: "点击一个元素",
    lease: "always",
    changesPage: true,
    targets: true,
    flags: [flag("double", "double-click", "双击")],
  },
  {
    name: "hover",
    synopsis: "<target>",
    help: "move the pointer over an element (menus, tooltips)",
    helpZh: "把指针移到元素上（展开菜单、提示）",
    lease: "always",
    changesPage: true,
    targets: true,
    flags: [],
  },
  {
    name: "drag",
    synopsis: "--from REF|CSS --to REF|CSS",
    help: "press on one element, move, release on another",
    helpZh: "在一个元素上按下、拖到另一个元素上松开",
    lease: "always",
    changesPage: true,
    targets: false,
    flags: [
      flag(
        "from",
        "where the drag starts: a ref or a CSS selector",
        "拖动起点：引用或 CSS 选择器",
        {
          value: "REF|CSS",
          sample: "e1",
        },
      ),
      flag(
        "to",
        "where it ends: a ref or a CSS selector",
        "拖动终点：引用或 CSS 选择器",
        {
          value: "REF|CSS",
          sample: "e2",
        },
      ),
    ],
  },
  {
    name: "type",
    synopsis: "[<target>] --text TEXT [--replace] [--submit]",
    help: "type into a field (the focused one when no target is given)",
    helpZh: "往输入框里打字（不给目标就打进当前焦点）",
    lease: "always",
    changesPage: true,
    targets: true,
    flags: [
      flag("text", "what to type", "要输入的文字", {
        value: "TEXT",
        sample: "你好",
      }),
      flag("replace", "clear the field first", "先清空再输入"),
      flag("submit", "press Enter afterwards", "输完按回车"),
    ],
  },
  {
    name: "fill",
    synopsis: "--field REF=VALUE [--field REF=VALUE]...",
    help: "fill a form in one call: text fields, checkboxes (true/false), dropdowns",
    helpZh:
      "一次填多个表单项：文本框填文字，复选框与单选填 true/false，下拉填选项",
    lease: "always",
    changesPage: true,
    targets: false,
    flags: [
      flag("field", "one ref and its value", "一个引用和它的值", {
        value: "REF=VALUE",
        repeat: true,
        sample: "e3=x",
      }),
    ],
  },
  {
    name: "select",
    synopsis: "<target> --value V | --label L",
    help: "choose an option in a native dropdown, a combobox or a listbox",
    helpZh: "在原生下拉、combobox 或 listbox 里选一个选项",
    lease: "always",
    changesPage: true,
    targets: true,
    flags: [
      flag("value", "option value", "选项的值", {
        value: "V",
        repeat: true,
        sample: "b",
      }),
      flag("label", "option text", "选项的文字", {
        value: "L",
        repeat: true,
        sample: "Blue",
      }),
    ],
  },
  {
    name: "press",
    synopsis: "--key KEY [--repeat N]",
    help: "press a key or a chord: Enter, Tab, Escape, arrows, F1-F12, Control+a, Meta+Shift+z",
    helpZh:
      "按键或组合键：Enter、Tab、Escape、方向键、F1–F12、Control+a、Meta+Shift+z；文字用 type",
    lease: "always",
    changesPage: true,
    targets: false,
    flags: [
      flag("key", "the key or chord", "按键或组合键", {
        value: "KEY",
        sample: "Enter",
      }),
      flag("repeat", "press it N times", "连按 N 次", { value: "N" }),
      flag(
        "modifiers",
        "extra modifiers: ctrl,shift,alt,meta",
        "额外的修饰键：ctrl,shift,alt,meta",
        { value: "LIST", sample: "shift" },
      ),
    ],
  },
  {
    name: "scroll",
    synopsis:
      "--direction up|down|left|right|top|bottom [--amount PX] | <target>",
    help: "scroll the page, or bring an element into view",
    helpZh: "滚动页面，或把一个元素滚进可视区域",
    lease: "always",
    changesPage: true,
    targets: true,
    flags: [
      flag(
        "direction",
        "up, down, left, right, top or bottom",
        "up / down / left / right / top / bottom",
        { value: "DIR", sample: "left" },
      ),
      flag(
        "amount",
        "pixels (default: most of a screen)",
        "像素（缺省约一屏）",
        {
          value: "PX",
        },
      ),
      flag("to-ref", "same as --ref", "同 --ref", {
        value: "REF",
        sample: "e4",
      }),
    ],
  },
  {
    name: "wait",
    synopsis:
      "--text T | --text-gone T | --idle | --selector CSS | --url-contains T | --title-contains T [--timeout MS]",
    help: "wait for text, its absence, network idle, an element, or an address",
    helpZh: "等文字出现或消失、网络空闲、元素出现、地址或标题变化",
    lease: "never",
    changesPage: false,
    targets: false,
    flags: [
      flag(
        "text",
        "text that must appear (iframes too)",
        "要出现的文字（含 iframe）",
        {
          value: "TEXT",
          sample: "完成",
        },
      ),
      flag("text-gone", "text that must disappear", "要消失的文字", {
        value: "TEXT",
        sample: "加载中",
      }),
      flag(
        "idle",
        "no request in flight for 500 ms",
        "网络空闲：500 ms 内没有进行中的请求",
      ),
      flag("selector", "an element that must be visible", "要可见的元素", {
        value: "CSS",
        sample: "#done",
      }),
      flag("url-contains", "part of the address", "地址里要包含的片段", {
        value: "TEXT",
        sample: "/done",
      }),
      flag("title-contains", "part of the title", "标题里要包含的片段", {
        value: "TEXT",
        sample: "Done",
      }),
      flag(
        "timeout",
        "give up after MS (default 15000, max 30000)",
        "最多等 MS 毫秒（缺省 15000，上限 30000）",
        {
          value: "MS",
        },
      ),
    ],
  },
  {
    name: "capture",
    synopsis: "[<target>] [--full-page] [--format png|jpeg] [--path REL]",
    help: "save a screenshot (of an element with a target) into the workspace",
    helpZh: "截图存进工作区；给了目标就只截那个元素",
    lease: "never",
    changesPage: false,
    targets: true,
    flags: [
      flag(
        "full-page",
        "the whole page, not just the visible part",
        "整页，而不只是可见部分",
      ),
      flag("format", "png (default) or jpeg", "png（缺省）或 jpeg", {
        value: "FMT",
        sample: "jpeg",
      }),
      flag(
        "path",
        "workspace-relative file (default .armadra/browser/<time>.png)",
        "工作区内的相对路径（缺省 .armadra/browser/<时间>.png）",
        { value: "REL", sample: "shot.png" },
      ),
    ],
  },
  {
    name: "pdf",
    synopsis: "[--path REL] [--landscape]",
    help: "print the page to a PDF in the workspace",
    helpZh: "把页面打印成 PDF 存进工作区",
    lease: "never",
    changesPage: false,
    targets: false,
    flags: [
      flag(
        "path",
        "workspace-relative file (default .armadra/browser/<time>.pdf)",
        "工作区内的相对路径（缺省 .armadra/browser/<时间>.pdf）",
        { value: "REL", sample: "page.pdf" },
      ),
      flag("landscape", "landscape pages", "横向"),
    ],
  },
  {
    name: "resize",
    synopsis: "--width N --height N | --reset",
    help: "lay the page out at another viewport size",
    helpZh: "按另一个视口尺寸排版页面",
    lease: "always",
    changesPage: true,
    targets: false,
    flags: [
      flag("width", "CSS pixels, 200-3840", "CSS 像素，200–3840", {
        value: "N",
        sample: "800",
      }),
      flag("height", "CSS pixels, 200-2160", "CSS 像素，200–2160", {
        value: "N",
        sample: "600",
      }),
      flag("reset", "back to the node's own size", "恢复节点本来的尺寸"),
    ],
  },
  {
    name: "upload",
    synopsis: "--path REL [--path REL]... [<target>]",
    help: "answer a file chooser with workspace files",
    helpZh: "用工作区里的文件回答文件选择框",
    lease: "always",
    changesPage: true,
    targets: true,
    flags: [
      flag("path", "workspace-relative file", "工作区内的相对路径", {
        value: "REL",
        repeat: true,
        sample: "a.txt",
      }),
    ],
  },
  {
    name: "download",
    synopsis: "[--id ID --accept | --id ID --reject]",
    help: "list staged downloads, or save / discard one",
    helpZh: "列出暂存的下载，或把一个存进工作区 / 丢弃",
    lease: "flag",
    changesPage: false,
    targets: false,
    flags: [
      flag("id", "which download", "哪一个下载", { value: "ID", sample: "d1" }),
      flag("accept", "save it into the workspace", "存进工作区"),
      flag("reject", "discard it", "丢弃", { coreOnly: true }),
    ],
  },
  {
    name: "tabs",
    synopsis: "[--switch ID | --new URL]",
    help: "list tabs, switch to one or open one",
    helpZh: "列出标签页、切换或新开一个",
    lease: "flag",
    changesPage: false,
    targets: false,
    flags: [
      flag("switch", "make that tab active", "切到这个标签页", {
        value: "ID",
        sample: "t2",
      }),
      flag("new", "open a tab at URL", "新开一个标签页", {
        value: "URL",
        sample: "https://example.com/",
      }),
    ],
  },
  {
    name: "close",
    synopsis: "--tab ID",
    help: "close one tab, never the last",
    helpZh: "关一个标签页，最后一个不关",
    lease: "always",
    changesPage: false,
    targets: false,
    flags: [],
  },
  {
    name: "dialog",
    synopsis: "--accept | --dismiss [--text TEXT]",
    help: "answer an alert / confirm / prompt",
    helpZh: "回答 alert / confirm / prompt",
    lease: "always",
    changesPage: true,
    targets: false,
    flags: [
      flag("accept", "press OK", "确定", { sample: true }),
      flag("dismiss", "press Cancel", "取消", { coreOnly: true }),
      flag("text", "prompt answer", "prompt 的回答", {
        value: "TEXT",
        sample: "好",
      }),
      flag("id", "the dialog id, when you have one", "对话框编号（有的话）", {
        value: "ID",
        sample: "dialog-1",
      }),
    ],
  },
  {
    name: "lease",
    synopsis: "[--status | --release]",
    help: "who is driving; give yours back",
    helpZh: "谁在操作；交还自己的租约",
    lease: "never",
    changesPage: false,
    targets: false,
    flags: [
      flag("status", "show who holds it (the default)", "看谁持有（缺省）", {
        coreOnly: true,
      }),
      flag("release", "give it back", "交还", { coreOnly: true }),
    ],
  },
];

/**
 * 错误码。help 与技能正文点名的码都在这里，一致性测试核对它们在实现里存在。
 * 浏览器自己的码见 `cdp/codes.ts` 的 `DRIVE_CODES`，租约的四个码见
 * `core/drive/lease.ts`。
 */
export const DOCUMENTED_CODES: readonly string[] = [
  "browser_stale_ref",
  "browser_not_found",
  "browser_refused",
  "browser_dialog_pending",
  "browser_timeout",
  "LEASE_HELD_BY_HUMAN",
  "LEASE_REVOKED",
];

/** help 与技能正文共用的几条规矩，英文一份、中文一份。 */
export const BROWSER_NOTES: readonly string[] = [
  "Refs look like e12 and come from `read` (snapshot is the default mode). An element keeps its ref while the page stays; a ref that no longer resolves is looked up again once by role and name, and refused with browser_stale_ref when that is not exactly one element.",
  "Iframes, same-origin and cross-origin, are part of the snapshot; their refs work like any other.",
  "Text fields report filled or empty, never their contents. `upload --path`, `capture --path` and `pdf --path` only take workspace-relative paths.",
  "While a page shows a dialog, other verbs answer browser_dialog_pending with its text; `dialog` clears it, `read --mode console|network` still works.",
  "Anything that drives the page takes the control lease. A person mid-typing makes it wait briefly and then answers LEASE_HELD_BY_HUMAN; a person who took the browser over makes it answer LEASE_REVOKED at once — do not retry either, read `lease --status` and say so.",
];

export const BROWSER_NOTES_ZH: readonly string[] = [
  "引用形如 e12，来自 `read`（缺省是 snapshot）。页面不换，元素的引用就不变；引用找不到元素时按角色与名称重找一次，找到的不是恰好一个就拒绝（browser_stale_ref）。",
  "同源与跨源 iframe 都在快照里，里面的引用和别的一样用。",
  "文本框只说已填或空，从不给内容。`upload`、`capture`、`pdf` 的 --path 只收工作区内的相对路径。",
  "页面弹着对话框时，其余动词回 browser_dialog_pending 并带上对话框文字；用 `dialog` 处理，`read --mode console|network` 照常可用。",
  "驱动页面的动作都取控制租约。人正在打字时稍等后回 LEASE_HELD_BY_HUMAN；人按了接管则立刻回 LEASE_REVOKED——两种都不要重试，读 `lease --status` 并如实说明。",
];

/** 动词名，按清单顺序。 */
export const VERB_NAMES: readonly string[] = BROWSER_VERB_SPECS.map(
  (spec) => spec.name,
);

export function verbSpec(name: string): BrowserVerbSpec | undefined {
  return BROWSER_VERB_SPECS.find((spec) => spec.name === name);
}

/** 一个动词认的全部参数：自己的、定位的（如果接受）、公共的。 */
export function flagsOf(spec: BrowserVerbSpec): readonly BrowserFlagSpec[] {
  return [
    ...spec.flags,
    ...(spec.targets ? TARGET_FLAGS : []),
    ...COMMON_FLAGS.filter(
      (each) => each.name !== "snapshot" || spec.changesPage,
    ),
  ];
}

/** The flags a verb's synopsis line does not already spell out. */
function unlisted(spec: BrowserVerbSpec): BrowserFlagSpec[] {
  return spec.flags.filter(
    (each) =>
      !spec.synopsis.includes(`--${each.name}`) && each.coreOnly !== true,
  );
}

/**
 * `armadra-hook --help` 的浏览器段。英文，与其余 help 一致；中文说明给技能
 * 正文用。
 */
export function browserUsage(): string {
  const rows = BROWSER_VERB_SPECS.map((spec) => {
    const head = `  ${spec.name}${spec.synopsis === "" ? "" : ` ${spec.synopsis}`}`;
    const extra = unlisted(spec).map(
      (each) =>
        `      --${each.name}${each.value === undefined ? "" : ` ${each.value}`}: ${each.help}`,
    );
    return [head, `      ${spec.help}`, ...extra].join("\n");
  });
  const target =
    "  <target> is one of: --ref REF | --role ROLE [--name TEXT] | --selector CSS | --x N --y N";
  const common = COMMON_FLAGS.map(
    (each) =>
      `  --${each.name}${each.value === undefined ? "" : ` ${each.value}`}`.padEnd(
        26,
      ) + each.help,
  );
  const notes = BROWSER_NOTES.map((line) => wrap(line, 76, "  "));
  return [
    "BROWSER VERBS (the browser node linked to this one):",
    ...rows,
    "",
    "BROWSER OPTIONS:",
    target,
    ...common,
    ...notes,
  ].join("\n");
}

function wrap(text: string, width: number, indent: string): string {
  const words = text.split(" ");
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (line !== "" && line.length + 1 + word.length > width) {
      lines.push(indent + line);
      line = word;
    } else {
      line = line === "" ? word : `${line} ${word}`;
    }
  }
  if (line !== "") lines.push(indent + line);
  return lines.join("\n");
}
