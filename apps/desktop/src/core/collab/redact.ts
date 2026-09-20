/**
 * 跨 Agent 读取前的那一遍密钥脱敏（设计 `agent-delivery.md` §13）。
 *
 * 纯函数，没有 I/O，也没有状态：输入一段文本，输出同一段文本，凡是长得像凭据
 * 的那几串换成 {@link REDACTED}。
 *
 * ## 为什么在这一层，而不是在转录渲染里
 *
 * 一个 Agent 读自己的转录是它自己的事——那些密钥本来就是它打出来的。跨过一条
 * 连线读**别人**的东西才是新事：对方的 `.env`、对方 `export` 出来的那一行、对
 * 方终端上回滚过去的一个 `Authorization:` 头，都会因为一次 `context transcript`
 * 落进读者的上下文，而读者的上下文会被它自己写进日志、发给模型提供方、甚至再
 * 被第三个 Agent 读一遍。所以这道闸挂在「跨连线读取」这一个动作上，
 * `context-link.ts` 的每条出口都过一遍。
 *
 * ## 为什么是模式匹配，而不是熵检测
 *
 * 熵检测会把 base64 的图片数据、哈希、UUID 全判成密钥，把一份转录切得读不成
 * 句子。这里宁可漏也不愿错杀：漏掉一个自造格式的 token，损失是它照旧被读到
 * （和今天一样）；错杀一段代码，损失是读者看不懂对方在干什么，而那正是它来读
 * 的理由。
 *
 * 表驱动：{@link PATTERNS} 每一项是一条规则，用例逐条覆盖。加一种凭据就是加一
 * 行，不是改一个函数。
 */

/** 被换掉的那几串都变成这个词。中文，因为读它的是模型，它要读懂发生了什么。 */
export const REDACTED = "[已脱敏]";

/** 一条脱敏规则：认哪种凭据，以及怎么换。 */
export interface RedactionRule {
  /** 规则名，用例与排错时看得见。 */
  readonly name: string;
  readonly pattern: RegExp;
  /**
   * 换成什么。省略时整段换成 {@link REDACTED}；`KEY=值` 那种要留下键名，所以
   * 它给一个函数。
   */
  readonly replace?: (match: string, ...groups: string[]) => string;
}

/**
 * `.env` 风格那一条要认的键名后缀。
 *
 * 只认这几个，而且只在值长于 16 个字符时才动手：`API_KEY=short` 多半是占位
 * 符，而 `PATH=/usr/bin:…` 这种正常得很的赋值不该因为名字里有个 `KEY` 就被吃
 * 掉——所以匹配的是**后缀**（`_KEY` 而不是 `KEY`），`PASSWORD` 除外，它本身
 * 就是一个完整的键名。
 */
const ENV_KEY = String.raw`[A-Za-z0-9]{1,64}(?:_TOKEN|_SECRET|_KEY)|PASSWORD`;

export const PATTERNS: readonly RedactionRule[] = [
  // PEM 块整段拿掉。放在最前面：块里面还会命中别的规则，先换成一个词最干净。
  {
    name: "private-key-block",
    pattern:
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  },
  // 没有结尾的那种：转录里被截断过的块，同样不该留下前半截。
  {
    name: "private-key-open",
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*/g,
  },
  {
    name: "github-token",
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}/g,
  },
  { name: "github-pat", pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/g },
  { name: "openai-key", pattern: /\bsk-[A-Za-z0-9_-]{16,}/g },
  { name: "aws-access-key", pattern: /\bAKIA[0-9A-Z]{12,}/g },
  { name: "slack-token", pattern: /\bxox[abpsr]-[A-Za-z0-9-]{8,}/g },
  {
    name: "bearer",
    pattern: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/g,
    replace: (_match, scheme) => `${scheme} ${REDACTED}`,
  },
  {
    name: "env-assignment",
    pattern: new RegExp(
      String.raw`\b(${ENV_KEY})(\s*[:=]\s*)(['"]?)([^\s'"]{17,})\3`,
      "g",
    ),
    replace: (_match, key, separator, quote) =>
      `${key}${separator}${quote}${REDACTED}${quote}`,
  },
];

/**
 * 一段文本脱敏后的样子。
 *
 * 规则按 {@link PATTERNS} 的顺序依次跑，所以先换掉的那些不会再被后面的规则
 * 二次匹配（`[已脱敏]` 本身不含任何规则认得的形状）。
 */
export function redact(text: string): string {
  let out = text;
  for (const rule of PATTERNS) {
    const replace = rule.replace;
    if (replace === undefined) {
      out = out.replace(rule.pattern, REDACTED);
      continue;
    }
    out = out.replace(rule.pattern, (...args: unknown[]): string => {
      // `replace` 的回调尾部是 `offset` 与整段原文，捕获组在它们之前。
      const groups = args.slice(1, -2) as string[];
      return replace(args[0] as string, ...groups);
    });
  }
  return out;
}

/** 这段文本里有没有东西被换掉。用例与回复的那句提示都用它。 */
export function wasRedacted(original: string, redacted: string): boolean {
  return original !== redacted;
}
