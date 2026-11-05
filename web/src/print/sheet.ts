/**
 * 打印版考卷的视图模型（省赛附加 A-17）：纯函数，无 React。
 *
 * 两件事必须在纯函数里做对，界面只负责画：
 * 1. **题号只数题目**：分节是标题，不占题号；否则「第 2 题」会和卷面题号对不上。
 * 2. **答案默认不出现**：`withAnswers` 为假时，行里连 `answer` 字段都没有——
 *    不是靠 CSS 藏起来。渲染层拿不到答案，就不可能"不小心打印出答案"。
 *
 * 选项字母用 A、B、C…（超过 26 个用 A1、B1 兜底）：印刷体里题号+字母比 `op1` 好认。
 */

import type { FormItem, FormSchema } from "@intentform/schema";

export interface PrintOption {
  readonly letter: string;
  readonly text: string;
}

export interface PrintSectionRow {
  readonly kind: "section";
  readonly id: string;
  readonly title: string;
  readonly description?: string;
}

export interface PrintQuestionRow {
  readonly kind: "question";
  readonly id: string;
  readonly no: number;
  readonly type: FormItem["type"];
  readonly title: string;
  readonly options: readonly PrintOption[];
  readonly score?: number;
  /** 只有 `withAnswers` 为真时才存在。 */
  readonly answer?: string;
  readonly explanation?: string;
}

export type PrintRow = PrintSectionRow | PrintQuestionRow;

/** 0 → A，25 → Z，26 → A1（超过 26 个选项时兜底，不抛错也不重复）。 */
export function optionLetter(index: number): string {
  const base = String.fromCharCode(65 + (index % 26));
  return index < 26 ? base : `${base}${String(Math.floor(index / 26))}`;
}

function optionTextOf(
  item: Extract<FormItem, { type: "single" | "multi" }>,
  ids: readonly string[],
): string {
  return ids
    .map((id) => item.options.find((option) => option.id === id)?.text ?? id)
    .join("、");
}

/** 标准答案的可读文本；简答/量表没有标准答案，返回空串（不伪填）。 */
function answerTextOf(item: FormItem): string {
  switch (item.type) {
    case "single":
      return item.answer === undefined ? "" : optionTextOf(item, [item.answer]);
    case "multi":
      return item.answer === undefined ? "" : optionTextOf(item, item.answer);
    case "fill":
      return item.answer === undefined ? "" : item.answer.join("／");
    case "number":
      return item.answer === undefined ? "" : String(item.answer.value);
    case "short":
    case "scale":
    case "section":
      return "";
  }
}

export function buildPrintSheet(
  schema: FormSchema,
  options: { readonly withAnswers: boolean },
): readonly PrintRow[] {
  const rows: PrintRow[] = [];
  let no = 0;
  for (const item of schema.items) {
    if (item.type === "section") {
      rows.push({
        kind: "section",
        id: item.id,
        title: item.title,
        ...(item.description === undefined ? {} : { description: item.description }),
      });
      continue;
    }
    no += 1;
    const base: PrintQuestionRow = {
      kind: "question",
      id: item.id,
      no,
      type: item.type,
      title: item.title,
      options:
        item.type === "single" || item.type === "multi"
          ? item.options.map((option, index) => ({ letter: optionLetter(index), text: option.text }))
          : [],
      ...("score" in item && item.score !== undefined ? { score: item.score } : {}),
    };
    if (!options.withAnswers) {
      rows.push(base);
      continue;
    }
    const answer = answerTextOf(item);
    const explanation = "explanation" in item ? item.explanation : undefined;
    rows.push({
      ...base,
      ...(answer === "" ? {} : { answer }),
      ...(explanation === undefined ? {} : { explanation }),
    });
  }
  return rows;
}

/** 卷面抬头：`初二数学 · 二次函数随堂测 · 满分 30 分`；问卷不写满分。 */
export function printHeaderText(schema: FormSchema): string {
  const kindLabel = schema.meta.kind === "survey" ? "问卷" : "测验";
  const total = schema.meta.totalScore;
  return total === undefined ? kindLabel : `${kindLabel} · 满分 ${String(total)} 分`;
}
