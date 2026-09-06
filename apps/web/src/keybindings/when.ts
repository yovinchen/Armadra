/**
 * `when` 条件：一条绑定在什么情况下才算数。
 *
 * 起因是同一个组合键在不同地方本来就该做不同的事。⌘R 在浏览器节点里是
 * 「刷新这一页」，在别处什么也不该是；F12 只在编辑器里是「跳到定义」。
 * 以前只有 `allowInTerminal` / `allowWhileTyping` 两个布尔位，够表达
 * 「终端里放不放行」，不够表达「只在编辑器里」。
 *
 * 语法是 VS Code 那一套的一个**真子集**，够用而且能穷举：
 *
 * ```
 * expr       := or
 * or         := and ('||' and)*
 * and        := unary ('&&' unary)*
 * unary      := '!' unary | primary
 * primary    := '(' expr ')' | comparison | ident
 * comparison := ident ('==' | '!=') word
 * ```
 *
 * 没有正则匹配、没有 `in`、没有任意字符串字面量——这三样都会让「两条绑定
 * 的条件能不能同时成立」变成不可判定的问题，而冲突检测正需要那个答案
 * （见 [`whenContexts`] 与 `settings/keymap.ts` 的 `keymapConflicts`）。
 *
 * 解析失败一律返回「永远为假」而不是「永远为真」：一个看不懂的条件意味着
 * 这条绑定不该在任何地方触发，宁可少触发一次，也不要在不该生效的地方抢走
 * 用户按给别人的键。
 */

/** 求值上下文。值只有布尔与短字符串两种，这样才能穷举。 */
export type WhenContext = Record<string, boolean | string>;

/** 上下文里认得的键。写错的键求值为假，不会静默变成真。 */
export const WHEN_KEYS = [
  /** 焦点在 xterm 终端里。 */
  "terminalFocus",
  /** 焦点在编辑器节点的代码区里。 */
  "editorFocus",
  /** 焦点在浏览器节点的画面里。 */
  "browserFocus",
  /** 焦点既不在上面三处，也不在任何输入控件里——也就是画布本身。 */
  "canvasFocus",
  /** 焦点在输入框 / textarea / contenteditable 里（终端与编辑器另算）。 */
  "editing",
  /** `mac` / `windows` / `linux`。 */
  "platform",
] as const;

export type WhenKey = (typeof WHEN_KEYS)[number];

type Node =
  | { kind: "const"; value: boolean }
  | { kind: "ref"; name: string }
  | { kind: "not"; value: Node }
  | { kind: "and"; left: Node; right: Node }
  | { kind: "or"; left: Node; right: Node }
  | { kind: "eq"; name: string; word: string; negated: boolean };

const FALSE: Node = { kind: "const", value: false };

const TOKEN = /^(&&|\|\||==|!=|[!()]|[A-Za-z_][\w.-]*)/;

function tokenize(source: string): string[] | null {
  const tokens: string[] = [];
  let rest = source.trim();
  while (rest.length > 0) {
    const match = TOKEN.exec(rest);
    // 一个不认识的字符就作废整条：半懂不懂地求值比不求值更危险。
    if (!match) return null;
    tokens.push(match[1]!);
    rest = rest.slice(match[1]!.length).trimStart();
  }
  return tokens;
}

/**
 * 把一条表达式解析成可求值的树。语法错误返回 `null`。
 *
 * 结果会被缓存：这些表达式是模块级常量，一个应用生命周期里会被求值几万次
 * （每一次 keydown × 每一条命令），重复解析同一个字符串没有意义。
 */
const cache = new Map<string, Node>();

function parse(source: string): Node {
  const cached = cache.get(source);
  if (cached) return cached;
  const tokens = tokenize(source);
  const node = tokens ? parseTokens(tokens) : null;
  const result = node ?? FALSE;
  cache.set(source, result);
  return result;
}

function parseTokens(tokens: string[]): Node | null {
  let index = 0;

  function peek() {
    return tokens[index];
  }
  function take() {
    return tokens[index++];
  }

  function primary(): Node | null {
    const token = take();
    if (token === undefined) return null;
    if (token === "(") {
      const inner = or();
      if (!inner || take() !== ")") return null;
      return inner;
    }
    if (token === "!") {
      const value = primary();
      return value && { kind: "not", value };
    }
    if (!/^[A-Za-z_]/.test(token)) return null;
    const operator = peek();
    if (operator === "==" || operator === "!=") {
      take();
      const word = take();
      if (word === undefined || !/^[A-Za-z_]/.test(word)) return null;
      return { kind: "eq", name: token, word, negated: operator === "!=" };
    }
    return { kind: "ref", name: token };
  }

  function and(): Node | null {
    let left = primary();
    while (left && peek() === "&&") {
      take();
      const right = primary();
      if (!right) return null;
      left = { kind: "and", left, right };
    }
    return left;
  }

  function or(): Node | null {
    let left = and();
    while (left && peek() === "||") {
      take();
      const right = and();
      if (!right) return null;
      left = { kind: "or", left, right };
    }
    return left;
  }

  const node = or();
  // 剩下没消费完的 token 说明这条表达式本身有问题，例如 `a b`。
  return node && index === tokens.length ? node : null;
}

function run(node: Node, context: WhenContext): boolean {
  switch (node.kind) {
    case "const":
      return node.value;
    case "ref":
      return context[node.name] === true;
    case "not":
      return !run(node.value, context);
    case "and":
      return run(node.left, context) && run(node.right, context);
    case "or":
      return run(node.left, context) || run(node.right, context);
    case "eq": {
      const equal = context[node.name] === node.word;
      return node.negated ? !equal : equal;
    }
  }
}

/**
 * 这条条件在这个上下文里成不成立。
 *
 * 空条件（`undefined` / 空串）成立：绝大多数命令没有条件，那不是「条件为假」。
 */
export function evaluateWhen(
  expression: string | undefined,
  context: WhenContext,
): boolean {
  if (!expression || expression.trim() === "") return true;
  return run(parse(expression), context);
}

/** 这条条件写得对不对——设置页据此提示，而不是默默把它当成假。 */
export function isValidWhen(expression: string | undefined): boolean {
  if (!expression || expression.trim() === "") return true;
  const tokens = tokenize(expression);
  return tokens !== null && parseTokens(tokens) !== null;
}

/** 表达式引用了哪些上下文键（含写错的），设置页用来标出未知键。 */
export function whenReferences(expression: string | undefined): string[] {
  if (!expression) return [];
  const found = new Set<string>();
  const walk = (node: Node) => {
    switch (node.kind) {
      case "ref":
      case "eq":
        found.add(node.name);
        return;
      case "not":
        return walk(node.value);
      case "and":
      case "or":
        walk(node.left);
        return walk(node.right);
      case "const":
    }
  };
  walk(parse(expression));
  return [...found];
}

/**
 * 每一种可能的上下文，穷举。
 *
 * 冲突检测要回答的是「这两条绑定的条件有没有可能同时成立」。因为语法里没有
 * 字符串字面量与正则，键的取值集合是有限且已知的，所以这个问题可以**精确**
 * 回答——枚举全部组合，看有没有一种让两边都为真。
 *
 * 焦点几个键写成互斥的五选一而不是五个独立布尔：焦点在同一时刻只有一处，
 * 把 `terminalFocus && editorFocus` 当成可能会凭空造出并不存在的冲突。
 */
export function whenContexts(): WhenContext[] {
  const contexts: WhenContext[] = [];
  const focuses = [
    null,
    "terminalFocus",
    "editorFocus",
    "browserFocus",
    "canvasFocus",
  ] as const;
  for (const platform of ["mac", "windows", "linux"]) {
    for (const focus of focuses) {
      for (const editing of [false, true]) {
        // 画布本身没有输入控件可以打字，终端里的打字由 `terminalFocus` 表达。
        if (editing && (focus === "canvasFocus" || focus === "terminalFocus"))
          continue;
        const context: WhenContext = { platform, editing };
        for (const key of focuses) if (key) context[key] = key === focus;
        contexts.push(context);
      }
    }
  }
  return contexts;
}

/** 两条条件有没有可能同时成立。都为空时当然会。 */
export function whenOverlaps(
  left: string | undefined,
  right: string | undefined,
): boolean {
  if (!left && !right) return true;
  return whenContexts().some(
    (context) => evaluateWhen(left, context) && evaluateWhen(right, context),
  );
}
