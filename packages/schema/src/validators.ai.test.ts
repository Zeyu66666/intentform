import { describe, expect, it } from "vitest";

import { validateForm } from "./index";
import type { ErrorCode } from "./errors";

/**
 * 边界与畸形输入用例（AI 生成，逐条人工核对预期后保留）。
 *
 * 关注点不是「再测一遍 R1–R8」，而是三类容易漏的东西：
 * 1. 上限边界（差一位、正好、超一位）；
 * 2. 组合场景（只有分节的 quiz、空 items、survey 带 totalScore）；
 * 3. 脏输入不崩（数组、数字、字符串、未知键）。
 *
 * 有几条是在记录**当前实现的缺口**，用例名以「已知缺口」开头：
 * 它们断言的是「现在的行为」，等规则补上后必须一起改。这样缺口不会被忘记，
 * 也不会伪装成「已支持」。
 */

function codes(input: unknown): readonly ErrorCode[] {
  const result = validateForm(input);
  return result.ok ? [] : result.errors.map((error) => error.code);
}

function sections(count: number): unknown {
  return {
    meta: { version: 1, kind: "survey", title: "分节表", objectives: [] },
    items: Array.from({ length: count }, (_, index) => ({
      id: `s${String(index).padStart(2, "0")}`,
      type: "section",
      title: `第 ${index + 1} 节`,
    })),
  };
}

describe("上限边界", () => {
  it("items 正好 100 个通过，101 个被拒", () => {
    expect(codes(sections(100))).toEqual([]);
    expect(codes(sections(101))).toContain("E_SCHEMA_SHAPE");
  });

  it("字段 id 3 位通过、2 位被拒、32 位通过、33 位被拒", () => {
    const make = (id: string) => ({
      meta: { version: 1, kind: "survey", title: "t", objectives: [] },
      items: [{ id, type: "section", title: "s" }],
    });
    expect(codes(make("abc"))).toEqual([]);
    expect(codes(make("ab"))).toContain("E_SCHEMA_SHAPE");
    expect(codes(make("a".repeat(32)))).toEqual([]);
    expect(codes(make("a".repeat(33)))).toContain("E_SCHEMA_SHAPE");
  });

  it("字段 id 不接受大写字母与首尾空格", () => {
    const make = (id: string) => ({
      meta: { version: 1, kind: "survey", title: "t", objectives: [] },
      items: [{ id, type: "section", title: "s" }],
    });
    expect(codes(make("Q01"))).toContain("E_SCHEMA_SHAPE");
    expect(codes(make(" q01"))).toContain("E_SCHEMA_SHAPE");
  });

  it("选项 id 只要求是短标识：单个字母合法（与字段 id 的 3 位下限不同）", () => {
    const result = validateForm({
      meta: {
        version: 1,
        kind: "quiz",
        title: "t",
        objectives: [{ id: "kp1", name: "k" }],
        totalScore: 1,
      },
      items: [
        {
          id: "q01",
          type: "single",
          title: "t",
          score: 1,
          bloom: "remember",
          knowledgePoint: "kp1",
          options: [
            { id: "a", text: "甲" },
            { id: "b", text: "乙" },
          ],
          answer: "a",
        },
      ],
    });
    expect(result.ok).toBe(true);
  });
});

describe("组合场景", () => {
  it("quiz 只有分节时，totalScore 声明为 0 可通过", () => {
    const form = {
      meta: { version: 1, kind: "quiz", title: "空卷", objectives: [], totalScore: 0 },
      items: [{ id: "s01", type: "section", title: "第一节" }],
    };
    expect(codes(form)).toEqual([]);
  });

  it("quiz 没有判分题却声明了非零总分时被拒，并在提示里给出 0", () => {
    const form = {
      meta: { version: 1, kind: "quiz", title: "空卷", objectives: [], totalScore: 10 },
      items: [{ id: "s01", type: "section", title: "第一节" }],
    };
    const result = validateForm(form);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const scoreError = result.errors.find((error) => error.code === "E_SCORE_SUM");
      expect(scoreError?.message).toContain("0");
    }
  });

  it("items 为空数组且 totalScore 为 0：当前实现允许（空卷合法）", () => {
    expect(
      codes({ meta: { version: 1, kind: "quiz", title: "空", objectives: [], totalScore: 0 }, items: [] }),
    ).toEqual([]);
  });

  it("已知缺口：survey 声明 totalScore 目前不被拒绝", () => {
    const form = {
      meta: { version: 1, kind: "survey", title: "问卷", objectives: [], totalScore: 10 },
      items: [{ id: "s01", type: "section", title: "第一节" }],
    };
    // 附录 A.2 只规定 survey 不得含 answer/score（字段级），
    // 没有规定 meta.totalScore 必须缺席，所以这里记录「当前放行」。
    expect(codes(form)).toEqual([]);
  });

  it("已知缺口：objectives 里 id 重复目前不被拒绝", () => {
    const form = {
      meta: {
        version: 1,
        kind: "survey",
        title: "问卷",
        objectives: [
          { id: "kp1", name: "甲" },
          { id: "kp1", name: "乙" },
        ],
      },
      items: [{ id: "s01", type: "section", title: "第一节" }],
    };
    expect(codes(form)).toEqual([]);
  });

  it("knowledgePoint 未声明时报 E_KP_UNKNOWN；大写形态则更早被结构层拦下", () => {
    const make = (knowledgePoint: string) => ({
      meta: {
        version: 1,
        kind: "quiz",
        title: "t",
        objectives: [{ id: "kp1", name: "甲" }],
        totalScore: 1,
      },
      items: [
        {
          id: "q01",
          type: "fill",
          title: "t",
          score: 1,
          bloom: "apply",
          knowledgePoint,
          answer: ["1"],
        },
      ],
    });
    // 形态合法但未声明：这才是语义规则该管的错误
    expect(codes(make("kp2"))).toContain("E_KP_UNKNOWN");
    // 形态不合法（大写）：结构层先拦，语义层根本走不到
    expect(codes(make("KP1"))).toContain("E_SCHEMA_SHAPE");
    expect(codes(make("KP1"))).not.toContain("E_KP_UNKNOWN");
  });

  it("多选题答案为单个选项、且顺序与选项表不同：合法", () => {
    const form = {
      meta: {
        version: 1,
        kind: "quiz",
        title: "t",
        objectives: [{ id: "kp1", name: "甲" }],
        totalScore: 1,
      },
      items: [
        {
          id: "q01",
          type: "multi",
          title: "t",
          score: 1,
          bloom: "understand",
          knowledgePoint: "kp1",
          options: [
            { id: "a", text: "甲" },
            { id: "b", text: "乙" },
            { id: "c", text: "丙" },
          ],
          answer: ["c"],
        },
      ],
    };
    expect(codes(form)).toEqual([]);
  });

  it("填空题答案前后有空格但非全空白：合法（R5 只拦全空白）", () => {
    const form = {
      meta: {
        version: 1,
        kind: "quiz",
        title: "t",
        objectives: [{ id: "kp1", name: "甲" }],
        totalScore: 1,
      },
      items: [
        {
          id: "q01",
          type: "fill",
          title: "t",
          score: 1,
          bloom: "apply",
          knowledgePoint: "kp1",
          answer: ["  x  "],
        },
      ],
    };
    expect(codes(form)).toEqual([]);
  });
});

describe("脏输入不崩", () => {
  it("null / undefined / 数字 / 字符串 / 数组都只报结构错误，不抛异常", () => {
    for (const input of [null, undefined, 42, "form", [], [1, 2, 3]]) {
      expect(() => validateForm(input)).not.toThrow();
      expect(codes(input)).toContain("E_SCHEMA_SHAPE");
    }
  });

  it("未知键被丢弃：不影响校验，也不会出现在投影里", () => {
    const result = validateForm({
      meta: { version: 1, kind: "survey", title: "t", objectives: [], 备注: "随手写的" },
      items: [{ id: "s01", type: "section", title: "第一节", 未知字段: true }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(JSON.stringify(result.data)).not.toContain("备注");
      expect(JSON.stringify(result.data)).not.toContain("未知字段");
    }
  });

  it("数值答案必须是有限数：Infinity 与 NaN 被拒", () => {
    const make = (value: number) => ({
      meta: {
        version: 1,
        kind: "quiz",
        title: "t",
        objectives: [{ id: "kp1", name: "甲" }],
        totalScore: 1,
      },
      items: [
        {
          id: "q01",
          type: "number",
          title: "t",
          score: 1,
          bloom: "apply",
          knowledgePoint: "kp1",
          answer: { value, tolerance: 0 },
        },
      ],
    });
    expect(codes(make(Number.POSITIVE_INFINITY))).toContain("E_SCHEMA_SHAPE");
    expect(codes(make(Number.NaN))).toContain("E_SCHEMA_SHAPE");
    expect(codes(make(1.5))).toEqual([]);
  });

  it("负容差与 min ≥ max 的量表都被拒", () => {
    const negativeTolerance = {
      meta: {
        version: 1,
        kind: "quiz",
        title: "t",
        objectives: [{ id: "kp1", name: "甲" }],
        totalScore: 1,
      },
      items: [
        {
          id: "q01",
          type: "number",
          title: "t",
          score: 1,
          bloom: "apply",
          knowledgePoint: "kp1",
          answer: { value: 1, tolerance: -0.1 },
        },
      ],
    };
    expect(codes(negativeTolerance)).toContain("E_SCHEMA_SHAPE");

    const badScale = {
      meta: { version: 1, kind: "survey", title: "t", objectives: [] },
      items: [{ id: "q01", type: "scale", title: "t", min: 5, max: 5 }],
    };
    expect(codes(badScale)).toContain("E_SCHEMA_SHAPE");
  });

  it("同一份表单连续校验两次结果一致（规则层无跨调用状态）", () => {
    const form = {
      meta: {
        version: 1,
        kind: "quiz",
        title: "含公式 $x^2$",
        objectives: [{ id: "kp1", name: "甲" }],
        totalScore: 1,
      },
      items: [
        {
          id: "q01",
          type: "fill",
          title: "求 $\\frac{1}{2}$",
          score: 1,
          bloom: "apply",
          knowledgePoint: "kp1",
          answer: ["1"],
        },
      ],
    };
    expect(validateForm(form)).toEqual(validateForm(form));
  });
});
