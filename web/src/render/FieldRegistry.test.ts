import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { FormItem } from "@intentform/schema";

import { EditField } from "./FieldRegistry";

/**
 * 回归：单选答案行的选项文本必须走 `MathText`。
 *
 * 之前这里直接把 `option.text` 插进 JSX，`答案：b（$2x-1=7$）` 会把美元符原样
 * 显示出来，教师看到的是一条没渲染的公式。SSR 足够抓这个缺陷：KaTeX 输出里有
 * `katex` 类名，而原始 `$...$` 不应再出现在答案行里。
 */
describe("EditField 的公式渲染", () => {
  it("单选答案行把选项里的 LaTeX 渲染成 KaTeX，不显示原始 $...$", () => {
    const item = {
      id: "q_math",
      type: "single",
      title: "解方程 $2x-1=7$，$x$ 等于多少？",
      required: true,
      score: 5,
      options: [
        { id: "a", text: "$x=3$" },
        { id: "b", text: "$x=4$" },
      ],
      answer: "b",
    } as const satisfies FormItem;

    const markup = renderToStaticMarkup(createElement(EditField, { item }));

    expect(markup).toContain("katex");
    expect(markup).not.toContain("$2x-1=7$");
    expect(markup).not.toContain("$x=4$");
  });

  it("多问题干保留换行，不被 HTML 折成一行", () => {
    const item = {
      id: "q_short",
      type: "short",
      title: "已知函数 $f(x)=x^2$。\n（1）求单调区间；\n（2）若 $f(a)=1$，求 $a$。",
      required: true,
      score: 18,
      maxLength: 200,
    } as const satisfies FormItem;

    const markup = renderToStaticMarkup(createElement(EditField, { item }));

    // 换行必须落成 `<br />`：只靠 CSS 的 `pre-line` 在打印与导出路径上不可断言。
    expect(markup).toContain("whitespace-pre-line");
    expect(markup).toContain("<br/>（1）");
    expect(markup).toContain("<br/>（2）");
  });

  it("填空答案里的公式走 MathText：带 $ 的与裸 LaTeX 都不显示源码", () => {
    const item = {
      id: "q_fill",
      type: "fill",
      title: "求导数。",
      required: true,
      score: 10,
      answer: ["$-F'(s)$", "-\\frac{d}{ds}F(s)"],
    } as const satisfies FormItem;

    const markup = renderToStaticMarkup(createElement(EditField, { item }));

    // 两段答案各自渲染出一个 KaTeX 块；原始 TeX 只留在 MathML 的 annotation 里，
    // 不在可见文本中，所以这里数 katex 块而不是 grep 源码。
    expect(markup.match(/class="katex"/gu)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(markup).not.toContain("$-F'(s)$");
  });
});
