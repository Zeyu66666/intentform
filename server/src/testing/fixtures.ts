/**
 * 测试用的两份表单（一份 quiz、一份 survey）。
 *
 * 刻意做小：每个字段类型只出现一次，判分的每个分支都能被指名道姓地测到。
 * 字段 id 都满足 `LIMITS.idPattern`（3–32 位小写字母/数字/`_`/`-`），
 * 这样测试通过时也顺带证明了 id 约束没被绕过。
 */

import { formSchema, type FormSchema } from "@intentform/schema";

/** quiz：5 个自动判分题共 20 分 + 1 道不计分的简答 + 1 个分节。 */
export function quizSchema(): FormSchema {
  return formSchema.parse({
    meta: {
      version: 1,
      kind: "quiz",
      title: "判分测试卷",
      objectives: [{ id: "kp-a", name: "知识点 A" }],
      totalScore: 20,
    },
    items: [
      { id: "sec-main", type: "section", title: "第一大题" },
      {
        id: "q-single",
        type: "single",
        title: "单选",
        required: true,
        score: 5,
        bloom: "remember",
        knowledgePoint: "kp-a",
        explanation: "因为 A",
        options: [
          { id: "op1", text: "选项一" },
          { id: "op2", text: "选项二" },
        ],
        answer: "op1",
      },
      {
        id: "q-multi",
        type: "multi",
        title: "多选",
        required: true,
        score: 5,
        bloom: "understand",
        knowledgePoint: "kp-a",
        explanation: "因为 AC",
        options: [
          { id: "op1", text: "选项一" },
          { id: "op2", text: "选项二" },
          { id: "op3", text: "选项三" },
        ],
        answer: ["op1", "op3"],
      },
      {
        id: "q-fill",
        type: "fill",
        title: "填空（两个空）",
        required: true,
        score: 5,
        bloom: "apply",
        knowledgePoint: "kp-a",
        explanation: "因为 2 和 x",
        answer: ["2", "x"],
      },
      {
        id: "q-number",
        type: "number",
        title: "数值题",
        required: true,
        score: 5,
        bloom: "apply",
        knowledgePoint: "kp-a",
        explanation: "因为 3.14",
        answer: { value: 3.14, tolerance: 0.01 },
      },
      {
        id: "q-short",
        type: "short",
        title: "简答题（不自动判分）",
        required: false,
        maxLength: 100,
      },
    ],
  });
}

/** survey：只有收集字段，没有任何 `answer`/`score`。 */
export function surveySchema(): FormSchema {
  return formSchema.parse({
    meta: { version: 1, kind: "survey", title: "反馈测试表", objectives: [] },
    items: [
      { id: "sec-fb", type: "section", title: "反馈" },
      { id: "s-short", type: "short", title: "收获", required: true, maxLength: 200 },
      { id: "s-scale", type: "scale", title: "作业量", required: true, min: 1, max: 5 },
    ],
  });
}

/**
 * quiz + 带分值的简答（省赛 R-01/R-02 的批改测试用）。
 *
 * 不复用 `quizSchema()` 直接把简答改成 5 分，是因为**满分必须同步改**（20 → 25）：
 * 只改题不改 `totalScore` 会先被 R6 拦下，测试就会变成"验证校验器"，而不是验证批改。
 */
export function scoredShortQuizSchema(): FormSchema {
  const base = quizSchema();
  return formSchema.parse({
    ...base,
    meta: { ...base.meta, totalScore: 25 },
    items: base.items.map((item) =>
      item.type === "short" ? { ...item, score: 5 } : item,
    ),
  });
}

/** 沿用 `createFormRequestSchema` 的形状，省得每个测试各写一遍。 */
export function createFormBody(
  kind: "quiz" | "survey" = "quiz",
  schema?: FormSchema,
): Record<string, unknown> {
  const resolved = schema ?? (kind === "quiz" ? quizSchema() : surveySchema());
  return { title: resolved.meta.title, kind, schema: resolved };
}
