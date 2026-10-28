/**
 * 追问表单的纯状态（省赛 R-05）。
 *
 * 组件只负责画；「点了什么变成什么答案」全在这里，单测钉得住。
 */

import { describe, expect, it } from "vitest";

import type { ClarifyQuestion } from "@intentform/schema";

import {
  EMPTY_DRAFTS,
  answerOf,
  answeredCount,
  buildClarifications,
  setCustom,
  toggleOption,
} from "./clarify-model";

const COUNT: ClarifyQuestion = {
  slot: "count",
  question: "大概出多少道题？",
  options: ["5 题", "10 题"],
  placeholder: "例如：12 题",
};

const TYPES: ClarifyQuestion = {
  slot: "types",
  question: "题目类型要哪些？（可多选）",
  options: ["单选", "多选", "填空"],
  placeholder: "例如：单选 + 简答",
};

describe("toggleOption", () => {
  it("单选槽位：点另一个就换掉，再点同一个就清空", () => {
    const first = toggleOption(EMPTY_DRAFTS, "count", "5 题");
    expect(answerOf(first, "count")).toBe("5 题");
    const second = toggleOption(first, "count", "10 题");
    expect(answerOf(second, "count")).toBe("10 题");
    const cleared = toggleOption(second, "count", "10 题");
    expect(answerOf(cleared, "count")).toBe("");
  });

  it("题型槽位可多选，按点选顺序用顿号连接", () => {
    const one = toggleOption(EMPTY_DRAFTS, "types", "单选");
    const two = toggleOption(one, "types", "填空");
    expect(answerOf(two, "types")).toBe("单选、填空");
    const off = toggleOption(two, "types", "单选");
    expect(answerOf(off, "types")).toBe("填空");
  });

  it("不修改入参（状态更新是替换，不是原地改）", () => {
    const before = answerOf(EMPTY_DRAFTS, "count");
    toggleOption(EMPTY_DRAFTS, "count", "5 题");
    expect(answerOf(EMPTY_DRAFTS, "count")).toBe(before);
  });
});

describe("setCustom", () => {
  it("手填内容优先于点选", () => {
    const picked = toggleOption(EMPTY_DRAFTS, "count", "5 题");
    const typed = setCustom(picked, "count", "12 题");
    expect(answerOf(typed, "count")).toBe("12 题");
  });

  it("手填清空后回到点选内容", () => {
    const picked = toggleOption(EMPTY_DRAFTS, "count", "5 题");
    const cleared = setCustom(picked, "count", "   ");
    expect(answerOf(cleared, "count")).toBe("5 题");
  });
});

describe("buildClarifications / answeredCount", () => {
  it("只带上真正问过的槽位，空回答不进请求", () => {
    const drafts = toggleOption(EMPTY_DRAFTS, "count", "10 题");
    expect(buildClarifications([COUNT, TYPES], drafts)).toEqual([
      { slot: "count", answer: "10 题" },
    ]);
  });

  it("一条都没答：返回空数组，界面走「跳过」等价路径", () => {
    expect(buildClarifications([COUNT, TYPES], EMPTY_DRAFTS)).toEqual([]);
    expect(answeredCount([COUNT, TYPES], EMPTY_DRAFTS)).toBe(0);
  });

  it("answeredCount 只数问过的槽位", () => {
    const drafts = toggleOption(toggleOption(EMPTY_DRAFTS, "count", "10 题"), "types", "单选");
    expect(answeredCount([COUNT], drafts)).toBe(1);
  });
});
