import { describe, expect, it } from "vitest";

import type { PublicFormItem } from "@intentform/schema";

import { EMPTY_ANSWERS, type AnswerState } from "./answers";
import { collectMissingRequired, hasMissingRequired } from "./validate";
import { quizView } from "./__fixtures__/public-form";

const ITEMS: readonly PublicFormItem[] = quizView().form.items;

describe("collectMissingRequired", () => {
  it("全空的卷子：两道必答按题号列出（item-single 第 1 题、item-fill 第 3 题）", () => {
    const missing = collectMissingRequired(ITEMS, EMPTY_ANSWERS);
    expect(missing.map((entry) => entry.fieldId)).toEqual(["item-single", "item-fill"]);
    // 题号只在可作答项里计数：section 不占号，所以填空是第 3 题而不是第 4 题。
    expect(missing.map((entry) => entry.position)).toEqual([1, 3]);
    expect(missing[0]?.title).toBe("下列哪个是质数？");
  });

  it("必答项填了就消失，选填项空着不影响", () => {
    const answers: AnswerState = { "item-single": "b" };
    expect(collectMissingRequired(ITEMS, answers).map((entry) => entry.fieldId)).toEqual([
      "item-fill",
    ]);
  });

  it("空白输入不算作答（不静默放行）", () => {
    const answers: AnswerState = { "item-single": "   ", "item-fill": "" };
    expect(collectMissingRequired(ITEMS, answers)).toHaveLength(2);
  });

  it("全部补齐即无缺", () => {
    const answers: AnswerState = { "item-single": "b", "item-fill": "12 ／ 8" };
    expect(collectMissingRequired(ITEMS, answers)).toEqual([]);
    expect(hasMissingRequired(ITEMS, answers)).toBe(false);
  });

  it("顺序与表单顺序一致（学生从上往下补题）", () => {
    const many: readonly PublicFormItem[] = [
      { id: "req-a", type: "single", title: "A", required: true, options: [{ id: "a", text: "1" }, { id: "b", text: "2" }] },
      { id: "req-b", type: "number", title: "B", required: true },
      { id: "req-c", type: "short", title: "C", required: true, maxLength: 10 },
    ];
    const missing = collectMissingRequired(many, EMPTY_ANSWERS);
    expect(missing.map((entry) => entry.fieldId)).toEqual(["req-a", "req-b", "req-c"]);
    expect(missing.map((entry) => entry.position)).toEqual([1, 2, 3]);
  });
});

describe("hasMissingRequired", () => {
  it("有缺项即为真（提交按钮据此进入 blocked 分支）", () => {
    expect(hasMissingRequired(ITEMS, EMPTY_ANSWERS)).toBe(true);
  });
});
