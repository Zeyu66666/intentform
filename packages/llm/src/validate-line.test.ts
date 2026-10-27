import { describe, expect, it } from "vitest";

import { LIMITS } from "@intentform/schema";

import { isStrictSubset, normalizeCodes, truncateRaw, validateLine } from "./validate-line.ts";

const SINGLE = JSON.stringify({
  type: "single",
  id: "q01",
  title: "示例题",
  score: 5,
  bloom: "remember",
  knowledgePoint: "kp1",
  options: [
    { id: "a", text: "甲" },
    { id: "b", text: "乙" },
  ],
  answer: "a",
});

const SECTION = JSON.stringify({ type: "section", id: "sec1", title: "小测验" });

describe("validateLine", () => {
  it("吃下合法 single 与 section", () => {
    const single = validateLine(SINGLE);
    expect(single.ok).toBe(true);
    if (single.ok) {
      expect(single.id).toBe("q01");
      expect(single.node.type).toBe("single");
    }
    expect(validateLine(SECTION).ok).toBe(true);
  });

  it("非 JSON 行给 E_SCHEMA_SHAPE，并保留被截断的原文", () => {
    const result = validateLine('{"type":"single","id":');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.codes).toEqual(["E_SCHEMA_SHAPE"]);
      expect(result.raw).toBe('{"type":"single","id":');
      expect(result.detail).toContain("not JSON");
    }
  });

  it("缺 answer 给 E_ANSWER_MISSING，bloom 非法给 E_BLOOM_INVALID", () => {
    const noAnswer = validateLine(
      JSON.stringify({
        type: "fill",
        id: "q2",
        title: "填空",
        score: 5,
        bloom: "remember",
        knowledgePoint: "kp1",
        answer: [],
      }),
    );
    expect(noAnswer.ok).toBe(false);
    if (!noAnswer.ok) {
      expect(noAnswer.codes).toContain("E_ANSWER_MISSING");
      expect(noAnswer.codes).toContain("E_SCHEMA_SHAPE");
    }

    const badBloom = validateLine(
      JSON.stringify({
        type: "fill",
        id: "q3",
        title: "填空",
        score: 5,
        bloom: "memorize",
        knowledgePoint: "kp1",
        answer: ["x"],
      }),
    );
    expect(badBloom.ok).toBe(false);
    if (!badBloom.ok) expect(badBloom.codes).toContain("E_BLOOM_INVALID");
  });

  it("判分题缺 score 在行级就报 E_SCORE_SUM（修复环才有机会修它）", () => {
    const noScore = validateLine(
      JSON.stringify({
        type: "single",
        id: "q04",
        title: "没分值的单选",
        answer: "a",
        options: [
          { id: "a", text: "甲" },
          { id: "b", text: "乙" },
        ],
      }),
    );
    expect(noScore.ok).toBe(false);
    if (!noScore.ok) expect(noScore.codes).toContain("E_SCORE_SUM");

    // 补上分值就放行：这条断言防的是"把缺分值当结构性错误"，那会让 repairer 无从下手。
    const withScore = validateLine(
      JSON.stringify({
        type: "single",
        id: "q05",
        title: "有分值的单选",
        score: 4,
        answer: "a",
        options: [
          { id: "a", text: "甲" },
          { id: "b", text: "乙" },
        ],
      }),
    );
    expect(withScore.ok).toBe(true);
  });

  it("重复 id 给 E_DUP_ID（流式阶段就抓，不等整表单）", () => {
    const seenIds = new Set<string>(["q01"]);
    const result = validateLine(SINGLE, { seenIds });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.codes).toEqual(["E_DUP_ID"]);
  });

  it("survey 下带 answer/score 的题型被拒为 E_SURVEY_HAS_ANSWER，short/scale 放行", () => {
    const scored = validateLine(SINGLE, { kind: "survey" });
    expect(scored.ok).toBe(false);
    if (!scored.ok) expect(scored.codes).toEqual(["E_SURVEY_HAS_ANSWER"]);

    const short = validateLine(
      JSON.stringify({ type: "short", id: "s01", title: "你预习了吗？", required: true }),
      { kind: "survey" },
    );
    expect(short.ok).toBe(true);

    const scale = validateLine(
      JSON.stringify({
        type: "scale",
        id: "s02",
        title: "信心",
        min: 1,
        max: 5,
        labels: ["低", "高"],
      }),
      { kind: "survey" },
    );
    expect(scale.ok).toBe(true);
  });

  it("raw 截断到 LIMITS.rawLineMax", () => {
    const long = `{"type":"short","id":"s1","title":"${"很长的标题".repeat(500)}"`;
    const result = validateLine(long);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.raw.length).toBe(LIMITS.rawLineMax);
    expect(truncateRaw("短").length).toBe(1); // 按字符截断，不是按字节
  });
});

describe("normalizeCodes / isStrictSubset", () => {
  it("按 ERROR_CODES 声明顺序去重排序", () => {
    const codes = normalizeCodes(["E_ANSWER_MISSING", "E_SCHEMA_SHAPE", "E_SCHEMA_SHAPE"]);
    expect(codes).toEqual(["E_ANSWER_MISSING", "E_SCHEMA_SHAPE"]); // ERROR_CODES 的声明顺序
  });

  it("只有真子集才算前进：换一个错、或一个没修好都不算", () => {
    expect(isStrictSubset(["E_SCHEMA_SHAPE"], ["E_SCHEMA_SHAPE", "E_ANSWER_MISSING"])).toBe(true);
    expect(isStrictSubset([], ["E_SCHEMA_SHAPE"])).toBe(true);
    // 换成另一个错：数量少了，但不是子集
    expect(isStrictSubset(["E_DUP_ID"], ["E_SCHEMA_SHAPE", "E_ANSWER_MISSING"])).toBe(false);
    // 一个没修好：是子集但长度没变少
    expect(isStrictSubset(["E_SCHEMA_SHAPE", "E_DUP_ID"], ["E_SCHEMA_SHAPE"])).toBe(false);
    // 长度相同
    expect(isStrictSubset(["E_DUP_ID"], ["E_SCHEMA_SHAPE"])).toBe(false);
  });
});
