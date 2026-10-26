/**
 * 学生页测试用的公开视图夹具。
 *
 * 文件不以 `.test.ts` 结尾，所以 vitest 不会把它当测试收集（`vitest.config.ts`
 * 的 include 只认 `*.test.ts`）；但它仍被 `tsconfig.json` 的 src 下全部 `.ts` 覆盖，
 * 类型照样受严格模式检查。
 *
 * 夹具里**故意没有** `answer` / `explanation` / `bloom` / `knowledgePoint`：
 * 这不是偷懒，而是 `PublicFormItem` 的类型就装不下它们（`public-view.ts` 的
 * 白名单投影）。测试若想验"答案不泄露"，靠的是这条类型，不是在这里少写几个字段。
 */

import type { FillViewResponse, PublicForm } from "@intentform/schema";

const QUIZ_FORM: PublicForm = {
  meta: { version: 1, kind: "quiz", title: "第一单元小测", totalScore: 20 },
  items: [
    { id: "sec-intro", type: "section", title: "第一部分：基础", description: "共 3 题" },
    {
      id: "item-single",
      type: "single",
      title: "下列哪个是质数？",
      required: true,
      options: [
        { id: "a", text: "9" },
        { id: "b", text: "11" },
      ],
      score: 5,
    },
    {
      id: "item-multi",
      type: "multi",
      title: "选出所有偶数",
      required: false,
      options: [
        { id: "a", text: "2" },
        { id: "b", text: "3" },
        { id: "c", text: "4" },
      ],
      score: 5,
    },
    { id: "item-fill", type: "fill", title: "8 + 4 = ？ 12 - 4 = ？", required: true, score: 5 },
    { id: "item-number", type: "number", title: "圆周率取两位小数", required: false, score: 5 },
    { id: "item-short", type: "short", title: "说说你的解法", required: false, maxLength: 200 },
    {
      id: "item-scale",
      type: "scale",
      title: "这道题难吗",
      required: false,
      min: 1,
      max: 5,
      labels: ["简单", "很难"],
    },
  ],
};

export function quizView(): FillViewResponse {
  return {
    ok: true,
    formId: "form-1",
    versionId: "ver-2",
    versionN: 2,
    slug: "abc123",
    form: QUIZ_FORM,
  };
}

export function surveyView(): FillViewResponse {
  return {
    ok: true,
    formId: "form-2",
    versionId: "ver-1",
    versionN: 1,
    slug: "survey1",
    form: { meta: { version: 1, kind: "survey", title: "课后反馈" }, items: QUIZ_FORM.items },
  };
}
