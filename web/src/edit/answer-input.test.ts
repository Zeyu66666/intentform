/**
 * `answer-input.ts` 的测试：Schema ⇄ 面板草稿的转换。
 *
 * 这一层不碰 DOM，也不做业务校验（校验在 `patch-plan` 里，因为它要报题号）。
 * 这里只钉住两件事：**形状转换不丢信息**、**人话标签不露 id**。
 */

import { describe, expect, it } from "vitest";

import type { AnswerPayload, FormItem } from "@intentform/schema";

import {
  answerDraftOf,
  answerDraftOfPayload,
  answerLabel,
  supportsAnswer,
  toAnswerPayload,
} from "./answer-input";

const SINGLE: FormItem = {
  id: "q-single",
  type: "single",
  title: "下列哪个是质数？",
  required: true,
  options: [
    { id: "a", text: "9" },
    { id: "b", text: "11" },
  ],
  answer: "b",
  score: 5,
};

const MULTI: FormItem = {
  id: "q-multi",
  type: "multi",
  title: "选出所有质数",
  required: true,
  options: [
    { id: "a", text: "9" },
    { id: "b", text: "11" },
    { id: "c", text: "13" },
  ],
  answer: ["b", "c"],
  score: 5,
};

const FILL: FormItem = {
  id: "q-fill",
  type: "fill",
  title: "填两个质数",
  required: true,
  answer: ["11", "13"],
  score: 5,
};

const NUMBER: FormItem = {
  id: "q-number",
  type: "number",
  title: "圆周率取三位",
  required: true,
  answer: { value: 2.75, tolerance: 0.25 },
  score: 5,
};

describe("supportsAnswer", () => {
  it("只有四种自动判分题型能编辑答案", () => {
    expect(supportsAnswer(SINGLE)).toBe(true);
    expect(supportsAnswer(MULTI)).toBe(true);
    expect(supportsAnswer(FILL)).toBe(true);
    expect(supportsAnswer(NUMBER)).toBe(true);
    expect(
      supportsAnswer({
        id: "q-short",
        type: "short",
        title: "说说理由",
        required: true,
        maxLength: 200,
        score: 10,
      }),
    ).toBe(false);
    expect(
      supportsAnswer({ id: "q-scale", type: "scale", title: "难度", required: true, min: 1, max: 5 }),
    ).toBe(false);
    expect(supportsAnswer({ id: "q-section", type: "section", title: "第二部分" })).toBe(false);
  });
});

describe("answerDraftOf", () => {
  it("选择题答案转成可编辑草稿", () => {
    expect(answerDraftOf(SINGLE)).toEqual({ type: "single", id: "b" });
    expect(answerDraftOf(MULTI)).toEqual({ type: "multi", ids: ["b", "c"] });
  });

  it("填空一行一个空；数值保留原文", () => {
    expect(answerDraftOf(FILL)).toEqual({ type: "fill", blanks: ["11", "13"] });
    expect(answerDraftOf(NUMBER)).toEqual({ type: "number", value: "2.75", tolerance: "0.25" });
  });

  it("没有答案时给出可渲染的空草稿，而不是 null", () => {
    const bare: FormItem = {
      id: "q-bare",
      type: "number",
      title: "还没写答案",
      required: true,
      score: 5,
    };
    expect(answerDraftOf(bare)).toEqual({ type: "number", value: "", tolerance: "0" });
  });

  it("无答案题型返回 null", () => {
    expect(
      answerDraftOf({ id: "q-short", type: "short", title: "简答", required: true, maxLength: 200, score: 10 }),
    ).toBeNull();
  });
});

describe("toAnswerPayload", () => {
  it("草稿转回契约载荷，填空去首尾空白", () => {
    expect(toAnswerPayload({ type: "single", id: "a" })).toEqual({ type: "single", answer: "a" });
    expect(toAnswerPayload({ type: "multi", ids: ["a", "c"] })).toEqual({
      type: "multi",
      answer: ["a", "c"],
    });
    expect(toAnswerPayload({ type: "fill", blanks: [" 11 ", "13 "] })).toEqual({
      type: "fill",
      answer: ["11", "13"],
    });
    expect(toAnswerPayload({ type: "number", value: "2.5", tolerance: "0.1" })).toEqual({
      type: "number",
      answer: { value: 2.5, tolerance: 0.1 },
    });
  });

  it("数字解析失败保留 NaN，交给 patch-plan 报错，不静默当 0", () => {
    const payload = toAnswerPayload({ type: "number", value: "", tolerance: "abc" });
    expect(payload.type).toBe("number");
    if (payload.type !== "number") return;
    expect(Number.isNaN(payload.answer.value)).toBe(true);
    expect(Number.isNaN(payload.answer.tolerance)).toBe(true);
  });
});

describe("answerDraftOfPayload / toAnswerPayload 往返", () => {
  it("四种载荷往返不丢信息", () => {
    const payloads: readonly AnswerPayload[] = [
      { type: "single", answer: "b" },
      { type: "multi", answer: ["b", "c"] },
      { type: "fill", answer: ["11", "13"] },
      { type: "number", answer: { value: 2.75, tolerance: 0.25 } },
    ];
    for (const payload of payloads) {
      expect(toAnswerPayload(answerDraftOfPayload(payload))).toEqual(payload);
    }
  });
});

describe("answerLabel", () => {
  it("用选项文字，不把内部 id 给教师看", () => {
    expect(answerLabel(SINGLE, { type: "single", answer: "b" })).toBe("11");
    expect(answerLabel(MULTI, { type: "multi", answer: ["b", "c"] })).toBe("11、13");
  });

  it("填空用顿号类分隔；数值带容差时才写 ±", () => {
    expect(answerLabel(FILL, { type: "fill", answer: ["11", "13"] })).toBe("11／13");
    expect(answerLabel(NUMBER, { type: "number", answer: { value: 2.75, tolerance: 0.25 } })).toBe(
      "2.75 ± 0.25",
    );
    expect(answerLabel(NUMBER, { type: "number", answer: { value: 3, tolerance: 0 } })).toBe("3");
  });

  it("指向已删选项时退回 id：宁可难看，也不假装选项还在", () => {
    expect(answerLabel(SINGLE, { type: "single", answer: "z" })).toBe("z");
  });
});
