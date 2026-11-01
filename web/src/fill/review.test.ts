import { describe, expect, it } from "vitest";

import type { SubmitReviewItem } from "@intentform/schema";

import {
  REVIEW_EMPTY_ANSWER_TEXT,
  REVIEW_PENDING_TEXT,
  reviewExpectedText,
  reviewGivenText,
  reviewStatusText,
  reviewTone,
  reviewToneClass,
} from "./review";

function item(partial: Partial<SubmitReviewItem> & Pick<SubmitReviewItem, "itemId">): SubmitReviewItem {
  return {
    title: "单选题",
    type: "single",
    given: "甲",
    correct: true,
    expected: "甲",
    ...partial,
  };
}

describe("reviewTone", () => {
  it("correct 为 null 是「待批改」，不是错误", () => {
    expect(reviewTone(item({ itemId: "a", correct: true }))).toBe("correct");
    expect(reviewTone(item({ itemId: "b", correct: false }))).toBe("wrong");
    expect(reviewTone(item({ itemId: "c", correct: null }))).toBe("pending");
  });

  it("三态各有文案，待批改与错误分开写", () => {
    expect(reviewStatusText(item({ itemId: "a" }))).toBe("正确");
    expect(reviewStatusText(item({ itemId: "b", correct: false }))).toBe("错误");
    expect(reviewStatusText(item({ itemId: "c", correct: null }))).toBe(REVIEW_PENDING_TEXT);
    expect(REVIEW_PENDING_TEXT).not.toBe("错误");
  });

  it("颜色类名由纯函数给出，组件不自己拼", () => {
    expect(reviewToneClass(item({ itemId: "a" }))).toBe("text-success");
    expect(reviewToneClass(item({ itemId: "b", correct: false }))).toBe("text-danger");
    expect(reviewToneClass(item({ itemId: "c", correct: null }))).toBe("text-muted");
  });
});

describe("reviewGivenText", () => {
  it("没作答显示「未作答」，不留空白", () => {
    expect(reviewGivenText(item({ itemId: "a", given: "" }))).toBe(REVIEW_EMPTY_ANSWER_TEXT);
    expect(reviewGivenText(item({ itemId: "b", given: "选项一、选项三" }))).toBe("选项一、选项三");
  });
});

describe("reviewExpectedText", () => {
  it("没有标准答案返回 null（界面不渲染那一行），而不是空串", () => {
    expect(reviewExpectedText(item({ itemId: "a", expected: "" }))).toBeNull();
    expect(reviewExpectedText(item({ itemId: "b", expected: "3.14" }))).toBe("3.14");
  });
});
