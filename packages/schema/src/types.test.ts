import { describe, expect, it } from "vitest";

import { LIMITS } from "./constants.ts";
import { formItemSchema, formSchema } from "./types.ts";

/** 一份结构合法的 quiz，各测试在它上面做单点破坏。 */
function validQuiz(): Record<string, unknown> {
  return {
    meta: {
      version: 1,
      kind: "quiz",
      title: "数据结构期中测验",
      objectives: [
        { id: "kp1", name: "二叉树的遍历" },
        { id: "kp2", name: "栈与队列" },
      ],
      totalScore: 10,
    },
    items: [
      { type: "section", id: "sec-01", title: "一、选择题" },
      {
        type: "single",
        id: "q-01",
        title: "中序遍历的顺序是？",
        required: true,
        score: 2,
        bloom: "remember",
        knowledgePoint: "kp1",
        options: [
          { id: "a", text: "左-根-右" },
          { id: "b", text: "根-左-右" },
        ],
        answer: "a",
      },
      {
        type: "multi",
        id: "q-02",
        title: "哪些是线性结构？",
        score: 2,
        bloom: "understand",
        knowledgePoint: "kp2",
        options: [
          { id: "a", text: "栈" },
          { id: "b", text: "队列" },
          { id: "c", text: "二叉树" },
        ],
        answer: ["a", "b"],
      },
      {
        type: "fill",
        id: "q-03",
        title: "栈的英文是 $\\text{stack}$，中文是 ____",
        score: 2,
        bloom: "apply",
        knowledgePoint: "kp2",
        answer: ["栈"],
      },
      {
        type: "number",
        id: "q-04",
        title: "二叉树的层数（含根）为 $\\log_2 8 + 1$",
        score: 2,
        bloom: "apply",
        knowledgePoint: "kp1",
        answer: { value: 4, tolerance: 0.01 },
      },
      {
        type: "short",
        id: "q-05",
        title: "简述栈与队列的区别",
        maxLength: 200,
      },
      {
        type: "scale",
        id: "q-06",
        title: "本节难度",
        min: 1,
        max: 5,
        labels: ["很简单", "很难"],
      },
    ],
  };
}

/** 深拷贝，避免测试之间互相污染。 */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe("FormSchema 结构校验（附录 A.1）", () => {
  it("合法 quiz 通过，且默认值被补齐", () => {
    const parsed = formSchema.parse(validQuiz());
    expect(parsed.meta.version).toBe(1);
    expect(parsed.items).toHaveLength(7);
    // required 未写的字段补 true
    const multi = parsed.items[2];
    expect(multi?.type).toBe("multi");
    expect(multi && "required" in multi ? multi.required : undefined).toBe(true);
  });

  it("short.maxLength 省略时落到 LIMITS.shortDefaultMaxLength", () => {
    const input = clone(validQuiz()) as { items: Record<string, unknown>[] };
    const short = input.items[5];
    expect(short).toBeDefined();
    delete short?.["maxLength"];
    const parsed = formSchema.parse(input);
    const item = parsed.items[5];
    expect(item?.type).toBe("short");
    expect(item && "maxLength" in item ? item.maxLength : undefined).toBe(
      LIMITS.shortDefaultMaxLength,
    );
  });

  it("未知字段类型被拒（不会静默当作 unknown 放行）", () => {
    const input = clone(validQuiz()) as { items: Record<string, unknown>[] };
    const item = input.items[1];
    if (item) item["type"] = "multiple";
    expect(formSchema.safeParse(input).success).toBe(false);
  });

  it("字段 id 必须 3–32 位小写标识", () => {
    const tooShort = clone(validQuiz()) as { items: Record<string, unknown>[] };
    const item = tooShort.items[1];
    if (item) item["id"] = "q1"; // 只有 2 位
    expect(formItemSchema.safeParse(tooShort.items[1]).success).toBe(false);

    const upper = clone(validQuiz()) as { items: Record<string, unknown>[] };
    const upperItem = upper.items[1];
    if (upperItem) upperItem["id"] = "Q-01";
    expect(formItemSchema.safeParse(upper.items[1]).success).toBe(false);
  });

  it("version 必须是字面量 1", () => {
    const input = clone(validQuiz()) as { meta: Record<string, unknown> };
    input.meta["version"] = 2;
    expect(formSchema.safeParse(input).success).toBe(false);
  });

  it("items 上限 100", () => {
    const input = validQuiz() as { items: unknown[] };
    const template = clone(input.items[5]);
    input.items = Array.from({ length: LIMITS.fieldsMax + 1 }, (_, i) => ({
      ...(template as Record<string, unknown>),
      id: `q-${String(i).padStart(3, "0")}`,
    }));
    const result = formSchema.safeParse(input);
    expect(result.success).toBe(false);
  });
});

describe("各字段类型的结构约束", () => {
  it("single 缺 answer 在结构层是合法的（附录 A 把它降级为语义规则）", () => {
    const input = clone(validQuiz()) as { items: Record<string, unknown>[] };
    delete input.items[1]?.["answer"];
    // 结构层必须放过：否则「survey 里不带答案的选择题」无法表达，
    // `E_ANSWER_MISSING` / `E_SURVEY_HAS_ANSWER` 就永远不会触发（审查问题 10）。
    // 真正的拒绝发生在 rules.ts：quiz 缺答案 → E_ANSWER_MISSING，survey 带答案 → E_SURVEY_HAS_ANSWER。
    expect(formSchema.safeParse(input).success).toBe(true);
  });

  it("选项数量必须 2–8（R4 的结构部分）", () => {
    const one = clone(validQuiz()) as { items: { options?: unknown[] }[] };
    const oneItem = one.items[1];
    if (oneItem) oneItem.options = [{ id: "a", text: "唯一选项" }];
    expect(formSchema.safeParse(one).success).toBe(false);

    const nine = clone(validQuiz()) as { items: { options?: unknown[] }[] };
    const nineItem = nine.items[1];
    if (nineItem) {
      nineItem.options = Array.from({ length: 9 }, (_, i) => ({ id: `o${i}`, text: `选项${i}` }));
    }
    expect(formSchema.safeParse(nine).success).toBe(false);
  });

  it("multi.answer 不能为空数组", () => {
    const input = clone(validQuiz()) as { items: Record<string, unknown>[] };
    const item = input.items[2];
    if (item) item["answer"] = [];
    expect(formSchema.safeParse(input).success).toBe(false);
  });

  it("number.tolerance 不能为负", () => {
    const input = clone(validQuiz()) as { items: Record<string, unknown>[] };
    const item = input.items[4];
    if (item) item["answer"] = { value: 4, tolerance: -1 };
    expect(formSchema.safeParse(input).success).toBe(false);
  });

  it("score 必须是 0–100 的整数", () => {
    const floatScore = clone(validQuiz()) as { items: Record<string, unknown>[] };
    const floatItem = floatScore.items[1];
    if (floatItem) floatItem["score"] = 2.5;
    expect(formSchema.safeParse(floatScore).success).toBe(false);

    const negative = clone(validQuiz()) as { items: Record<string, unknown>[] };
    const negativeItem = negative.items[1];
    if (negativeItem) negativeItem["score"] = -1;
    expect(formSchema.safeParse(negative).success).toBe(false);
  });

  it("bloom 只接受六个枚举值", () => {
    const input = clone(validQuiz()) as { items: Record<string, unknown>[] };
    const item = input.items[1];
    if (item) item["bloom"] = "remembering";
    expect(formSchema.safeParse(input).success).toBe(false);
  });

  it("scale.labels 必须是两个非空字符串", () => {
    const one = clone(validQuiz()) as { items: Record<string, unknown>[] };
    const oneItem = one.items[6];
    if (oneItem) oneItem["labels"] = ["只有一端"];
    expect(formSchema.safeParse(one).success).toBe(false);

    const empty = clone(validQuiz()) as { items: Record<string, unknown>[] };
    const emptyItem = empty.items[6];
    if (emptyItem) emptyItem["labels"] = ["", "很难"];
    expect(formSchema.safeParse(empty).success).toBe(false);
  });

  it("scale 的 max 必须大于 min（顶层 superRefine）", () => {
    const input = clone(validQuiz()) as { items: Record<string, unknown>[] };
    const item = input.items[6];
    if (item) {
      item["min"] = 5;
      item["max"] = 5;
    }
    const result = formSchema.safeParse(input);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.join(".") === "items.6.max")).toBe(true);
    }
  });

  it("survey 只含收集型字段时结构通过", () => {
    const survey = {
      meta: {
        version: 1,
        kind: "survey",
        title: "课程反馈",
        objectives: [{ id: "kp1", name: "课程体验" }],
      },
      items: [
        { type: "short", id: "q-01", title: "还有什么建议", maxLength: 300 },
        { type: "scale", id: "q-02", title: "整体满意度", min: 1, max: 5 },
      ],
    };
    expect(formSchema.safeParse(survey).success).toBe(true);
  });
});
