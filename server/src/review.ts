/**
 * 提交后答案解析（省赛附加 A-18）：把「学生答了什么、对不对、标准答案是什么」
 * 整理成可渲染的列表。
 *
 * 三条口径与 grading 保持同一：
 * 1. 对错判定只走 `judgeItem`——与判分、逐题统计是**同一个函数**，不另写一套；
 * 2. 简答与量表没有对错，`correct` 固定 `null`，不伪填 `false`；
 * 3. 选项题的「你的答案 / 正确答案」都换成选项文字，学生看 id 没有意义。
 *
 * 是否调用它由 `form_settings.show_answers_after_submit` 决定（默认关闭），
 * 本模块只是纯函数，不做开关判断——开关属于路由与展示策略。
 */

import type { FormItem, FormSchema, SubmitReviewItem } from "@intentform/schema";

import { isJudgeableItem, judgeItem, type AnswerValue } from "./grading.ts";

/** 多空的填空题在提交侧用全角「／」切分，回看也用同一个分隔符显示。 */
const BLANK_SEPARATOR = "／";

function optionLabel(item: Extract<FormItem, { type: "single" | "multi" }>, id: string): string {
  const option = item.options.find((candidate) => candidate.id === id);
  // 找不到选项（旧版答案引用了已删除的选项）时原样显示 id：
  // 显示「（未知选项）」会让教师以为学生答了个不存在的东西，而实际是改版后的孤儿引用。
  return option?.text ?? id;
}

/** 标准答案的可读文本；简答/量表没有答案，返回空串。 */
function expectedText(item: FormItem): string {
  switch (item.type) {
    case "single":
      return item.answer === undefined ? "" : optionLabel(item, item.answer);
    case "multi":
      return item.answer === undefined
        ? ""
        : item.answer.map((id) => optionLabel(item, id)).join("、");
    case "fill":
      return item.answer === undefined ? "" : item.answer.join(BLANK_SEPARATOR);
    case "number":
      return item.answer === undefined ? "" : String(item.answer.value);
    case "short":
    case "scale":
    case "section":
      return "";
  }
}

function givenText(item: FormItem, value: AnswerValue | undefined): string {
  if (value === undefined) return "";
  switch (item.type) {
    case "single":
      return typeof value === "string" ? optionLabel(item, value) : "";
    case "multi": {
      const ids = Array.isArray(value) ? value : [value];
      return ids.map((id) => optionLabel(item, id)).join("、");
    }
    case "fill": {
      const segments = Array.isArray(value) ? value : [value];
      return segments.join(BLANK_SEPARATOR);
    }
    case "number":
    case "short":
    case "scale":
      // `Array.isArray` 收窄不到 `readonly string[]`（TS 的已知局限），
      // 与 `analytics-route.ts` 的 `cellOf` 用同一条显式分支代替强转。
      return typeof value === "string" ? value : value.join(BLANK_SEPARATOR);
    case "section":
      return "";
  }
}

/** 这道题的对错。客观题未作答按「未答对」计（与逐题统计的分母口径一致）。 */
function correctnessOf(item: FormItem, value: AnswerValue | undefined): boolean | null {
  if (!isJudgeableItem(item) || item.answer === undefined) return null;
  if (value === undefined) return false;
  return judgeItem(item, value);
}

export function buildSubmitReview(
  schema: FormSchema,
  answers: Readonly<Record<string, AnswerValue>>,
): readonly SubmitReviewItem[] {
  const review: SubmitReviewItem[] = [];
  for (const item of schema.items) {
    if (item.type === "section") continue;
    const value = answers[item.id];
    const explanation = "explanation" in item ? item.explanation : undefined;
    review.push({
      itemId: item.id,
      title: item.title,
      type: item.type,
      given: givenText(item, value),
      correct: correctnessOf(item, value),
      expected: expectedText(item),
      ...(explanation === undefined ? {} : { explanation }),
    });
  }
  return review;
}
