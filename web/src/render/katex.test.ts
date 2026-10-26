import { describe, expect, it } from "vitest";

import { containsMath, renderMathToHtml, splitMath } from "./katex";

describe("splitMath", () => {
  it("切出文本 / 公式片段，保留顺序", () => {
    expect(splitMath("求 $x^2$ 的最小值")).toEqual([
      { kind: "text", text: "求 " },
      { kind: "math", tex: "x^2" },
      { kind: "text", text: " 的最小值" },
    ]);
  });

  it("一行里多个公式", () => {
    const segments = splitMath("$a$ 与 $b$");
    expect(segments.filter((segment) => segment.kind === "math")).toHaveLength(2);
  });

  it("$...$ 里的下划线与反斜杠不被吃掉（LaTeX 原样传给 KaTeX）", () => {
    const segments = splitMath("$\\frac{a}{b}_{i}$");
    expect(segments[0]).toEqual({ kind: "math", tex: "\\frac{a}{b}_{i}" });
  });

  it("落单的 $ 当普通文本（不猜）", () => {
    expect(splitMath("价格 5$ 起")).toEqual([{ kind: "text", text: "价格 5$ 起" }]);
  });

  it("空公式 $$ 当普通文本", () => {
    expect(splitMath("空 $$ 公式")).toEqual([{ kind: "text", text: "空 $$ 公式" }]);
  });

  it("跨行的 $ 不配对（行内公式不跨行）", () => {
    expect(splitMath("$x\ny$")).toEqual([{ kind: "text", text: "$x\ny$" }]);
  });

  it("\\$ 转义成字面美元符", () => {
    expect(splitMath("\\$5 和 \\$6")).toEqual([{ kind: "text", text: "$5 和 $6" }]);
  });

  it("纯文本原样返回，不产生空片段", () => {
    expect(splitMath("没有公式")).toEqual([{ kind: "text", text: "没有公式" }]);
    expect(splitMath("")).toEqual([]);
  });
});

describe("renderMathToHtml", () => {
  it("合法公式渲染出 KaTeX HTML", () => {
    const html = renderMathToHtml("x^2+1");
    expect(html).not.toBeNull();
    expect(html).toContain("katex");
    expect(html).toContain("</span>");
  });

  it("语法错误不抛错，返回 null 交给降级（白屏比红色错误标记更糟）", () => {
    expect(renderMathToHtml("\\frac{")).toBeNull();
    expect(renderMathToHtml("\\undefinedcommand{x}")).toBeNull();
  });

  it("空公式返回 null", () => {
    expect(renderMathToHtml("   ")).toBeNull();
  });

  it("trust:false —— \\href 不生成链接，降级为纯文本", () => {
    const html = renderMathToHtml("\\href{javascript:alert(1)}{click}");
    // 要么拒绝（null），要么不含可用链接；两者都不能出现 javascript: 协议。
    if (html !== null) expect(html).not.toContain("javascript:");
  });

  it("displayMode 输出块级公式", () => {
    const inline = renderMathToHtml("x");
    const block = renderMathToHtml("x", { displayMode: true });
    expect(inline).not.toBeNull();
    expect(block).not.toBeNull();
    expect(block).toContain("katex-display");
    expect(inline).not.toContain("katex-display");
  });
});

describe("containsMath", () => {
  it("有公式 / 无公式", () => {
    expect(containsMath("$x$")).toBe(true);
    expect(containsMath("纯文本")).toBe(false);
    expect(containsMath("落单 $ 符号")).toBe(false);
  });
});
