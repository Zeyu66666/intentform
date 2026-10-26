import { describe, expect, it } from "vitest";

import {
  EMPTY_ANSWERS,
  answerReducer,
  isAnswerable,
  isAnswered,
  selectedValues,
  stringValue,
  type AnswerAction,
  type AnswerState,
} from "./answers";
import { quizView } from "./__fixtures__/public-form";

function run(actions: readonly AnswerAction[]): AnswerState {
  return actions.reduce<AnswerState>(answerReducer, EMPTY_ANSWERS);
}

describe("answerReducer", () => {
  it("单选/量表：后一次选择覆盖前一次", () => {
    const state = run([
      { type: "choose", fieldId: "item-single", value: "a" },
      { type: "choose", fieldId: "item-single", value: "b" },
    ]);
    expect(state["item-single"]).toBe("b");
    expect(stringValue(state, "item-single")).toBe("b");
  });

  it("多选：勾选追加、再勾取消；取消到空则删掉整个键", () => {
    const two = run([
      { type: "toggle", fieldId: "item-multi", optionId: "a" },
      { type: "toggle", fieldId: "item-multi", optionId: "c" },
    ]);
    expect(selectedValues(two, "item-multi")).toEqual(["a", "c"]);

    const one = answerReducer(two, { type: "toggle", fieldId: "item-multi", optionId: "a" });
    expect(selectedValues(one, "item-multi")).toEqual(["c"]);

    const none = answerReducer(one, { type: "toggle", fieldId: "item-multi", optionId: "c" });
    // 关键不变量：空集合不留下 `[]`，否则必答校验会把它当成"已作答"。
    expect(Object.hasOwn(none, "item-multi")).toBe(false);
    expect(isAnswered(none["item-multi"])).toBe(false);
  });

  it("文本：清空即删键；输入中间态（含空格）原样保留，不被 trim 改写", () => {
    const typed = run([{ type: "type", fieldId: "item-fill", value: "8 ／ " }]);
    expect(typed["item-fill"]).toBe("8 ／ ");
    expect(stringValue(typed, "item-fill")).toBe("8 ／ ");

    const cleared = answerReducer(typed, { type: "type", fieldId: "item-fill", value: "" });
    expect(Object.hasOwn(cleared, "item-fill")).toBe(false);
  });

  it("不动其他字段（改一道题不影响另一道）", () => {
    const before = run([
      { type: "choose", fieldId: "item-single", value: "a" },
      { type: "type", fieldId: "item-number", value: "3.14" },
    ]);
    const after = answerReducer(before, { type: "type", fieldId: "item-short", value: "因为…" });
    expect(after["item-single"]).toBe("a");
    expect(after["item-number"]).toBe("3.14");
    expect(after["item-short"]).toBe("因为…");
  });
});

describe("isAnswered", () => {
  it("空白字符串算没作答，非空算作答", () => {
    expect(isAnswered(undefined)).toBe(false);
    expect(isAnswered("")).toBe(false);
    expect(isAnswered("   ")).toBe(false);
    expect(isAnswered("0")).toBe(true);
  });

  it("数组里只要有一个非空白项就算作答", () => {
    expect(isAnswered([])).toBe(false);
    expect(isAnswered(["", "  "])).toBe(false);
    expect(isAnswered(["", " x "])).toBe(true);
  });
});

describe("取值辅助", () => {
  it("类型不符时降级成空值，不把数组塞进文本框", () => {
    const state: AnswerState = { "item-multi": ["a"], "item-single": "b" };
    expect(stringValue(state, "item-multi")).toBe("");
    expect(selectedValues(state, "item-single")).toEqual([]);
  });
});

describe("isAnswerable", () => {
  it("section 不是题目，不参与作答", () => {
    for (const item of quizView().form.items) {
      expect(isAnswerable(item)).toBe(item.type !== "section");
    }
  });
});
