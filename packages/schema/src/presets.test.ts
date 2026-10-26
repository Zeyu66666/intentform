import { describe, expect, it } from "vitest";

import { LIMITS } from "./constants";
import { findPreset, GENERATE_PRESETS, presetsWithinLimit } from "./presets";

describe("预置需求（同时是回放 fixture 的输入）", () => {
  it("正好 3 条，对应 I2 要录的 3 条 fixture", () => {
    expect(GENERATE_PRESETS).toHaveLength(3);
  });

  it("id 唯一且都是小写连字符，label 简短", () => {
    const ids = GENERATE_PRESETS.map((preset) => preset.id);
    expect(new Set(ids).size).toBe(3);
    for (const preset of GENERATE_PRESETS) {
      expect(preset.id).toMatch(/^[a-z][a-z-]*$/);
      expect(preset.label.length).toBeGreaterThan(0);
      expect(preset.label.length).toBeLessThanOrEqual(12);
    }
  });

  it("需求文本非空、在字数上限内、且彼此不同", () => {
    expect(presetsWithinLimit()).toBe(true);
    for (const preset of GENERATE_PRESETS) {
      expect(preset.requirement.length).toBeLessThanOrEqual(LIMITS.requirementMaxChars);
    }
    const texts = new Set(GENERATE_PRESETS.map((preset) => preset.requirement));
    expect(texts.size).toBe(3);
  });

  it("需求文本本身是稳定的：改动它等于让 3 条 fixture 失效", () => {
    // 这条断言故意写得"烦人"。这些字符串参与 sha256，任何字符变化都会让回放未命中，
    // 而回放未命中的表现是"演示时现场请求上游"，属于最坏的失败方式。
    expect(GENERATE_PRESETS.map((preset) => preset.requirement.length)).toEqual([76, 78, 97]);
  });

  it("findPreset 命中与未命中", () => {
    expect(findPreset("math-quadratic")?.id).toBe("math-quadratic");
    expect(findPreset("nope")).toBeUndefined();
  });
});
