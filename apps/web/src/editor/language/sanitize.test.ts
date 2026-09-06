import { describe, expect, it } from "vitest";

import { sanitizeHTML } from "./sanitize";

/**
 * hover 的 Markdown 渲染出来的 HTML（设计 §1.1、§3.4）。
 *
 * server 跑在用户自己的机器上，但它答的是**项目文件里的正文**，而项目可能
 * 是刚 clone 下来的。所以这里按白名单渲染。
 */
describe("hover HTML", () => {
  it("keeps the formatting a doc comment actually uses", () => {
    const html = sanitizeHTML(
      '<p>Reads a file. <code class="tok-keyword">async</code></p><pre><code>x = 1</code></pre>',
    );
    expect(html).toContain('<code class="tok-keyword">async</code>');
    expect(html).toContain("<pre><code>x = 1</code></pre>");
  });

  it("removes a script entirely, code and all", () => {
    const html = sanitizeHTML("<p>ok</p><script>alert(1)</script>");
    expect(html).toBe("<p>ok</p>");
  });

  it("keeps the text of a tag it does not allow", () => {
    // 整段吞掉会让人以为 server 没回答，而 server 其实回答了。
    expect(sanitizeHTML("<iframe>inner</iframe>")).toBe("inner");
  });

  it("drops event handlers and any attribute off the list", () => {
    const html = sanitizeHTML('<p onclick="steal()" data-x="1">hi</p>');
    expect(html).toBe("<p>hi</p>");
  });

  it("drops a link that is not http(s), mailto or in-workspace", () => {
    expect(sanitizeHTML('<a href="javascript:alert(1)">x</a>')).toBe(
      "<a>x</a>",
    );
    expect(sanitizeHTML('<a href="data:text/html,<b>">x</a>')).toBe("<a>x</a>");
    expect(sanitizeHTML('<a href="https://example.com">x</a>')).toContain(
      'href="https://example.com"',
    );
    expect(sanitizeHTML('<a href="armadra:///src/main.py">x</a>')).toContain(
      'href="armadra:///src/main.py"',
    );
  });
});
