/**
 * 答案编辑的纯函数（P18）：Schema 里的答案 ⇄ 面板上的输入草稿。
 *
 * 分成这一层，是因为四种题型的答案形状差得很远（字符串 / 字符串数组 / 两个空 /
 * 数值 + 容差），而面板只应该关心"怎么显示、怎么收字符串"。转换与「人话标签」
 * 都放在这里，`patch-plan` 与 `ItemEditor` 不各写一遍。
 */

import type { AnswerPayload, FormItem } from "@intentform/schema";

/** 面板持有的答案草稿：数字也先留原文，解析失败就是 `NaN`，不静默当 0。 */
export type AnswerDraft =
  | { readonly type: "single"; readonly id: string }
  | { readonly type: "multi"; readonly ids: readonly string[] }
  | { readonly type: "fill"; readonly blanks: readonly string[] }
  | { readonly type: "number"; readonly value: string; readonly tolerance: string };

/** 这道题能不能编辑答案（只有四种自动判分题型）。 */
export function supportsAnswer(item: FormItem): boolean {
  return item.type === "single" || item.type === "multi" || item.type === "fill" || item.type === "number";
}

/** Schema → 草稿。没有答案时给出"空"的草稿（而不是 `null`），面板才能正常渲染输入框。 */
export function answerDraftOf(item: FormItem): AnswerDraft | null {
  switch (item.type) {
    case "single":
      return { type: "single", id: item.answer ?? "" };
    case "multi":
      return { type: "multi", ids: item.answer ?? [] };
    case "fill":
      return { type: "fill", blanks: item.answer ?? [""] };
    case "number":
      return {
        type: "number",
        value: item.answer === undefined ? "" : String(item.answer.value),
        tolerance: item.answer === undefined ? "0" : String(item.answer.tolerance),
      };
    case "short":
    case "scale":
    case "section":
      return null;
  }
}

/** 契约载荷 → 草稿（草稿里存的是载荷，面板要的是可编辑形状）。 */
export function answerDraftOfPayload(payload: AnswerPayload): AnswerDraft {
  switch (payload.type) {
    case "single":
      return { type: "single", id: payload.answer };
    case "multi":
      return { type: "multi", ids: payload.answer };
    case "fill":
      return { type: "fill", blanks: payload.answer };
    case "number":
      return {
        type: "number",
        value: String(payload.answer.value),
        tolerance: String(payload.answer.tolerance),
      };
  }
}

/** 草稿 → 契约载荷。空值在这里不校验，校验在 `patch-plan` 里做（它要报具体题号）。 */
export function toAnswerPayload(draft: AnswerDraft): AnswerPayload {
  switch (draft.type) {
    case "single":
      return { type: "single", answer: draft.id };
    case "multi":
      return { type: "multi", answer: [...draft.ids] };
    case "fill":
      return { type: "fill", answer: draft.blanks.map((blank) => blank.trim()) };
    case "number":
      return {
        type: "number",
        // `Number("")` 是 0：空输入必须当"没填"，不能静默变成正确答案 0。
        answer: {
          value: draft.value.trim() === "" ? Number.NaN : Number(draft.value),
          tolerance: draft.tolerance.trim() === "" ? Number.NaN : Number(draft.tolerance),
        },
      };
  }
}

/** 答案的人话版本（差异/摘要用）：选项显示文字，不显示 id。 */
export function answerLabel(item: FormItem, payload: AnswerPayload): string {
  const optionText = (id: string): string => {
    if (item.type === "single" || item.type === "multi") {
      return item.options.find((option) => option.id === id)?.text ?? id;
    }
    return id;
  };
  switch (payload.type) {
    case "single":
      return optionText(payload.answer);
    case "multi":
      return payload.answer.map(optionText).join("、");
    case "fill":
      return payload.answer.join("／");
    case "number":
      return payload.answer.tolerance === 0
        ? String(payload.answer.value)
        : `${String(payload.answer.value)} ± ${String(payload.answer.tolerance)}`;
  }
}
