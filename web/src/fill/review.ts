/**
 * 提交后答案解析的显示口径（省赛附加 A-18）：纯函数，可单测。
 *
 * 三条与判分一致的规矩：
 * 1. 客观题的对错**只显示服务端给的** `correct`，前端不从答案自己比一遍——
 *    第二套判定口径迟早会和成绩对不上；
 * 2. 简答与量表没有对错，显示「待老师批改」而不是「错误」；
 * 3. 没作答的题显示「未作答」，不是空白——空白会让人以为界面坏了。
 */

import type { SubmitReviewItem } from "@intentform/schema";

export const REVIEW_PENDING_TEXT = "待老师批改" as const;
export const REVIEW_EMPTY_ANSWER_TEXT = "未作答" as const;

export type ReviewTone = "correct" | "wrong" | "pending";

export function reviewTone(item: SubmitReviewItem): ReviewTone {
  if (item.correct === null) return "pending";
  return item.correct ? "correct" : "wrong";
}

export function reviewStatusText(item: SubmitReviewItem): string {
  switch (reviewTone(item)) {
    case "correct":
      return "正确";
    case "wrong":
      return "错误";
    case "pending":
      return REVIEW_PENDING_TEXT;
  }
}

/** Tailwind 文本色的类名；映射保持在一处，组件不自己拼 `text-success`。 */
export function reviewToneClass(item: SubmitReviewItem): string {
  switch (reviewTone(item)) {
    case "correct":
      return "text-success";
    case "wrong":
      return "text-danger";
    case "pending":
      return "text-muted";
  }
}

export function reviewGivenText(item: SubmitReviewItem): string {
  return item.given === "" ? REVIEW_EMPTY_ANSWER_TEXT : item.given;
}

/** 没有标准答案（简答/量表）时返回 `null`，界面据此不渲染「正确答案」那一行。 */
export function reviewExpectedText(item: SubmitReviewItem): string | null {
  return item.expected === "" ? null : item.expected;
}
