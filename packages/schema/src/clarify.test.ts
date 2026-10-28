/**
 * 意图澄清的槽位检测（省赛 R-05）。
 *
 * 这些用例是**规则的说明书**：什么算「说了题量」、问卷为什么不用问分值、
 * 三条预置需求为什么一个追问都不能有。改规则先改这里，再改 `clarify.ts`。
 */

import { describe, expect, it } from "vitest";

import {
  CLARIFY_MAX_QUESTIONS,
  buildClarifyQuestions,
  composeRequirement,
  describeClarifications,
  detectMissingSlots,
} from "./clarify.ts";
import { GENERATE_PRESETS } from "./presets.ts";

describe("detectMissingSlots", () => {
  it("含糊需求：题量、分值、题型都算缺（场景能认出是卷子）", () => {
    // 「英语」是学科词：已经点了题，就不再问「考什么知识点」。
    expect(detectMissingSlots("帮我出一份英语卷子")).toEqual(["count", "score", "types"]);
  });

  it("连场景都没有的，排在最前面", () => {
    expect(detectMissingSlots("给我做一份表单")).toEqual([
      "scene",
      "count",
      "score",
      "types",
      "knowledge",
    ]);
  });

  it("问卷不问分值，也不问知识点（收集页没有这两种东西）", () => {
    expect(detectMissingSlots("做个问卷")).toEqual(["count", "types"]);
  });

  it("三条预置需求一个槽位都不缺", () => {
    // 预置需求是回放 fixture 的键。任何一条被判成「缺槽位」都会让演示流程
    // 在点下按钮后先弹三个问题——那等于把预置路径改坏了。
    for (const preset of GENERATE_PRESETS) {
      expect(detectMissingSlots(preset.requirement)).toEqual([]);
    }
  });

  it("「每题 N 分」也算给了分值（不必非得写总分）", () => {
    expect(detectMissingSlots("出 5 道单选题，每题 4 分")).not.toContain("score");
  });

  it("中文数字题量也算给了题量", () => {
    expect(detectMissingSlots("出十道判断题")).not.toContain("count");
    expect(detectMissingSlots("出两道简答题")).not.toContain("count");
  });

  it("书名号里的章节名算知识点（「《二次函数》」不用再问考什么）", () => {
    expect(
      detectMissingSlots("出一份二次函数随堂测：单选、填空、数值和简答各一道，共 20 分"),
    ).toContain("knowledge");
    expect(
      detectMissingSlots("出一份《二次函数》随堂测：单选、填空、数值和简答各一道，共 20 分"),
    ).not.toContain("knowledge");
  });

  it("「分钟」不是分值（避免把时长当成满分）", () => {
    // 只有一个「分」字时判有分值会把「限时 30 分钟」当成总分；
    // 反过来只认「总分/满分/共 N 分」又会漏掉「每题 5 分」。
    // 规则取后者+「N 分」，并显式排除「分钟」。
    expect(detectMissingSlots("限时 30 分钟的小测")).toContain("score");
  });
});

describe("buildClarifyQuestions", () => {
  it("最多 3 个，按优先级取前三个", () => {
    const questions = buildClarifyQuestions("给我做一份表单");
    expect(questions).toHaveLength(CLARIFY_MAX_QUESTIONS);
    expect(questions.map((question) => question.slot)).toEqual(["scene", "count", "score"]);
  });

  it("每问都有一句人话，题量与总分带可点选项", () => {
    const questions = buildClarifyQuestions("帮我出一份英语卷子");
    for (const question of questions) {
      expect(question.question.length).toBeGreaterThan(4);
      expect(Array.isArray(question.options)).toBe(true);
    }
    expect(questions.find((question) => question.slot === "count")?.options.length).toBeGreaterThan(0);
    expect(questions.find((question) => question.slot === "score")?.options.length).toBeGreaterThan(0);
  });

  it("完整需求一个问题都不问", () => {
    expect(buildClarifyQuestions(GENERATE_PRESETS[0]?.requirement ?? "")).toEqual([]);
  });
});

describe("composeRequirement", () => {
  it("没有补充时返回原字符串，一个字节都不变", () => {
    // 回放键 = 哈希(需求原文 + …)。多一个空格就换一次键，三条 fixture 全部未命中。
    const requirement = "出十道判断题";
    expect(composeRequirement(requirement, [])).toBe(requirement);
  });

  it("有补充时追加在需求后面，带槽位标签", () => {
    const composed = composeRequirement("帮我出一份英语卷子", [
      { slot: "count", answer: "10 题" },
      { slot: "score", answer: "100 分" },
    ]);
    expect(composed.startsWith("帮我出一份英语卷子")).toBe(true);
    expect(composed).toContain("教师补充的约束");
    expect(composed).toContain("- 题量：10 题");
    expect(composed).toContain("- 总分：100 分");
  });

  it("空回答与全空白回答被跳过，不产生空条目", () => {
    const composed = composeRequirement("做个问卷", [
      { slot: "count", answer: "   " },
      { slot: "types", answer: "" },
    ]);
    expect(composed).toBe("做个问卷");
  });

  it("同一槽位重复回答时以最后一条为准", () => {
    const composed = composeRequirement("做个问卷", [
      { slot: "count", answer: "5 题" },
      { slot: "count", answer: "8 题" },
    ]);
    expect(composed).toContain("- 题量：8 题");
    expect(composed).not.toContain("5 题");
  });
});

describe("describeClarifications", () => {
  it("拼成一句可写进时间线的话：澄清 N 项：题量=10 题、总分=100 分", () => {
    expect(
      describeClarifications([
        { slot: "count", answer: "10 题" },
        { slot: "score", answer: "100 分" },
      ]),
    ).toBe("澄清 2 项：题量=10 题、总分=100 分");
  });

  it("没有回答时返回空串（调用方据此不发 thinking 事件）", () => {
    expect(describeClarifications([])).toBe("");
    expect(describeClarifications([{ slot: "count", answer: "   " }])).toBe("");
  });
});
