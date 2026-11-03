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
});
