import { describe, expect, it } from "vitest";

import { validateForm } from "./index.ts";
import { publicView, type PublicForm } from "./public-view.ts";
import type { FormSchema } from "./types.ts";

/**
 * C1 契约测试（计划 v1.1 §3.5 规则 3、附录 A.2）。
 *
 * 断言方式是「递归收集所有键」+「JSON 文本不含答案字样」两条一起上：
 * 前者抓结构泄露（新增敏感字段），后者抓序列化泄露（偷偷塞进别的键）。
 * 只做其中一条都会留缝。
 */

function collectKeys(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const element of value) {
      collectKeys(element, into);
    }
    return into;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, nested] of Object.entries(value)) {
      into.add(key);
      collectKeys(nested, into);
    }
  }
  return into;
}

/** 一份含全部 7 种字段、且每道题都带答案与解析的台账表单。 */
function ledgerForm(): unknown {
  return {
    meta: {
      version: 1,
      kind: "quiz",
      title: "极限与导数测验",
      objectives: [
        { id: "kp1", name: "极限的直观理解" },
        { id: "kp2", name: "导数定义" },
      ],
      totalScore: 10,
    },
    items: [
      {
        id: "q01",
        type: "single",
        title: "当 $x \\to 0$ 时 $\\sin x / x$ 的极限是？",
        score: 2,
        bloom: "remember",
        knowledgePoint: "kp1",
        options: [
          { id: "alpha-opt", text: "1" },
          { id: "beta-opt", text: "0" },
        ],
        answer: "alpha-opt",
        explanation: "重要极限，可用夹逼定理证明。",
      },
      {
        id: "q02",
        type: "multi",
        title: "下列哪些函数在 $x=0$ 处连续？",
        score: 3,
        bloom: "understand",
        knowledgePoint: "kp1",
        options: [
          { id: "alpha-opt", text: "$\\sin x$" },
          { id: "beta-opt", text: "$|x|$" },
          { id: "gamma-opt", text: "$1/x$" },
        ],
        answer: ["alpha-opt", "beta-opt"],
        explanation: "$1/x$ 在 0 处无定义。",
      },
      {
        id: "q03",
        type: "fill",
        title: "把 $x^2$ 的导数写成幂函数形式",
        score: 2,
        bloom: "apply",
        knowledgePoint: "kp2",
        answer: ["x-squared"],
      },
      {
        id: "q04",
        type: "number",
        title: "用差商近似 $f'(1)$，$h=0.01$ 时的值（保留两位）",
        score: 3,
        bloom: "apply",
        knowledgePoint: "kp2",
        answer: { value: 41.75, tolerance: 0.125 },
      },
      {
        id: "q05",
        type: "short",
        title: "用自己的话解释「导数就是瞬时变化率」",
        // 短答是收集型字段：没有 score/bloom/knowledgePoint（见 types.ts 分层）
        maxLength: 300,
      },
      {
        id: "q06",
        type: "scale",
        title: "本节内容我掌握得如何",
        min: 1,
        max: 5,
        labels: ["完全不同意", "完全同意"],
      },
      {
        id: "q07",
        type: "section",
        title: "第二部分：导数",
        description: "以下题目涉及导数的定义与计算。",
      },
    ],
  };
}

function buildView(): { form: FormSchema; view: PublicForm } {
  const result = validateForm(ledgerForm());
  if (!result.ok) {
    throw new Error(`测试表单本身不合法：${JSON.stringify(result.errors)}`);
  }
  return { form: result.data, view: publicView(result.data) };
}

describe("C1：publicView 不得泄露答案", () => {
  it("递归收集到的键里不存在 answer / explanation", () => {
    const { view } = buildView();
    const keys = collectKeys(view);
    expect(keys.has("answer")).toBe(false);
    expect(keys.has("explanation")).toBe(false);
  });

  it("序列化文本里既没有 answer 也没有 tolerance 这类答案形状", () => {
    const { view } = buildView();
    const text = JSON.stringify(view);
    expect(text).not.toContain('"answer"');
    expect(text).not.toContain('"explanation"');
    expect(text).not.toContain('"tolerance"');
  });

  it("答案取值本身也不出现在投影结果里", () => {
    const { view } = buildView();
    const text = JSON.stringify(view);
    // 选择题的 answer 必然是某个选项 id，与选项本身同形，无法用文本搜索区分；
    // 那类泄露靠上面的「键不出现」与「多选正确答案无法从结构推断」来保证。
    // 能用取值搜索抓住的是非选项型答案：填空文本、数值、容差。
    for (const secret of ["x-squared", "41.75", "0.125"]) {
      expect(text).not.toContain(secret);
    }
    // 选项本身必须保留，否则学生没法作答
    expect(text).toContain("beta-opt");
  });
});

describe("C1：publicView 保留学生作答所需的信息", () => {
  it("保留分值、层级、知识点（学生要看到评分口径）", () => {
    const { view } = buildView();
    const first = view.items[0];
    expect(first).toMatchObject({ id: "q01", score: 2, bloom: "remember", knowledgePoint: "kp1" });
  });

  it("保留选项文本、短答字数上限、量表锚点与分节描述", () => {
    const { view } = buildView();
    const byId = new Map(view.items.map((item) => [item.id, item]));
    expect(byId.get("q01")).toMatchObject({
      options: [
        { id: "alpha-opt", text: "1" },
        { id: "beta-opt", text: "0" },
      ],
    });
    expect(byId.get("q05")).toMatchObject({ maxLength: 300 });
    expect(byId.get("q06")).toMatchObject({ min: 1, max: 5, labels: ["完全不同意", "完全同意"] });
    expect(byId.get("q07")).toMatchObject({
      description: "以下题目涉及导数的定义与计算。",
    });
  });

  it("survey 投影后不带 totalScore", () => {
    const result = validateForm({
      meta: {
        version: 1,
        kind: "survey",
        title: "课前问卷",
        objectives: [{ id: "kp1", name: "学习习惯" }],
      },
      items: [
        {
          id: "s01",
          type: "scale",
          title: "每周自习时长",
          min: 1,
          max: 5,
        },
      ],
    });
    if (!result.ok) {
      throw new Error(`问卷测试数据不合法：${JSON.stringify(result.errors)}`);
    }
    const view = publicView(result.data);
    expect("totalScore" in view.meta).toBe(false);
  });
});

describe("C1：投影是纯函数", () => {
  it("不修改原表单，且字段数与顺序一致", () => {
    const { form, view } = buildView();
    const before = JSON.stringify(form);
    publicView(form);
    expect(JSON.stringify(form)).toBe(before);
    expect(view.items.map((item) => item.id)).toEqual(form.items.map((item) => item.id));
  });

  it("答案仍留在服务端对象上（剥离只发生在投影里）", () => {
    const { form } = buildView();
    const first = form.items[0];
    expect(first?.type).toBe("single");
    if (first?.type === "single") {
      expect(first.answer).toBe("alpha-opt");
    }
  });
});
