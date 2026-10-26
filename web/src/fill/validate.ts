/**
 * 必答校验（纯函数）。
 *
 * 为什么前端也要校验一遍：服务端不信前端，前端也不该把"少填一道必答题"
 * 当成一次网络往返。学生在地铁里点提交，等五秒才被告知漏了一题，是很差的体验。
 * 两道校验各自独立：这里只负责"给出未填项清单"，不负责拒绝提交——
 * 服务端仍是唯一裁决者（它还会拒绝未知字段 id）。
 *
 * 明确**不做**的事：不做静默放行。`collectMissingRequired` 返回非空清单时，
 * 调用方必须把它们列出来（`fill/StudentPage.tsx` 的提交按钮上方），
 * 而不是"帮学生把空的必答项剔掉再交上去"。
 */

import type { PublicFormItem } from "@intentform/schema";

import { isAnswerable, isAnswered, type AnswerState } from "./answers";

export interface MissingField {
  /** 字段 id：用来把焦点/高亮定位到具体题目。 */
  readonly fieldId: string;
  /** 第几题（只在可作答项里计数，`section` 不占号）。 */
  readonly position: number;
  /** 题干原文，作为纯文本显示（不解析 LaTeX，清单只求可读）。 */
  readonly title: string;
}

export function collectMissingRequired(
  items: readonly PublicFormItem[],
  answers: AnswerState,
): readonly MissingField[] {
  const missing: MissingField[] = [];
  let position = 0;

  for (const item of items) {
    if (!isAnswerable(item)) continue;
    position += 1;
    if (item.required && !isAnswered(answers[item.id])) {
      missing.push({ fieldId: item.id, position, title: item.title });
    }
  }

  return missing;
}

/** 只判"能不能提交"，不产出清单：提交按钮的禁用态用它。 */
export function hasMissingRequired(items: readonly PublicFormItem[], answers: AnswerState): boolean {
  return collectMissingRequired(items, answers).length > 0;
}
