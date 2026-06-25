const THEMES = {
  light: {
    bg: "#F3F4F8",
    panel: "#FFFFFF",
    card: "#FFFFFF",
    card2: "#F5F6FA",
    border: "rgba(25,28,50,.09)",
    text: "#1B1D26",
    muted: "#6B7080",
    faint: "#A0A5B3",
    dot: "rgba(25,28,50,.10)",
    accent: "#5B5BD6",
    accentSoft: "rgba(91,91,214,.12)",
    accentLine: "rgba(91,91,214,.35)",
    ok: "#1F9D64",
    warn: "#D18F0F",
    warnSoft: "rgba(209,143,15,.10)",
    err: "#DC4C4A",
    errSoft: "rgba(220,76,74,.10)",
    info: "#2E7CF6",
    infoSoft: "rgba(46,124,246,.12)",
    diff: "#8A4FD6",
    diffBg: "rgba(138,79,214,.12)",
    shadow: "0 6px 20px rgba(30,30,70,.07)",
    shadowLg: "0 24px 60px rgba(30,30,70,.22)",
    termBg: "#1B1D26",
  },
  dark: {
    bg: "#0E0F12",
    panel: "#15161A",
    card: "#1B1C21",
    card2: "#23252B",
    border: "rgba(255,255,255,.08)",
    text: "#EDEEF2",
    muted: "#9A9FAD",
    faint: "#666B78",
    dot: "rgba(255,255,255,.08)",
    accent: "#7C7CF0",
    accentSoft: "rgba(124,124,240,.18)",
    accentLine: "rgba(124,124,240,.45)",
    ok: "#3FBF7F",
    warn: "#E3B341",
    warnSoft: "rgba(227,179,65,.12)",
    err: "#F0605D",
    errSoft: "rgba(240,96,93,.14)",
    info: "#5B9BF0",
    infoSoft: "rgba(91,155,240,.16)",
    diff: "#C792EA",
    diffBg: "rgba(199,146,234,.16)",
    shadow: "0 10px 28px rgba(0,0,0,.45)",
    shadowLg: "0 30px 70px rgba(0,0,0,.6)",
    termBg: "#0A0B0D",
  },
};
const TYPES = {
  task: {
    name: "Task",
    cn: "任务",
    icon: "☰",
    color: "#2E7CF6",
    bg: "rgba(46,124,246,.14)",
    desc: "目标与验收标准",
    size: [280, 250],
  },
  agent: {
    name: "Agent",
    cn: "Agent",
    icon: "✦",
    color: "#5B5BD6",
    bg: "rgba(91,91,214,.14)",
    desc: "ACP 代理会话",
    size: [430, 600],
  },
  terminal: {
    name: "Terminal",
    cn: "终端",
    icon: ">_",
    color: "#1F9D64",
    bg: "rgba(31,157,100,.14)",
    desc: "真实 Shell 会话",
    size: [480, 280],
  },
  diff: {
    name: "Diff",
    cn: "变更",
    icon: "±",
    color: "#8A4FD6",
    bg: "rgba(138,79,214,.14)",
    desc: "代码变更审阅",
    size: [400, 420],
  },
  file: {
    name: "File",
    cn: "文件",
    icon: "▤",
    color: "#D18F0F",
    bg: "rgba(209,143,15,.14)",
    desc: "Workspace 文件",
    size: [300, 230],
  },
  context: {
    name: "Context",
    cn: "上下文",
    icon: "◫",
    color: "#0E9AA7",
    bg: "rgba(14,154,167,.14)",
    desc: "文件夹引用",
    size: [280, 150],
  },
  log: {
    name: "Log",
    cn: "日志",
    icon: "≡",
    color: "#6B7080",
    bg: "rgba(107,112,128,.14)",
    desc: "运行记录",
    size: [360, 220],
  },
  attachment: {
    name: "Image",
    cn: "图片",
    icon: "▣",
    color: "#E0762E",
    bg: "rgba(224,118,46,.14)",
    desc: "图片附件",
    size: [260, 200],
  },
  note: {
    name: "Note",
    cn: "便签",
    icon: "▢",
    color: "#B8860B",
    bg: "rgba(184,134,11,.16)",
    desc: "文本片段",
    size: [260, 180],
  },
  browser: {
    name: "Browser",
    cn: "浏览器",
    icon: "◍",
    color: "#0E9AA7",
    bg: "rgba(14,154,167,.14)",
    desc: "嵌入网页",
    size: [520, 380],
  },
};
const PEN_COLORS = ["#5B5BD6", "#DC4C4A", "#1F9D64", "#D18F0F", "#1B1D26"];
const STATUS = {
  running: {
    text: "运行中",
    icon: "◐",
    color: "var(--accent)",
    anim: "spin 1.2s linear infinite",
  },
  waiting: { text: "等待确认", icon: "⏸", color: "var(--warn)", anim: "none" },
  done: { text: "已完成", icon: "✓", color: "var(--ok)", anim: "none" },
  review: { text: "待审阅", icon: "◇", color: "var(--diff)", anim: "none" },
  modified: { text: "已修改", icon: "●", color: "var(--warn)", anim: "none" },
  idle: { text: "空闲", icon: "○", color: "var(--muted)", anim: "none" },
  error: { text: "失败", icon: "✕", color: "var(--err)", anim: "none" },
  disconnected: {
    text: "已断开",
    icon: "⊘",
    color: "var(--err)",
    anim: "none",
  },
  connecting: {
    text: "连接中",
    icon: "◌",
    color: "var(--warn)",
    anim: "spin 1s linear infinite",
  },
  linked: { text: "已引用", icon: "⇄", color: "var(--info)", anim: "none" },
};
const SEMANTICS = [
  { key: "link", label: "软链接", icon: "⇄", desc: "引用对方内容，不产生依赖" },
  { key: "dispatch", label: "派发给", icon: "➤", desc: "把任务交给目标执行" },
  { key: "produce", label: "产出", icon: "◆", desc: "目标是本节点的结果" },
  { key: "write", label: "写入", icon: "✎", desc: "变更应用到目标文件" },
  { key: "trigger", label: "触发", icon: "⚡", desc: "完成后自动运行目标" },
  { key: "ref", label: "引用", icon: "@", desc: "作为上下文提供给 Agent" },
];
const SEM = Object.fromEntries(SEMANTICS.map((s) => [s.key, s]));
const FILE_SRC = `import { Router } from "express"
import { rateLimit } from "./rateLimit"

export const login = router.post(
  "/login",
  rateLimit({ windowMs: 60_000, max: 10 }),
  async (req, res) => {`;
const DEMO_NODES = [
  {
    id: "n1",
    type: "task",
    title: "登录接口加速率限制",
    subtitle: "ISSUE-482",
    status: "running",
    x: 40,
    y: 130,
    w: 280,
    h: 250,
    zoom: "normal",
    body: "为 POST /api/login 增加基于 IP 的速率限制（每分钟 10 次），并补充单元测试。",
  },
  {
    id: "n2",
    type: "agent",
    title: "实现代理",
    subtitle: "Claude Code · ACP v1",
    status: "waiting",
    x: 380,
    y: 40,
    w: 430,
    h: 600,
    zoom: "normal",
  },
  {
    id: "n3",
    type: "diff",
    title: "变更集 #12",
    subtitle: "3 个文件",
    status: "review",
    x: 870,
    y: 120,
    w: 400,
    h: 420,
    zoom: "normal",
  },
  {
    id: "n4",
    type: "file",
    title: "src/auth/login.ts",
    subtitle: "TypeScript",
    status: "modified",
    x: 1330,
    y: 180,
    w: 300,
    h: 230,
    zoom: "normal",
    body: FILE_SRC,
    lang: "TypeScript",
    lines: 142,
  },
  {
    id: "n5",
    type: "terminal",
    title: "npm test -- login",
    subtitle: "zsh",
    status: "running",
    x: 380,
    y: 690,
    w: 480,
    h: 280,
    zoom: "normal",
  },
];
const DEMO_EDGES = [
  { id: "e1", from: "n1", to: "n2", sem: "dispatch" },
  { id: "e2", from: "n2", to: "n3", sem: "produce" },
  { id: "e3", from: "n3", to: "n4", sem: "write" },
];
const TERM_SCRIPT = [
  ["> acme-web@2.4.1 test", "#9DA1AB"],
  ["> vitest run login", "#9DA1AB"],
  [""],
  [" ✓ src/auth/login.test.ts  (7 tests) 412ms", "#5FD39A"],
  [" ✓ 每分钟超过 10 次请求返回 429", "#5FD39A"],
  [" ✓ 窗口过期后重置计数", "#5FD39A"],
  [" ✓ 不同 IP 独立计数", "#5FD39A"],
  [" ✗ 白名单 IP 不受限制", "#F0605D"],
  ["   AssertionError: expected 429 to be 200", "#F0605D"],
  ["   at src/auth/login.test.ts:58:22", "#6E727C"],
  [""],
  [" Test Files  1 failed (1)", "#E6E7EB"],
  [" Tests  6 passed | 1 failed (7)", "#E6E7EB"],
  [" Duration  1.84s", "#9DA1AB"],
];
const DIFF_FILES = [
  {
    path: "src/auth/login.ts",
    kind: "M",
    add: 42,
    del: 3,
    hunk: '@@ -12,6 +12,9 @@ import { Router } from "express"',
    lines: [
      { no: "12", sign: " ", text: 'import { Router } from "express"' },
      { no: "13", sign: "+", text: 'import { rateLimit } from "./rateLimit"' },
      { no: "14", sign: " ", text: "" },
      {
        no: "15",
        sign: "-",
        text: 'export const login = router.post("/login", async (req, res) => {',
      },
      { no: "15", sign: "+", text: "export const login = router.post(" },
      { no: "16", sign: "+", text: '  "/login",' },
      {
        no: "17",
        sign: "+",
        text: "  rateLimit({ windowMs: 60_000, max: 10 }),",
      },
      { no: "18", sign: "+", text: "  async (req, res) => {" },
    ],
  },
  {
    path: "src/auth/rateLimit.ts",
    kind: "A",
    add: 61,
    del: 0,
    hunk: "@@ -0,0 +1,61 @@",
    lines: [
      {
        no: "1",
        sign: "+",
        text: "type Bucket = { tokens: number; updatedAt: number }",
      },
      { no: "2", sign: "+", text: "const buckets = new Map<string, Bucket>()" },
      { no: "3", sign: "+", text: "" },
      {
        no: "4",
        sign: "+",
        text: "export function rateLimit(opts: { windowMs: number; max: number }) {",
      },
    ],
  },
  {
    path: "src/auth/login.test.ts",
    kind: "M",
    add: 38,
    del: 1,
    hunk: '@@ -40,3 +40,21 @@ describe("POST /login"',
    lines: [
      { no: "40", sign: " ", text: "  })" },
      {
        no: "41",
        sign: "+",
        text: '  it("每分钟超过 10 次请求返回 429", async () => {',
      },
      {
        no: "42",
        sign: "+",
        text: '    for (let i = 0; i < 10; i++) await agent.post("/login")',
      },
      {
        no: "43",
        sign: "+",
        text: '    expect((await agent.post("/login")).status).toBe(429)',
      },
      { no: "44", sign: "+", text: "  })" },
    ],
  },
];
const initialMessages = () => [
  {
    id: 0,
    kind: "tool",
    tool: "ACP",
    arg: "Negotiating ACP v1 → connected (claude)",
    state: "done",
    result: "已连接",
  },
  {
    id: 1,
    kind: "user",
    text: "为登录接口补充基于 IP 的速率限制，并添加测试。",
  },
  {
    id: 2,
    kind: "thinking",
    dur: "4.2s",
    open: false,
    text: "需要先看 login.ts 现有中间件链，确认是否已有限流实现。Express 项目，无 redis，先做内存令牌桶，留接口后续替换存储。",
  },
  {
    id: 3,
    kind: "tool",
    tool: "读取文件",
    arg: "src/auth/login.ts",
    state: "done",
    result: "86ms",
  },
  {
    id: 4,
    kind: "tool",
    tool: "搜索代码",
    arg: '"rateLimit"',
    state: "done",
    result: "3 处匹配",
  },
  {
    id: 5,
    kind: "assistant",
    text: "我将在 login.ts 中加入基于 IP 的令牌桶限制（每分钟 10 次），新建 rateLimit.ts，并在 login.test.ts 补 3 个用例。",
  },
  {
    id: 6,
    kind: "tool",
    tool: "编辑文件",
    arg: "login.ts · rateLimit.ts · login.test.ts",
    state: "done",
    result: "+141 −4",
  },
  { id: 7, kind: "permission", decision: null },
];
const FILE_TREE = [
  ["src/", 0, "folder", ""],
  ["auth/", 1, "folder", ""],
  ["login.ts", 2, "file", "M"],
  ["rateLimit.ts", 2, "file", "A"],
  ["login.test.ts", 2, "file", "M"],
  ["session.ts", 2, "file", ""],
  ["api/", 1, "folder", ""],
  ["assets/", 0, "folder", ""],
  ["logo.png", 1, "image", ""],
  ["package.json", 0, "file", ""],
  ["CLAUDE.md", 0, "file", ""],
];
const mkWs = (id, name, path, color, boards) => ({
  id,
  name,
  path,
  color,
  boards,
});
const emptyBoard = (id, name) => ({
  id,
  name,
  nodes: [],
  edges: [],
  strokes: [],
  scale: 1,
  tx: 40,
  ty: 40,
});
const INITIAL_WS = [
  mkWs("w1", "acme-web", "~/code/acme-web", "#5B5BD6", [
    emptyBoard("b0", "Default"),
    {
      id: "b1",
      name: "登录限流",
      nodes: DEMO_NODES,
      edges: DEMO_EDGES,
      scale: 0.66,
      tx: 16,
      ty: 16,
    },
    emptyBoard("b2", "支付重构"),
  ]),
  mkWs("w2", "docs-site", "~/code/docs-site", "#0E9AA7", [
    emptyBoard("b0", "Default"),
  ]),
];

class Component extends DCLogic {
  state = {
    theme: "light",
    screen: "main",
    ws: INITIAL_WS,
    wsId: "w1",
    boardId: "b1",
    sel: "n2",
    vw: 880,
    vh: 804,
    tool: "select",
    penColor: PEN_COLORS[0],
    drag: null,
    pending: null,
    picker: null,
    dropHint: false,
    modal: null,
    settingsTab: "gateway",
    cmdQuery: "",
    newWs: {
      name: "",
      path: "",
      perms: { read: true, write: true, exec: false },
      gw: true,
    },
    gwOn: true,
    model: "claude",
    messages: initialMessages(),
    draft: "",
    agentRunning: true,
    tokens: 12480,
    elapsed: 48,
    ctx: ["src/auth/", "CLAUDE.md"],
    termLines: TERM_SCRIPT.slice(0, 3).map(([t, c]) => ({
      text: t,
      color: c || "#E6E7EB",
    })),
    termIdx: 3,
    termRunning: true,
    conn: "connected",
    pid: 48213,
    diffOpen: { "src/auth/login.ts": true },
    diffState: {},
  };
  vpRef = React.createRef();
  termRef = React.createRef();
  componentDidMount() {
    this.measure();
    window.addEventListener("resize", this.measure);
    this.timer = setInterval(() => this.tick(), 900);
    window.addEventListener("keydown", this.onKey);
  }
  componentWillUnmount() {
    clearInterval(this.timer);
    window.removeEventListener("resize", this.measure);
    window.removeEventListener("keydown", this.onKey);
  }
  measure = () => {
    const el = this.vpRef.current;
    if (el) this.setState({ vw: el.clientWidth, vh: el.clientHeight });
  };
  onKey = (e) => {
    if (e.key === "Escape") {
      this.setState({ picker: null, pending: null, modal: null });
      this.exitFocus();
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      this.setState({ modal: this.state.modal === "cmd" ? null : "cmd" });
    }
  };
  tick() {
    const s = this.state;
    const upd = {};
    if (s.agentRunning) {
      upd.elapsed = s.elapsed + 1;
      upd.tokens = s.tokens + Math.floor(Math.random() * 40);
    }
    if (s.termRunning && s.conn === "connected") {
      if (s.termIdx < TERM_SCRIPT.length) {
        const [t, c] = TERM_SCRIPT[s.termIdx];
        upd.termLines = [...s.termLines, { text: t, color: c || "#E6E7EB" }];
        upd.termIdx = s.termIdx + 1;
      } else {
        upd.termRunning = false;
        this.patchNodeAny("n5", { status: "error" });
      }
    }
    if (s.conn === "connecting") {
      upd.conn = "connected";
      upd.pid = 48213 + Math.floor(Math.random() * 900);
    }
    if (Object.keys(upd).length)
      this.setState(upd, () => {
        const t = this.termRef.current;
        if (t) t.scrollTop = t.scrollHeight;
      });
  }
  // ---- workspace / board helpers
  ws() {
    return (
      this.state.ws.find((w) => w.id === this.state.wsId) || this.state.ws[0]
    );
  }
  board() {
    const w = this.ws();
    return w.boards.find((b) => b.id === this.state.boardId) || w.boards[0];
  }
  updBoard(fn, extra) {
    const s = this.state;
    this.setState({
      ws: s.ws.map((w) =>
        w.id !== s.wsId
          ? w
          : {
              ...w,
              boards: w.boards.map((b) =>
                b.id !== s.boardId ? b : { ...b, ...fn(b) },
              ),
            },
      ),
      ...(extra || {}),
    });
  }
  setNodes(nodes, extra) {
    this.updBoard(() => ({ nodes }), extra);
  }
  patchNode(nodes, id, p) {
    return nodes.map((n) => (n.id === id ? { ...n, ...p } : n));
  }
  patchNodeAny(id, p) {
    this.updBoard((b) => ({ nodes: this.patchNode(b.nodes, id, p) }));
  }
  threshold() {
    return (this.props.summaryThreshold ?? 60) / 100;
  }
  dims(n) {
    return n.zoom === "mini" ? { w: 240, h: 52 } : { w: n.w, h: n.h };
  }
  toScreen(x, y) {
    const b = this.board();
    return { x: b.tx + x * b.scale, y: b.ty + y * b.scale };
  }
  local(cx, cy) {
    const el = this.vpRef.current;
    const r = el ? el.getBoundingClientRect() : { left: 0, top: 0 };
    return { x: cx - r.left, y: cy - r.top };
  }
  toWorld(cx, cy) {
    const l = this.local(cx, cy);
    const b = this.board();
    return { x: (l.x - b.tx) / b.scale, y: (l.y - b.ty) / b.scale };
  }
  effMini(n) {
    return n.zoom === "mini" || this.board().scale < this.threshold();
  }
  // ---- canvas interactions
  onBgDown = (e) => {
    if (e.button !== 0) return;
    if (this.state.tool === "pen") {
      this.setState({
        drag: {
          kind: "draw",
          pts: [this.toWorld(e.clientX, e.clientY)],
          color: this.state.penColor,
        },
        sel: null,
        picker: null,
      });
      return;
    }
    const b = this.board();
    this.setState({
      drag: { kind: "pan", sx: e.clientX, sy: e.clientY, tx: b.tx, ty: b.ty },
      sel: null,
      picker: null,
    });
  };
  onMove = (e) => {
    const { drag, pending } = this.state;
    if (drag && drag.kind === "draw") {
      this.setState({
        drag: {
          ...drag,
          pts: [...drag.pts, this.toWorld(e.clientX, e.clientY)],
        },
      });
    } else if (drag && drag.kind === "pan") {
      this.updBoard(() => ({
        tx: drag.tx + e.clientX - drag.sx,
        ty: drag.ty + e.clientY - drag.sy,
      }));
    } else if (drag && drag.kind === "node") {
      const sc = this.board().scale;
      const dx = (e.clientX - drag.sx) / sc,
        dy = (e.clientY - drag.sy) / sc;
      this.updBoard((b) => ({
        nodes: this.patchNode(b.nodes, drag.id, {
          x: Math.round(drag.x + dx),
          y: Math.round(drag.y + dy),
        }),
      }));
    } else if (pending) {
      const p = this.local(e.clientX, e.clientY);
      this.setState({ pending: { ...pending, mx: p.x, my: p.y } });
    }
  };
  onUp = () => {
    const { drag, pending } = this.state;
    if (drag && drag.kind === "draw") {
      if (drag.pts.length > 1)
        this.updBoard(
          (b) => ({
            strokes: [
              ...(b.strokes || []),
              {
                id: "s" + Date.now().toString(36),
                color: drag.color,
                pts: drag.pts,
              },
            ],
          }),
          { drag: null },
        );
      else this.setState({ drag: null });
      return;
    }
    if (drag || pending) this.setState({ drag: null, pending: null });
  };
  autoArrange() {
    const b = this.board();
    const ns = b.nodes;
    if (!ns.length) return;
    const inc = {};
    ns.forEach((n) => (inc[n.id] = 0));
    b.edges.forEach((e) => {
      if (inc[e.to] !== undefined) inc[e.to]++;
    });
    const depth = {};
    const visit = (id, d) => {
      if (d > 50 || (depth[id] ?? -1) >= d) return;
      depth[id] = d;
      b.edges.filter((e) => e.from === id).forEach((e) => visit(e.to, d + 1));
    };
    ns.filter(
      (n) => inc[n.id] === 0 && b.edges.some((e) => e.from === n.id),
    ).forEach((n) => visit(n.id, 0));
    const maxD = Math.max(-1, ...Object.values(depth));
    const cols = {};
    ns.forEach((n) => {
      const d = depth[n.id] ?? maxD + 1;
      (cols[d] = cols[d] || []).push(n);
    });
    let x = 0;
    const out = [];
    Object.keys(cols)
      .map(Number)
      .sort((a, c) => a - c)
      .forEach((d) => {
        let y = 0,
          colW = 0;
        cols[d].forEach((n) => {
          const nn = {
            ...n,
            x,
            y,
            zoom: n.zoom === "focus" ? "normal" : n.zoom,
          };
          const dm = this.dims(nn);
          out.push(nn);
          y += dm.h + 40;
          colW = Math.max(colW, dm.w);
        });
        x += colW + 120;
      });
    this.setNodes(out, { tool: "select" });
    setTimeout(() => this.zoomFit(), 0);
  }
  onWheel = (e) => {
    e.preventDefault();
    const b = this.board();
    const p = this.local(e.clientX, e.clientY);
    const ns = Math.min(
      2,
      Math.max(0.25, b.scale * (e.deltaY > 0 ? 0.92 : 1.08)),
    );
    this.updBoard(() => ({
      scale: ns,
      tx: p.x - ((p.x - b.tx) * ns) / b.scale,
      ty: p.y - ((p.y - b.ty) * ns) / b.scale,
    }));
  };
  zoomTo(ns) {
    const b = this.board();
    const { vw, vh } = this.state;
    const cx = vw / 2,
      cy = vh / 2;
    this.updBoard(() => ({
      scale: ns,
      tx: cx - ((cx - b.tx) * ns) / b.scale,
      ty: cy - ((cy - b.ty) * ns) / b.scale,
    }));
  }
  zoomFit = () => {
    const ns = this.board().nodes;
    if (!ns.length) return;
    const minX = Math.min(...ns.map((n) => n.x)),
      minY = Math.min(...ns.map((n) => n.y)),
      maxX = Math.max(...ns.map((n) => n.x + this.dims(n).w)),
      maxY = Math.max(...ns.map((n) => n.y + this.dims(n).h));
    const { vw, vh } = this.state;
    const s = Math.min(
      (vw - 48) / (maxX - minX),
      (vh - 48) / (maxY - minY),
      1.5,
    );
    this.updBoard(() => ({
      scale: s,
      tx: (vw - (maxX - minX) * s) / 2 - minX * s,
      ty: (vh - (maxY - minY) * s) / 2 - minY * s,
    }));
  };
  exitFocus() {
    const b = this.board();
    if (b.nodes.some((n) => n.zoom === "focus"))
      this.setNodes(
        b.nodes.map((n) => (n.zoom === "focus" ? { ...n, zoom: "normal" } : n)),
      );
  }
  setZoom(id, z) {
    this.setNodes(
      this.board().nodes.map((n) =>
        n.id === id
          ? { ...n, zoom: z }
          : z === "focus" && n.zoom === "focus"
            ? { ...n, zoom: "normal" }
            : n,
      ),
      { sel: id },
    );
  }
  newId() {
    return "n" + Date.now().toString(36) + Math.floor(Math.random() * 99);
  }
  addNode(type, extra, at) {
    const id = this.newId();
    const t = TYPES[type];
    const b = this.board();
    const { vw, vh } = this.state;
    const c = at
      ? this.toWorld(at.x, at.y)
      : { x: (vw / 2 - b.tx) / b.scale, y: (vh / 2 - b.ty) / b.scale };
    const n = {
      id,
      type,
      title: "新建" + t.cn,
      subtitle: t.desc,
      status: "idle",
      x: Math.round(c.x - (at ? 0 : t.size[0] / 2)),
      y: Math.round(c.y - (at ? 0 : t.size[1] / 2)),
      w: t.size[0],
      h: t.size[1],
      zoom: "normal",
      ...extra,
    };
    this.setNodes([...b.nodes, n], { sel: id, screen: "main" });
    return id;
  }
  addEdge(from, to, sem) {
    this.updBoard((b) => ({
      edges: [
        ...b.edges.filter((e) => !(e.from === from && e.to === to)),
        { id: "e" + Date.now().toString(36), from, to, sem },
      ],
    }));
  }
  // ---- drag & drop from sidebar
  onDragOver = (e) => {
    e.preventDefault();
    const d = this.dragPayload;
    const hint = d
      ? {
          file: "松开创建 File 节点",
          folder: "松开创建上下文引用",
          image: "松开添加为图片附件",
          node: "松开创建 " + (TYPES[d.type] || {}).cn + "节点",
        }[d.kind]
      : "松开创建节点";
    if (this.state.dropHint !== hint) this.setState({ dropHint: hint });
  };
  onDragLeave = () => {
    if (this.state.dropHint) this.setState({ dropHint: false });
  };
  onDrop = (e) => {
    e.preventDefault();
    const d = this.dragPayload;
    this.dragPayload = null;
    const at = e.clientX !== undefined ? { x: e.clientX, y: e.clientY } : null;
    const upd = { dropHint: false };
    if (!d) {
      this.setState(upd);
      return;
    }
    if (d.kind === "node") this.addNode(d.type, {}, at);
    else if (d.kind === "folder")
      this.addNode(
        "context",
        {
          title: d.name,
          subtitle: "文件夹引用",
          status: "linked",
          body: "~/code/acme-web/" + d.path,
        },
        at,
      );
    else if (d.kind === "image")
      this.addNode(
        "attachment",
        { title: d.name, subtitle: "PNG · 24 KB", status: "idle" },
        at,
      );
    else
      this.addNode(
        "file",
        {
          title: d.path,
          subtitle: "TypeScript",
          status: d.badge ? "modified" : "idle",
          body: FILE_SRC,
          lang: "TypeScript",
          lines: 142,
        },
        at,
      );
    this.setState(upd);
  };
  dropOnNode(target, e) {
    const d = this.dragPayload;
    if (!d || d.kind === "node") return;
    e.preventDefault();
    e.stopPropagation();
    this.dragPayload = null;
    if (target.type === "agent") {
      const id = this.addNode(d.kind === "folder" ? "context" : "file", {
        title: d.path || d.name,
        subtitle: d.kind === "folder" ? "文件夹引用" : "TypeScript",
        status: "linked",
        body: d.kind === "folder" ? "~/code/acme-web/" + d.path : FILE_SRC,
        lang: "TypeScript",
        lines: 142,
        x: target.x - 320,
        y: target.y + 40,
      });
      setTimeout(() => {
        this.addEdge(id, target.id, "ref");
        this.setState({
          ctx: [...this.state.ctx, d.path || d.name],
          dropHint: false,
        });
      }, 0);
    } else this.setState({ dropHint: false });
  }
  onPaste = (e) => {
    const cd = e.clipboardData;
    if (!cd) return;
    const img = Array.from(cd.items || []).find(
      (i) => i.type && i.type.startsWith("image/"),
    );
    if (img) {
      e.preventDefault();
      this.addNode("attachment", {
        title: "粘贴的图片",
        subtitle: img.type.replace("image/", "").toUpperCase() + " · 剪贴板",
        status: "idle",
        body: "（图片预览）",
      });
      return;
    }
    const t = cd.getData("text");
    if (t && t.trim()) {
      e.preventDefault();
      const txt = t.trim();
      this.addNode("note", {
        title: txt.split("\n")[0].slice(0, 18) + (txt.length > 18 ? "…" : ""),
        subtitle: "来自粘贴",
        body: txt,
      });
    }
  };

  renderVals() {
    const s = this.state;
    const T = this.threshold();
    const th = THEMES[s.theme];
    const W = this.ws();
    const B = this.board();
    const nodes = B.nodes,
      edges = B.edges;
    const rootVars = Object.fromEntries(
      Object.entries(th).map(([k, v]) => ["--" + k, v]),
    );
    const isLauncher = s.screen === "launcher",
      isMain = !isLauncher,
      isEmpty = isMain && nodes.length === 0;
    const summaryMode = isMain && !isEmpty && B.scale < T;
    const screens = [
      ["launcher", "启动页"],
      ["main", "工作区"],
      ["newws", "新建工作空间"],
      ["settings", "设置"],
      ["cmd", "⌘K"],
      ["diff", "Diff 扫描"],
    ].map(([k, label]) => ({
      label,
      go: () => {
        if (k === "launcher" || k === "main")
          this.setState({ screen: k, modal: null });
        else this.setState({ screen: "main", modal: k });
      },
      bg:
        (k === s.screen && !s.modal) || k === s.modal
          ? "#1B1D26"
          : "transparent",
      fg: (k === s.screen && !s.modal) || k === s.modal ? "#fff" : "#3D4150",
    }));
    const gw = s.gwOn
      ? {
          icon: "⇄",
          text: "在线 · 2 台外部端",
          color: "var(--ok)",
          devices: "2 台在线",
        }
      : { icon: "⊘", text: "已关闭", color: "var(--muted)", devices: "未开放" };
    const openBoardOf = (wid, bid) =>
      this.setState({
        wsId: wid,
        boardId: bid,
        sel: null,
        screen: "main",
        modal: null,
      });
    const recents = [
      {
        name: "acme-web",
        path: "~/code/acme-web",
        when: "2 分钟前",
        color: "#5B5BD6",
        git: "main · 3 处未提交",
        stats: "3 个看板 · 5 节点",
        gw: "网关在线",
        gwColor: "var(--ok)",
        gwIcon: "⇄",
        boards: ["Default", "登录限流", "支付重构"],
        open: () => openBoardOf("w1", "b1"),
      },
      {
        name: "docs-site",
        path: "~/code/docs-site",
        when: "昨天",
        color: "#0E9AA7",
        git: "main",
        stats: "1 个看板",
        gw: "网关关闭",
        gwColor: "var(--muted)",
        gwIcon: "⊘",
        boards: ["Default"],
        open: () => openBoardOf("w2", "b0"),
      },
      {
        name: "mobile-app",
        path: "~/Projects/Rust/Tauri/mobile-app",
        when: "3 天前",
        color: "#E0762E",
        git: "develop",
        stats: "2 个看板",
        gw: "网关关闭",
        gwColor: "var(--muted)",
        gwIcon: "⊘",
        boards: ["Default", "发布 1.2"],
        open: () => openBoardOf("w1", "b0"),
      },
      {
        name: "infra",
        path: "~/code/infra",
        when: "上周",
        color: "#1F9D64",
        git: "main",
        stats: "1 个看板",
        gw: "网关关闭",
        gwColor: "var(--muted)",
        gwIcon: "⊘",
        boards: ["Default"],
        open: () => openBoardOf("w2", "b0"),
      },
    ];
    const wsRail = s.ws.map((w) => ({
      name: w.name,
      letter: w.name[0].toUpperCase(),
      color: w.color,
      ring: w.id === s.wsId ? "var(--text)" : "transparent",
      running: w.boards.some((b) =>
        b.nodes.some((n) => n.status === "running"),
      ),
      select: () => openBoardOf(w.id, w.boards[0].id),
    }));
    const boards = W.boards.map((b) => ({
      name: b.name,
      count: b.nodes.length ? b.nodes.length + " 节点" : "空",
      running: b.nodes.some((n) => n.status === "running"),
      bg: b.id === B.id ? "var(--accentSoft)" : "transparent",
      fg: b.id === B.id ? "var(--accent)" : "var(--text)",
      weight: b.id === B.id ? 600 : 500,
      select: () => this.setState({ boardId: b.id, sel: null }),
    }));
    const setPayload = (p) => (e) => {
      this.dragPayload = p;
      try {
        e.dataTransfer.setData("text/plain", JSON.stringify(p));
        e.dataTransfer.effectAllowed = "copy";
      } catch (x) {}
    };
    const files = FILE_TREE.map(([name, depth, kind, badge]) => {
      const path =
        depth === 0 ? name : depth === 1 ? "src/" + name : "src/auth/" + name;
      return {
        name,
        pad: 8 + depth * 12,
        icon: kind === "folder" ? "▸" : kind === "image" ? "▣" : "▤",
        badge,
        badgeColor: badge === "A" ? "var(--ok)" : "var(--warn)",
        color: badge ? "var(--text)" : "var(--muted)",
        dragStart: setPayload({ kind, name, path, badge }),
        toggle: () => {},
      };
    });
    const palette = [
      "task",
      "agent",
      "terminal",
      "diff",
      "file",
      "note",
      "browser",
      "attachment",
      "log",
    ].map((k) => {
      const t = TYPES[k];
      return {
        name: t.cn,
        desc: t.desc,
        icon: t.icon,
        color: t.color,
        bg: t.bg,
        add: () => this.addNode(k),
        dragStart: setPayload({ kind: "node", type: k }),
      };
    });

    const nodeViews = nodes.map((n) => {
      const t = TYPES[n.type];
      const st = STATUS[n.status] || STATUS.idle;
      const mini = this.effMini(n);
      const focus = n.zoom === "focus";
      const d = this.dims(mini ? { ...n, zoom: "mini" } : n);
      const selected = s.sel === n.id;
      const p = this.toScreen(n.x, n.y);
      const style = focus
        ? {
            position: "absolute",
            left: 12,
            top: 12,
            width: s.vw - 24,
            height: s.vh - 24,
            zIndex: 30,
          }
        : {
            position: "absolute",
            left: p.x,
            top: p.y,
            width: d.w,
            height: d.h,
            transform: `scale(${B.scale})`,
            transformOrigin: "0 0",
            zIndex: selected ? 10 : 1,
          };
      return {
        id: n.id,
        title: n.title,
        subtitle: n.subtitle,
        body: n.body,
        lang: n.lang,
        lines: n.lines,
        typeName: t.name,
        typeIcon: t.icon,
        typeColor: t.color,
        typeBg: t.bg,
        statusText: st.text,
        statusIcon: st.icon,
        statusColor: st.color,
        statusBg: "var(--card2)",
        statusAnim: st.anim,
        style,
        radius: mini ? 12 : 14,
        borderColor: selected
          ? "var(--accent)"
          : focus
            ? "var(--accentLine)"
            : "var(--border)",
        shadow: selected || focus ? "var(--shadowLg)" : "var(--shadow)",
        headPad: mini ? "6px 8px" : "4px 8px",
        headBorder: mini ? "0" : "1px solid var(--border)",
        showSub: !mini,
        showControls: !mini,
        isMini: mini,
        showBody: !mini,
        showPorts: !focus,
        isTask: n.type === "task",
        isAgent: n.type === "agent",
        isTerminal: n.type === "terminal",
        isDiff: n.type === "diff",
        isFile: n.type === "file" || n.type === "attachment",
        isContext: n.type === "context",
        isLog: n.type === "log",
        isNote: n.type === "note",
        isBrowser: n.type === "browser",
        noteBg: s.theme === "light" ? "#FFF8DC" : "rgba(184,134,11,.10)",
        charCount: (n.body || "").length,
        setBody: (e) => this.patchNodeAny(n.id, { body: e.target.value }),
        toTask: () =>
          this.patchNodeAny(n.id, {
            type: "task",
            subtitle: "由便签转换",
            w: TYPES.task.size[0],
            h: TYPES.task.size[1],
          }),
        url: n.url || "https://",
        setUrl: (e) =>
          this.patchNodeAny(n.id, {
            url: e.target.value,
            title:
              e.target.value.replace(/^https?:\/\//, "").split("/")[0] ||
              "浏览器",
          }),
        termFont: focus ? 13 : 11.5,
        focusGlyph: focus ? "⤡" : "⤢",
        focusTitle: focus ? "退出聚焦" : "聚焦放大",
        onHeadDown: (e) => {
          if (focus || e.button !== 0) return;
          e.stopPropagation();
          this.setState({
            sel: n.id,
            drag: {
              kind: "node",
              id: n.id,
              sx: e.clientX,
              sy: e.clientY,
              x: n.x,
              y: n.y,
            },
            picker: null,
          });
        },
        onPortDown: (e) => {
          e.stopPropagation();
          const l = this.local(e.clientX, e.clientY);
          this.setState({
            pending: { from: n.id, mx: l.x, my: l.y },
            sel: n.id,
          });
        },
        onDropTarget: (e) => {
          const pd = s.pending;
          if (pd && pd.from !== n.id) {
            e.stopPropagation();
            const l = this.local(e.clientX, e.clientY);
            this.setState({
              pending: null,
              drag: null,
              picker: {
                from: pd.from,
                to: n.id,
                x: Math.min(l.x, s.vw - 292),
                y: Math.min(l.y, s.vh - 360),
              },
            });
          }
        },
        onDragOver: (e) => {
          if (
            n.type === "agent" &&
            this.dragPayload &&
            this.dragPayload.kind !== "node"
          ) {
            e.preventDefault();
            e.stopPropagation();
            if (s.dropHint !== "松开加入 Agent 上下文并自动连线")
              this.setState({ dropHint: "松开加入 Agent 上下文并自动连线" });
          }
        },
        onFileDrop: (e) => this.dropOnNode(n, e),
        toggleFocus: (e) => {
          e && e.stopPropagation();
          this.setZoom(n.id, focus ? "normal" : "focus");
        },
        setMini: (e) => {
          e.stopPropagation();
          this.setZoom(n.id, "mini");
        },
        setNormal: (e) => {
          e.stopPropagation();
          this.setZoom(n.id, "normal");
        },
      };
    });
    const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
    const edgeViews = edges
      .filter((e) => byId[e.from] && byId[e.to])
      .map((e) => {
        const a = byId[e.from],
          b = byId[e.to];
        const da = this.dims(this.effMini(a) ? { ...a, zoom: "mini" } : a),
          db = this.dims(this.effMini(b) ? { ...b, zoom: "mini" } : b);
        const p1 = this.toScreen(a.x + da.w, a.y + da.h / 2),
          p2 = this.toScreen(b.x, b.y + db.h / 2);
        const dx = Math.max(40, Math.abs(p2.x - p1.x) * 0.45);
        const sem = SEM[e.sem];
        const hi = s.sel === e.from || s.sel === e.to;
        return {
          d: `M${p1.x},${p1.y} C${p1.x + dx},${p1.y} ${p2.x - dx},${p2.y} ${p2.x},${p2.y}`,
          stroke: hi ? th.accent : th.faint,
          sw: hi ? 2.5 : 2,
          dash: e.sem === "link" || e.sem === "ref" ? "6 5" : "0",
          marker: hi ? "url(#arwA)" : "url(#arw)",
          lx: (p1.x + p2.x) / 2,
          ly: (p1.y + p2.y) / 2,
          ls: Math.max(0.75, Math.min(1, B.scale)),
          label: sem.label,
          icon: sem.icon,
        };
      });
    let pendingD = false;
    if (s.pending && byId[s.pending.from]) {
      const a = byId[s.pending.from];
      const da = this.dims(this.effMini(a) ? { ...a, zoom: "mini" } : a);
      const p1 = this.toScreen(a.x + da.w, a.y + da.h / 2);
      const dx = Math.max(40, Math.abs(s.pending.mx - p1.x) * 0.45);
      pendingD = `M${p1.x},${p1.y} C${p1.x + dx},${p1.y} ${s.pending.mx - dx},${s.pending.my} ${s.pending.mx},${s.pending.my}`;
    }
    const picker = s.picker
      ? {
          ...s.picker,
          fromTitle: byId[s.picker.from]?.title,
          toTitle: byId[s.picker.to]?.title,
        }
      : false;
    const strokeD = (pts) =>
      pts
        .map((p, i) => {
          const q = this.toScreen(p.x, p.y);
          return (i ? "L" : "M") + q.x.toFixed(1) + "," + q.y.toFixed(1);
        })
        .join(" ");
    const strokeViews = (B.strokes || []).map((k) => ({
      d: strokeD(k.pts),
      color: k.color,
      sw: Math.max(1.5, 3 * B.scale),
    }));
    const pendingStroke =
      s.drag && s.drag.kind === "draw" && s.drag.pts.length > 1
        ? {
            d: strokeD(s.drag.pts),
            color: s.drag.color,
            sw: Math.max(1.5, 3 * B.scale),
          }
        : false;
    const tools = [
      ["select", "↖", "选择", "选择 / 拖动 / 平移"],
      ["pen", "✎", "画笔", "在画布上手绘标注"],
    ].map(([k, icon, label, title]) => ({
      icon,
      label,
      title,
      set: () => this.setState({ tool: k }),
      bg: s.tool === k ? "var(--accent)" : "transparent",
      fg: s.tool === k ? "#fff" : "var(--text)",
    }));
    const penColors = PEN_COLORS.map((c) => ({
      color: c,
      ring: s.penColor === c ? "var(--text)" : "transparent",
      set: () => this.setState({ penColor: c }),
    }));
    const semantics = SEMANTICS.map((sm, i) => ({
      ...sm,
      key: String(i + 1),
      pick: () => {
        const pk = s.picker;
        this.addEdge(pk.from, pk.to, sm.key);
        this.setState({ picker: null });
      },
    }));

    // agent
    const acp = {
      connected: {
        icon: "✓",
        text: "ACP 已连接",
        color: "var(--ok)",
        anim: "none",
      },
      connecting: {
        icon: "◌",
        text: "协商中",
        color: "var(--warn)",
        anim: "spin 1s linear infinite",
      },
      offline: { icon: "⊘", text: "离线", color: "var(--err)", anim: "none" },
    }[s.agentRunning ? "connected" : "connected"];
    const messages = s.messages.map((m) => {
      const base = {
        isUser: m.kind === "user",
        isAssistant: m.kind === "assistant",
        isThinking: m.kind === "thinking",
        isTool: m.kind === "tool",
        isPermission: m.kind === "permission",
        text: m.text,
      };
      if (m.kind === "thinking")
        Object.assign(base, {
          dur: m.dur,
          open: m.open,
          chev: m.open ? "▾" : "▸",
          hint: m.open ? "收起" : "展开",
          toggle: () =>
            this.setState({
              messages: s.messages.map((x) =>
                x.id === m.id ? { ...x, open: !x.open } : x,
              ),
            }),
        });
      if (m.kind === "tool") {
        const st =
          m.state === "running"
            ? STATUS.running
            : m.state === "error"
              ? STATUS.error
              : STATUS.done;
        Object.assign(base, {
          tool: m.tool,
          arg: m.arg,
          result: m.result,
          icon: st.icon,
          color: st.color,
          anim: st.anim,
        });
      }
      if (m.kind === "permission") {
        const dec = m.decision;
        const decide = (d) => {
          const msgs = s.messages.map((x) =>
            x.id === m.id ? { ...x, decision: d } : x,
          );
          if (d === "deny") {
            this.setState({
              messages: [
                ...msgs,
                {
                  id: Date.now(),
                  kind: "assistant",
                  text: "已跳过测试执行。变更已写入，可在 Diff 节点审阅后手动运行。",
                },
              ],
              agentRunning: false,
            });
            this.patchNodeAny("n2", { status: "done" });
          } else {
            this.setState({
              messages: [
                ...msgs,
                {
                  id: Date.now(),
                  kind: "tool",
                  tool: "执行命令",
                  arg: "npm test -- login",
                  state: "running",
                  result: "运行中",
                },
              ],
              termRunning: true,
              termIdx: 0,
              termLines: [],
              conn: "connected",
            });
            this.patchNodeAny("n2", { status: "running" });
          }
        };
        Object.assign(base, {
          pending: !dec,
          decided: !!dec,
          decText:
            dec === "once"
              ? "已允许一次 · 正在执行"
              : dec === "always"
                ? "已始终允许 · 正在执行"
                : "已拒绝",
          decIcon: dec === "deny" ? "✕" : "✓",
          decColor: dec === "deny" ? "var(--err)" : "var(--ok)",
          allowOnce: () => decide("once"),
          allowAlways: () => decide("always"),
          deny: () => decide("deny"),
        });
      }
      return base;
    });
    const send = () => {
      const t = s.draft.trim();
      if (!t) return;
      this.setState({
        draft: "",
        agentRunning: true,
        messages: [
          ...s.messages,
          { id: Date.now(), kind: "user", text: t },
          {
            id: Date.now() + 1,
            kind: "thinking",
            dur: "…",
            open: false,
            text: "正在分析追问…",
          },
        ],
      });
      this.patchNodeAny("n2", { status: "running" });
    };
    const ctxChips = s.ctx.map((c) => ({
      name: c,
      icon: c.endsWith("/") ? "▸" : "▤",
      remove: () => this.setState({ ctx: s.ctx.filter((x) => x !== c) }),
    }));
    // terminal
    const conn =
      s.conn === "connected"
        ? s.termRunning
          ? STATUS.running
          : STATUS.done
        : STATUS[s.conn];
    const connText = s.conn === "connected" ? "已连接" : conn.text;
    const failed = s.termLines.some((l) => l.color === "#F0605D");
    const termSummary =
      s.conn !== "connected"
        ? "会话不可用，请重连"
        : s.termRunning
          ? "正在运行 · " + s.termLines.length + " 行输出"
          : failed
            ? "退出码 1 · 1 个测试失败"
            : "退出码 0";
    // diff
    const stMap = {
      accepted: { text: "已接受", icon: "✓", color: "var(--ok)" },
      reverted: { text: "已回滚", icon: "↶", color: "var(--muted)" },
      pending: { text: "待审", icon: "◇", color: "var(--diff)" },
    };
    const diffFiles = DIFF_FILES.map((f) => {
      const st = stMap[s.diffState[f.path] || "pending"];
      const open = !!s.diffOpen[f.path];
      return {
        ...f,
        open,
        chev: open ? "▾" : "▸",
        kindBg: f.kind === "A" ? "var(--infoSoft)" : "var(--warnSoft)",
        kindColor: f.kind === "A" ? "var(--ok)" : "var(--warn)",
        stText: st.text,
        stIcon: st.icon,
        stColor: st.color,
        lines: f.lines.map((l) => ({
          ...l,
          bg:
            l.sign === "+"
              ? "rgba(63,191,127,.14)"
              : l.sign === "-"
                ? "rgba(240,96,93,.14)"
                : "transparent",
          color:
            l.sign === "+"
              ? "var(--ok)"
              : l.sign === "-"
                ? "var(--err)"
                : "var(--text)",
        })),
        toggle: () =>
          this.setState({ diffOpen: { ...s.diffOpen, [f.path]: !open } }),
        accept: () =>
          this.setState({
            diffState: { ...s.diffState, [f.path]: "accepted" },
          }),
        revert: () =>
          this.setState({
            diffState: { ...s.diffState, [f.path]: "reverted" },
          }),
      };
    });
    const decided = DIFF_FILES.filter((f) => s.diffState[f.path]).length;
    const setAll = (v) => {
      this.setState({
        diffState: Object.fromEntries(DIFF_FILES.map((f) => [f.path, v])),
      });
      this.patchNodeAny("n3", { status: v === "accepted" ? "done" : "idle" });
    };
    // inspector
    const selNode = byId[s.sel];
    let sel = false;
    if (selNode) {
      const n = selNode,
        t = TYPES[n.type],
        st = STATUS[n.status] || STATUS.idle;
      const rel = edges.filter((e) => e.from === n.id || e.to === n.id);
      const actions =
        {
          task: [
            ["➤", "派发给 Agent"],
            ["✎", "编辑任务"],
          ],
          agent: [
            ["▶", "携带上下文运行"],
            ["↻", "重新协商 ACP"],
            ["⇄", "推送到外部端"],
          ],
          terminal: [
            ["▶", "重新运行"],
            ["↻", "重连会话"],
          ],
          diff: [
            ["✓", "全部接受"],
            ["↶", "全部回滚"],
            ["⤓", "导出 patch"],
          ],
          file: [
            ["↗", "在编辑器中打开"],
            ["@", "加入 Agent 上下文"],
          ],
          context: [
            ["@", "注入 Agent"],
            ["↻", "刷新索引"],
          ],
          log: [["⤓", "导出日志"]],
          attachment: [
            ["@", "发送给 Agent"],
            ["✎", "在图上标注"],
          ],
          note: [
            ["@", "发送给 Agent"],
            ["☰", "转为任务"],
            ["⧉", "拆分为多条"],
          ],
          browser: [
            ["@", "网页内容发送给 Agent"],
            ["⤓", "截图到画布"],
            ["↗", "系统浏览器打开"],
          ],
        }[n.type] || [];
      sel = {
        id: n.id,
        title: n.title,
        typeName: t.name,
        typeIcon: t.icon,
        typeColor: t.color,
        typeBg: t.bg,
        statusText: st.text,
        statusIcon: st.icon,
        statusColor: st.color,
        pos: `${n.x}, ${n.y}`,
        size: `${n.w} × ${n.h}`,
        rename: (e) => this.patchNodeAny(n.id, { title: e.target.value }),
        zoomOpts: [
          ["mini", "缩小", "−"],
          ["normal", "正常", "▢"],
          ["focus", "聚焦", "⤢"],
        ].map(([k, label, icon]) => ({
          label,
          icon,
          set: () => this.setZoom(n.id, k),
          bg: n.zoom === k ? "var(--accent)" : "transparent",
          fg: n.zoom === k ? "#fff" : "var(--muted)",
        })),
        edgeCount: rel.length,
        noEdges: !rel.length,
        edges: rel.map((e) => {
          const out = e.from === n.id;
          const o = byId[out ? e.to : e.from];
          return {
            dirIcon: out ? "→ 出" : "← 入",
            other: o ? o.title : "?",
            label: SEM[e.sem].label,
            remove: () =>
              this.updBoard((b) => ({
                edges: b.edges.filter((x) => x.id !== e.id),
              })),
          };
        }),
        actions: actions.map(([icon, label]) => ({ icon, label })),
        duplicate: () => {
          const id = this.newId();
          this.setNodes(
            [
              ...nodes,
              {
                ...n,
                id,
                x: n.x + 40,
                y: n.y + 40,
                zoom: "normal",
                title: n.title + " 副本",
              },
            ],
            { sel: id },
          );
        },
        remove: () =>
          this.updBoard(
            (b) => ({
              nodes: b.nodes.filter((x) => x.id !== n.id),
              edges: b.edges.filter((e) => e.from !== n.id && e.to !== n.id),
            }),
            { sel: null },
          ),
      };
    }
    const overview = nodes.map((n) => {
      const t = TYPES[n.type],
        st = STATUS[n.status] || STATUS.idle;
      return {
        title: n.title,
        typeIcon: t.icon,
        typeColor: t.color,
        typeBg: t.bg,
        statusText: st.text,
        statusIcon: st.icon,
        statusColor: st.color,
        select: () => this.setState({ sel: n.id }),
      };
    });
    // modals
    const nw = s.newWs;
    const setNw = (p) => this.setState({ newWs: { ...nw, ...p } });
    const newWsPerms = [
      ["read", "读取", "浏览与读取文件"],
      ["write", "写入", "创建、修改、删除文件"],
      ["exec", "执行", "运行 Shell 命令（逐次确认）"],
    ].map(([k, name, desc]) => {
      const on = nw.perms[k];
      return {
        name,
        desc,
        mark: on ? "☑" : "☐",
        markColor: on ? "var(--accent)" : "var(--faint)",
        border: on ? "var(--accent)" : "var(--border)",
        toggle: () => setNw({ perms: { ...nw.perms, [k]: !on } }),
      };
    });
    const settingsTabs = [
      ["models", "◈", "模型与提供方"],
      ["acp", "⇋", "ACP 协议"],
      ["gateway", "⇄", "网关与外部端"],
      ["theme", "◑", "外观"],
      ["keys", "⌘", "快捷键"],
    ].map(([k, icon, label]) => ({
      icon,
      label,
      select: () => this.setState({ settingsTab: k }),
      bg: s.settingsTab === k ? "var(--accentSoft)" : "transparent",
      fg: s.settingsTab === k ? "var(--accent)" : "var(--text)",
      weight: s.settingsTab === k ? 600 : 500,
    }));
    const providers = [
      {
        letter: "C",
        name: "Claude Code",
        desc: "Anthropic · 通过 ACP 本地进程",
        bg: "rgba(224,118,46,.16)",
        color: "#E0762E",
        st: "已连接",
        stIcon: "✓",
        stColor: "var(--ok)",
      },
      {
        letter: "X",
        name: "Codex CLI",
        desc: "OpenAI · 通过 ACP 本地进程",
        bg: "rgba(31,157,100,.16)",
        color: "#1F9D64",
        st: "未安装",
        stIcon: "○",
        stColor: "var(--muted)",
      },
      {
        letter: "G",
        name: "Gemini CLI",
        desc: "Google · 通过 ACP 本地进程",
        bg: "rgba(46,124,246,.16)",
        color: "#2E7CF6",
        st: "需要 API Key",
        stIcon: "⚠",
        stColor: "var(--warn)",
      },
    ];
    const devices = [
      {
        icon: "▯",
        name: "iPhone 15 · 李",
        meta: "移动端 · 局域网 · 最近活动 1 分钟前",
        st: "在线",
        stIcon: "●",
        stColor: "var(--ok)",
      },
      {
        icon: "▭",
        name: "Chrome · MacBook Air",
        meta: "浏览器 · 局域网 · 最近活动 12 分钟前",
        st: "在线",
        stIcon: "●",
        stColor: "var(--ok)",
      },
      {
        icon: "▭",
        name: "Safari · iPad",
        meta: "浏览器 · 上次 3 天前",
        st: "离线",
        stIcon: "○",
        stColor: "var(--muted)",
      },
    ];
    const themeOpts = [
      ["light", "浅色", "linear-gradient(135deg,#F3F4F8,#FFFFFF)"],
      ["dark", "深色", "linear-gradient(135deg,#0E0F12,#23252B)"],
    ].map(([k, label, preview]) => ({
      label,
      preview,
      border: s.theme === k ? "var(--accent)" : "transparent",
      set: () => this.setState({ theme: k }),
    }));
    const shortcuts = [
      ["命令面板", "⌘ K"],
      ["新建工作空间", "⌘ N"],
      ["打开项目位置", "⌘ O"],
      ["新建看板", "⌘ ⇧ N"],
      ["聚焦选中节点", "⏎"],
      ["退出聚焦 / 取消", "Esc"],
      ["适应画布", "⇧ 1"],
      ["缩放到 100%", "⇧ 0"],
      ["删除节点", "⌫"],
      ["运行 Agent", "⌘ ⏎"],
    ].map(([label, keys]) => ({ label, keys }));
    const q = s.cmdQuery.trim().toLowerCase();
    const cmdAll = [
      {
        g: "创建",
        icon: "☰",
        bg: TYPES.task.bg,
        color: TYPES.task.color,
        label: "新建任务节点",
        keys: "T",
        run: () => {
          this.addNode("task");
          this.setState({ modal: null });
        },
      },
      {
        g: "创建",
        icon: "✦",
        bg: TYPES.agent.bg,
        color: TYPES.agent.color,
        label: "新建 Agent (ACP)",
        keys: "A",
        run: () => {
          this.addNode("agent", {
            title: "新代理",
            subtitle: "Claude Code · ACP v1",
          });
          this.setState({ modal: null });
        },
      },
      {
        g: "创建",
        icon: ">_",
        bg: TYPES.terminal.bg,
        color: TYPES.terminal.color,
        label: "新建终端",
        keys: "⌘ `",
        run: () => {
          this.addNode("terminal");
          this.setState({ modal: null });
        },
      },
      {
        g: "创建",
        icon: "▢",
        bg: TYPES.note.bg,
        color: TYPES.note.color,
        label: "新建便签",
        keys: "N",
        run: () => {
          this.addNode("note", {
            title: "便签",
            subtitle: "文本片段",
            body: "",
          });
          this.setState({ modal: null });
        },
      },
      {
        g: "创建",
        icon: "◍",
        bg: TYPES.browser.bg,
        color: TYPES.browser.color,
        label: "新建嵌入浏览器",
        keys: "B",
        run: () => {
          this.addNode("browser", {
            title: "新标签页",
            subtitle: "嵌入网页",
            url: "https://",
          });
          this.setState({ modal: null });
        },
      },
      {
        g: "创建",
        icon: "▦",
        bg: "var(--accentSoft)",
        color: "var(--accent)",
        label: "新建看板",
        keys: "⌘ ⇧ N",
        run: () => {
          this.addBoard();
          this.setState({ modal: null });
        },
      },
      {
        g: "命令",
        icon: "⊞",
        bg: "var(--card2)",
        color: "var(--muted)",
        label: "一键整理画布",
        keys: "⌘ ⇧ L",
        run: () => {
          this.autoArrange();
          this.setState({ modal: null });
        },
      },
      {
        g: "跳转",
        icon: "▤",
        bg: TYPES.file.bg,
        color: TYPES.file.color,
        label: "src/auth/login.ts",
        keys: "",
        run: () => this.setState({ modal: null, sel: "n4" }),
      },
      {
        g: "跳转",
        icon: "✦",
        bg: TYPES.agent.bg,
        color: TYPES.agent.color,
        label: "实现代理",
        keys: "",
        run: () => this.setState({ modal: null, sel: "n2" }),
      },
      {
        g: "命令",
        icon: "±",
        bg: TYPES.diff.bg,
        color: TYPES.diff.color,
        label: "扫描 Diff",
        keys: "⌘ D",
        run: () => this.setState({ modal: "diff" }),
      },
      {
        g: "命令",
        icon: "⇄",
        bg: "var(--infoSoft)",
        color: "var(--info)",
        label: s.gwOn ? "关闭网关" : "开启网关",
        keys: "",
        run: () => this.setState({ gwOn: !s.gwOn, modal: null }),
      },
      {
        g: "命令",
        icon: "◑",
        bg: "var(--card2)",
        color: "var(--muted)",
        label: "切换主题",
        keys: "⌘ ⇧ T",
        run: () =>
          this.setState({ theme: s.theme === "light" ? "dark" : "light" }),
      },
      {
        g: "命令",
        icon: "⚙",
        bg: "var(--card2)",
        color: "var(--muted)",
        label: "打开设置",
        keys: "⌘ ,",
        run: () => this.setState({ modal: "settings" }),
      },
    ].filter((c) => !q || c.label.toLowerCase().includes(q));
    const cmdGroups = [...new Set(cmdAll.map((c) => c.g))].map((g) => ({
      title: g,
      items: cmdAll.filter((c) => c.g === g),
    }));

    return {
      rootVars,
      screens,
      themeLabel: s.theme === "light" ? "◑ 深色" : "◐ 浅色",
      themeIcon: s.theme === "light" ? "◑" : "◐",
      toggleTheme: () =>
        this.setState({ theme: s.theme === "light" ? "dark" : "light" }),
      isLauncher,
      isMain,
      isEmpty,
      wsName: W.name,
      wsPath: W.path,
      boardName: B.name,
      gitText: W.id === "w1" ? "main · 3 处未提交" : "main",
      gwColor: gw.color,
      gwIcon: gw.icon,
      gwText: gw.text,
      gwDevices: gw.devices,
      gwPort: "7420",
      gwToggleBg: s.gwOn ? "var(--accent)" : "var(--faint)",
      gwKnob: s.gwOn ? 19 : 3,
      toggleGw: () => this.setState({ gwOn: !s.gwOn }),
      recents,
      openWorkspaceDemo: () => openBoardOf("w1", "b1"),
      openNewWs: () => this.setState({ modal: "newws" }),
      openSettings: () => this.setState({ modal: "settings" }),
      openCmd: () => this.setState({ modal: "cmd", cmdQuery: "" }),
      openDiffScan: () => this.setState({ modal: "diff" }),
      closeModals: () => this.setState({ modal: null }),
      wsRail,
      boards,
      addBoard: () => this.addBoard(),
      files,
      palette,
      seedDemo: () =>
        this.updBoard(
          () => ({
            nodes: DEMO_NODES,
            edges: DEMO_EDGES,
            scale: 0.66,
            tx: 16,
            ty: 16,
          }),
          { sel: "n2" },
        ),
      addAgentHere: () =>
        this.addNode("agent", {
          title: "新代理",
          subtitle: "Claude Code · ACP v1",
        }),
      vpRef: this.vpRef,
      onBgDown: this.onBgDown,
      onMove: this.onMove,
      onUp: this.onUp,
      onWheel: this.onWheel,
      onDragOver: this.onDragOver,
      onDragLeave: this.onDragLeave,
      onDrop: this.onDrop,
      onPaste: this.onPaste,
      stop: (e) => e.stopPropagation(),
      dropHint: s.dropHint,
      gridSize: 24 * B.scale,
      gridPos: `${B.tx}px ${B.ty}px`,
      vpCursor:
        s.drag?.kind === "pan"
          ? "grabbing"
          : s.pending || s.tool === "pen"
            ? "crosshair"
            : "default",
      edgeColor: th.faint,
      accentColor: th.accent,
      strokeViews,
      pendingStroke,
      tools,
      penColors,
      penMode: s.tool === "pen",
      clearStrokes: () => this.updBoard(() => ({ strokes: [] })),
      showToolbar: !nodes.some((n) => n.zoom === "focus"),
      autoArrange: () => this.autoArrange(),
      addNote: () =>
        this.addNode("note", { title: "便签", subtitle: "文本片段", body: "" }),
      addBrowser: () =>
        this.addNode("browser", {
          title: "developer.mozilla.org",
          subtitle: "嵌入网页",
          url: "https://developer.mozilla.org/zh-CN/docs/Web/HTTP/Status/429",
        }),
      zoomPct: Math.round(B.scale * 100) + "%",
      thresholdPct: Math.round(T * 100) + "%",
      zoomIn: () => this.zoomTo(Math.min(2, B.scale * 1.2)),
      zoomOut: () => this.zoomTo(Math.max(0.25, B.scale / 1.2)),
      zoomReset: () => this.zoomTo(1),
      zoomFit: this.zoomFit,
      edgeViews,
      pendingD,
      nodeViews,
      picker,
      semantics,
      summaryMode,
      focusHint: (nodes.find((n) => n.zoom === "focus") || {}).title || false,
      exitFocus: () => this.exitFocus(),
      acpColor: acp.color,
      acpIcon: acp.icon,
      acpText: acp.text,
      acpAnim: acp.anim,
      model: s.model,
      setModel: (e) => {
        const names = {
          claude: "Claude Code",
          codex: "Codex",
          gemini: "Gemini CLI",
        };
        this.setState({ model: e.target.value });
        this.patchNodeAny("n2", {
          subtitle: names[e.target.value] + " · ACP v1",
        });
      },
      tokens: (s.tokens / 1000).toFixed(1) + "k",
      elapsed:
        Math.floor(s.elapsed / 60) +
        ":" +
        String(s.elapsed % 60).padStart(2, "0"),
      messages,
      ctxChips,
      draft: s.draft,
      setDraft: (e) => this.setState({ draft: e.target.value }),
      onDraftKey: (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          send();
        }
      },
      sendDraft: send,
      runOpacity: s.draft.trim() ? 1 : 0.55,
      agentRunning: s.agentRunning,
      stopAgent: () => {
        this.setState({
          agentRunning: false,
          messages: [
            ...s.messages,
            {
              id: Date.now(),
              kind: "assistant",
              text: "已停止。当前变更保留在 Diff 节点中。",
            },
          ],
        });
        this.patchNodeAny("n2", { status: "idle" });
      },
      connColor: conn.color,
      connIcon: conn.icon,
      connText,
      connAnim: conn.anim,
      pid: s.conn === "connected" ? s.pid : "—",
      termRef: this.termRef,
      termLines: s.termLines,
      termRunning: s.termRunning && s.conn === "connected",
      termIdle: !s.termRunning || s.conn !== "connected",
      termSummary,
      termStop: () => {
        this.setState({
          termRunning: false,
          termLines: [
            ...s.termLines,
            { text: "^C 已终止 (SIGINT)", color: "#E3B341" },
          ],
        });
        this.patchNodeAny("n5", { status: "idle" });
      },
      termReconnect: () => {
        this.setState({
          conn: "connecting",
          termLines: [
            ...s.termLines,
            { text: "— 正在重新连接 zsh 会话…", color: "#9DA1AB" },
          ],
        });
        this.patchNodeAny("n5", { status: "connecting" });
      },
      termRerun: () => {
        this.setState({ termRunning: true, termIdx: 0, termLines: [] });
        this.patchNodeAny("n5", { status: "running" });
      },
      termClear: () => this.setState({ termLines: [] }),
      diffFiles,
      diffFileCount: DIFF_FILES.length,
      diffAdd: DIFF_FILES.reduce((a, f) => a + f.add, 0),
      diffDel: DIFF_FILES.reduce((a, f) => a + f.del, 0),
      diffProgress: `已处理 ${decided}/${DIFF_FILES.length}`,
      diffAcceptAll: () => setAll("accepted"),
      diffRevertAll: () => setAll("reverted"),
      rescan: () => {},
      addDiffNode: () => {
        this.addNode("diff", {
          title: "扫描结果 · HEAD",
          subtitle: "3 个文件",
          status: "review",
        });
        this.setState({ modal: null });
      },
      sel,
      noSel: !sel,
      inspHint: sel ? "已选中" : "未选中",
      nodeCount: nodes.length,
      edgeCount: edges.length,
      overview,
      localText: s.gwOn ? "本地 + 网关" : "仅本地",
      statsText: `${nodes.filter((n) => n.status === "running").length} 个活动会话 · ${nodes.length} 个节点 · ${edges.length} 条连线`,
      modalNewWs: s.modal === "newws",
      modalSettings: s.modal === "settings",
      modalCmd: s.modal === "cmd",
      drawerDiff: s.modal === "diff",
      newWsName: nw.name,
      newWsPath: nw.path,
      setNewWsName: (e) => setNw({ name: e.target.value }),
      setNewWsPath: (e) => setNw({ path: e.target.value }),
      newWsPerms,
      newWsGwBg: nw.gw ? "var(--accent)" : "var(--faint)",
      newWsGwKnob: nw.gw ? 19 : 3,
      toggleNewWsGw: () => setNw({ gw: !nw.gw }),
      createWs: () => {
        const id = "w" + Date.now().toString(36);
        const name = nw.name.trim() || "新工作空间";
        const colors = ["#E0762E", "#1F9D64", "#2E7CF6", "#8A4FD6"];
        this.setState({
          ws: [
            ...s.ws,
            mkWs(
              id,
              name,
              nw.path.trim() || "~/code/" + name,
              colors[s.ws.length % 4],
              [emptyBoard("b0", "Default")],
            ),
          ],
          wsId: id,
          boardId: "b0",
          sel: null,
          modal: null,
          screen: "main",
          newWs: {
            name: "",
            path: "",
            perms: { read: true, write: true, exec: false },
            gw: true,
          },
        });
      },
      settingsTabs,
      stModels: s.settingsTab === "models",
      stAcp: s.settingsTab === "acp",
      stGateway: s.settingsTab === "gateway",
      stTheme: s.settingsTab === "theme",
      stKeys: s.settingsTab === "keys",
      providers,
      devices,
      themeOpts,
      shortcuts,
      cmdQuery: s.cmdQuery,
      setCmdQuery: (e) => this.setState({ cmdQuery: e.target.value }),
      cmdGroups,
    };
  }
  addBoard() {
    const W = this.ws();
    const id = "b" + Date.now().toString(36);
    this.setState({
      ws: this.state.ws.map((w) =>
        w.id !== W.id
          ? w
          : {
              ...w,
              boards: [
                ...w.boards,
                emptyBoard(id, "看板 " + (w.boards.length + 1)),
              ],
            },
      ),
      boardId: id,
      sel: null,
    });
  }
}
