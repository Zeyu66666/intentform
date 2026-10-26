import { describe, expect, it } from "vitest";

import {
  AUTO_GRADED_TYPES,
  BLOOM_LEVELS,
  FIELD_TYPES,
  FORM_KINDS,
  LIMITS,
  SCHEMA_VERSION,
  assertNever,
  isAutoGradedType,
  isBloomLevel,
  isFieldType,
  isFormKind,
} from "./index.ts";

describe("契约常量（对齐计划 v1.1 附录 A）", () => {
  it("版本号是数字 1，进回放键参与 hash", () => {
    expect(SCHEMA_VERSION).toBe(1);
  });

  it("七种字段类型，名称与附录 A.1 的 z.literal 一致", () => {
    expect(FIELD_TYPES).toEqual(["single", "multi", "fill", "number", "short", "scale", "section"]);
  });

  it("判分型字段只有四种：short 与 scale 不自动判分", () => {
    expect(AUTO_GRADED_TYPES).toEqual(["single", "multi", "fill", "number"]);
    for (const collectType of ["short", "scale", "section"]) {
      expect(isAutoGradedType(collectType)).toBe(false);
    }
  });

  it("布鲁姆六级与表单种类", () => {
    expect(BLOOM_LEVELS).toHaveLength(6);
    expect(FORM_KINDS).toEqual(["quiz", "survey"]);
  });
});

describe("LIMITS 与 R 规则的对应", () => {
  it("id 正则要求 3–32 位小写字母/数字/下划线/连字符", () => {
    const { idPattern } = LIMITS;
    expect(idPattern.test("q-01")).toBe(true);
    expect(idPattern.test("sec_intro")).toBe(true);
    expect(idPattern.test("ab")).toBe(false); // 太短
    expect(idPattern.test("Q-01")).toBe(false); // 大写
    expect(idPattern.test("q 01")).toBe(false); // 空格
    expect(idPattern.test("a".repeat(33))).toBe(false); // 太长
  });

  it("R4 的选项数量区间是 2–8", () => {
    expect(LIMITS.optionsMin).toBe(2);
    expect(LIMITS.optionsMax).toBe(8);
  });

  it("字段数上限 100，与附录 A.1 的 .max(100) 一致", () => {
    expect(LIMITS.fieldsMax).toBe(100);
  });

  it("简答默认上限 500，硬上限 2000", () => {
    expect(LIMITS.shortDefaultMaxLength).toBe(500);
    expect(LIMITS.shortMaxLengthCap).toBe(2000);
    expect(LIMITS.shortDefaultMaxLength).toBeLessThanOrEqual(LIMITS.shortMaxLengthCap);
  });

  it("分值上限 100 是整数，避免 R6 浮点求和误差", () => {
    expect(Number.isInteger(LIMITS.scoreMax)).toBe(true);
  });

  it("service 层上限：需求 4000 字符、答卷 64KB", () => {
    expect(LIMITS.requirementMaxChars).toBe(4000);
    expect(LIMITS.submissionMaxBytes).toBe(65536);
  });
});

describe("守卫", () => {
  it("isFieldType 拒绝非字符串与未知类型", () => {
    expect(isFieldType("single")).toBe(true);
    expect(isFieldType("multiple")).toBe(false); // v1.0 旧名，已废弃
    expect(isFieldType("short_answer")).toBe(false); // v1.0 旧名，已废弃
    expect(isFieldType(undefined)).toBe(false);
    expect(isFieldType(3)).toBe(false);
  });

  it("isBloomLevel 拒绝大小写变体（枚举不做归一化）", () => {
    expect(isBloomLevel("apply")).toBe(true);
    expect(isBloomLevel("Apply")).toBe(false);
    expect(isBloomLevel("")).toBe(false);
  });

  it("isFormKind 只认 quiz / survey", () => {
    expect(isFormKind("quiz")).toBe(true);
    expect(isFormKind("survey")).toBe(true);
    expect(isFormKind("exam")).toBe(false);
  });
});

describe("assertNever", () => {
  it("抛出的错误里带上未处理的值，便于定位新增分支漏了哪里", () => {
    expect(() => assertNever("scale" as never)).toThrow(/unreachable variant: scale/);
  });
});
