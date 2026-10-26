import { describe, expect, it } from "vitest";

import { checkLatex, findFormulas } from "./latex.ts";
import { validateForm } from "./index.ts";

describe("findFormulas", () => {
  it("提取行内公式并标记为非块级", () => {
    const segments = findFormulas("当 $x \\to 0$ 时，$\\sin x / x \\to 1$");
    expect(segments).toHaveLength(2);
    expect(segments[0]?.body).toBe("x \\to 0");
    expect(segments[0]?.display).toBe(false);
    expect(segments[1]?.body).toBe("\\sin x / x \\to 1");
  });

  it("提取块级公式并标记为块级", () => {
    const segments = findFormulas("如下：$$\\int_0^1 x dx = \\frac{1}{2}$$");
    expect(segments).toHaveLength(1);
    expect(segments[0]?.body).toBe("\\int_0^1 x dx = \\frac{1}{2}");
    expect(segments[0]?.display).toBe(true);
  });

  it("忽略转义的美元符", () => {
    expect(findFormulas("价格是 \\$5，不是 $x$ 公式")).toHaveLength(1);
    expect(findFormulas("\\$5 与 \\$8")).toHaveLength(0);
  });

  it("没有公式时返回空数组", () => {
    expect(findFormulas("这是一段纯中文题干，没有任何公式。")).toEqual([]);
  });

  it("给出公式在原文中的位置", () => {
    const text = "前缀 $a$ 后缀";
    expect(findFormulas(text)[0]?.offset).toBe(text.indexOf("$a$"));
  });
});

describe("checkLatex", () => {
  it("合法公式返回 null", () => {
    expect(checkLatex("求 $\\frac{1}{2}$ 与 $$\\sqrt{x}$$ 的值")).toBeNull();
  });

  it("未定义的命令会被 KaTeX 拒绝，并指出是哪条公式", () => {
    const reason = checkLatex("求 $\\broken{x}$ 的极限");
    expect(reason).not.toBeNull();
    expect(reason).toContain("行内公式");
    expect(reason).toContain("无法被 KaTeX 解析");
  });

  it("块级公式的失败也能报出来", () => {
    const reason = checkLatex("$$\\frac{1}{$$");
    expect(reason).toContain("块级公式");
  });

  it("纯文本没有公式时不报错", () => {
    expect(checkLatex("无限循环小数")).toBeNull();
  });
});

describe("barrel 装配", () => {
  it("从包入口拿到的 validateForm 默认已接上 KaTeX（R7 不会静默跳过）", () => {
    const form = {
      meta: {
        version: 1,
        kind: "quiz",
        title: "公式题",
        objectives: [{ id: "kp1", name: "极限" }],
        totalScore: 10,
      },
      items: [
        {
          id: "q01",
          type: "fill",
          title: "计算 $\\broken{x}$",
          score: 10,
          bloom: "apply",
          knowledgePoint: "kp1",
          answer: ["0"],
        },
      ],
    };
    const result = validateForm(form);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((error) => error.code)).toContain("E_LATEX_INVALID");
    }
  });

  it("合法公式的表单可以通过装配后的校验", () => {
    const form = {
      meta: {
        version: 1,
        kind: "quiz",
        title: "公式题",
        objectives: [{ id: "kp1", name: "积分" }],
        totalScore: 10,
      },
      items: [
        {
          id: "q01",
          type: "fill",
          title: "计算 $\\int_0^1 2x\\,dx$",
          score: 10,
          bloom: "apply",
          knowledgePoint: "kp1",
          answer: ["1"],
        },
      ],
    };
    expect(validateForm(form).ok).toBe(true);
  });
});
