import { describe, expect, it } from "vitest";

import { API_PATHS, CSV_BASE_COLUMNS } from "@intentform/schema";

import { CSV_HEADER_BASE, containsAnswerColumn, csvFileName, csvHref } from "./csv";

describe("csvHref", () => {
  it("与契约 API_PATHS.submissionsCsv 完全一致（不手拼路径）", () => {
    expect(csvHref("form-1")).toBe(API_PATHS.submissionsCsv("form-1"));
    expect(csvHref("form-1")).toBe("/api/forms/form-1/submissions.csv");
  });

  it("formId 里的特殊字符只编码一次", () => {
    expect(csvHref("a/b")).toBe("/api/forms/a%2Fb/submissions.csv");
  });
});

describe("csvFileName", () => {
  it("导出多份时不互相覆盖", () => {
    expect(csvFileName("form-1")).toBe("submissions-form-1.csv");
    expect(csvFileName("form-1")).not.toBe(csvFileName("form-2"));
  });
});

describe("导出的列安全", () => {
  it("固定前缀四列与契约一致", () => {
    expect(CSV_HEADER_BASE).toEqual(CSV_BASE_COLUMNS);
    expect(CSV_HEADER_BASE).toHaveLength(4);
    expect(CSV_HEADER_BASE[0]).toBe("submission_id");
  });

  it("前缀列里不含 answer / explanation（混进去就是泄题材料）", () => {
    expect(containsAnswerColumn(CSV_HEADER_BASE)).toBe(false);
  });

  it("守卫本身能识别出答案列", () => {
    expect(containsAnswerColumn(["submission_id", "answer"])).toBe(true);
    expect(containsAnswerColumn(["submission_id", "explanation"])).toBe(true);
    expect(containsAnswerColumn(["submission_id", "score"])).toBe(false);
  });
});
