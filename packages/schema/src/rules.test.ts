import { describe, expect, it } from "vitest";

import { formatRepairs, type ErrorCode, type SchemaError } from "./errors.ts";
import { validateForm, type LatexChecker, type ValidationResult } from "./rules.ts";

/**
 * 测试用的 JSON 形态。
 *
 * 刻意不用 `any`：规则层的输入本来就是 `unknown`，测试要证明的正是「任意脏输入都不崩」。
 * 用索引签名表达「可任意改写字段」的同时，仍然保留类型检查。
 */
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };
interface RawForm {
  meta: JsonObject;
  items: JsonObject[];
}

/** 合法底稿：一单选 4 分 + 一多选 6 分，合计 10 分，知识点已声明。 */
function baseQuiz(): RawForm {
  return {
    meta: {
      version: 1,
      kind: "quiz",
      title: "单元测验",
      objectives: [{ id: "kp1", name: "知识点一" }],
      totalScore: 10,
    },
    items: [
      {
        id: "q01",
        type: "single",
        title: "第一题",
        score: 4,
        bloom: "remember",
        knowledgePoint: "kp1",
        options: [
          { id: "a", text: "甲" },
          { id: "b", text: "乙" },
        ],
        answer: "a",
      },
      {
        id: "q02",
        type: "multi",
        title: "第二题",
        score: 6,
        bloom: "understand",
        knowledgePoint: "kp1",
        options: [
          { id: "a", text: "甲" },
          { id: "b", text: "乙" },
          { id: "c", text: "丙" },
        ],
        answer: ["a", "c"],
      },
    ],
  };
}

/** 取第 index 个字段并断言存在，避免 `noUncheckedIndexedAccess` 下的 `!`。 */
function at(form: RawForm, index: number): JsonObject {
  const item = form.items[index];
  if (item === undefined) {
    throw new Error(`测试数据缺少 items[${index}]`);
  }
  return item;
}

function codesOf(result: ValidationResult): readonly ErrorCode[] {
  return result.ok ? [] : result.errors.map((error) => error.code);
}

function errorsOf(result: ValidationResult): readonly SchemaError[] {
  return result.ok ? [] : result.errors;
}

describe("validateForm / 结构层", () => {
  it("接受一份合法 quiz，并原样返回解析结果", () => {
    const result = validateForm(baseQuiz());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.meta.totalScore).toBe(10);
      expect(result.data.items).toHaveLength(2);
    }
  });

  it("结构不合格时报 E_SCHEMA_SHAPE，且不跑语义规则", () => {
    const result = validateForm({ meta: { version: 2 }, items: "不是数组" });
    expect(result.ok).toBe(false);
    expect(codesOf(result)).toContain("E_SCHEMA_SHAPE");
    expect(codesOf(result)).not.toContain("E_SCORE_SUM");
  });

  it("整份输入不是对象时也不抛异常", () => {
    expect(() => validateForm(null)).not.toThrow();
    expect(codesOf(validateForm(null))).toContain("E_SCHEMA_SHAPE");
  });
});

describe("validateForm / R1 唯一性", () => {
  it("字段 id 重复时报 E_DUP_ID，并指出与谁冲突", () => {
    const form = baseQuiz();
    at(form, 1).id = "q01";
    const result = validateForm(form);
    expect(codesOf(result)).toContain("E_DUP_ID");
    const dup = errorsOf(result).find((error) => error.code === "E_DUP_ID");
    expect(dup?.path).toBe("items[1].id");
  });
});

describe("validateForm / R2 R3 R4 选项与答案", () => {
  it("单选答案不在选项里报 E_ANSWER_NOT_IN_OPTIONS", () => {
    const form = baseQuiz();
    at(form, 0).answer = "z";
    const result = validateForm(form);
    expect(codesOf(result)).toContain("E_ANSWER_NOT_IN_OPTIONS");
    expect(errorsOf(result).find((e) => e.code === "E_ANSWER_NOT_IN_OPTIONS")?.path).toBe(
      "items[0].answer",
    );
  });

  it("多选答案含未知 id 报 E_MULTI_ANSWER_INVALID", () => {
    const form = baseQuiz();
    at(form, 1).answer = ["a", "z"];
    expect(codesOf(validateForm(form))).toContain("E_MULTI_ANSWER_INVALID");
  });

  it("多选答案重复报 E_MULTI_ANSWER_INVALID", () => {
    const form = baseQuiz();
    at(form, 1).answer = ["a", "a"];
    const result = validateForm(form);
    expect(codesOf(result)).toContain("E_MULTI_ANSWER_INVALID");
    expect(errorsOf(result)[0]?.message).toContain("重复");
  });

  it("同一题内选项文本重复报 E_OPTIONS_INVALID", () => {
    const form = baseQuiz();
    const options = at(form, 0).options;
    if (!Array.isArray(options)) {
      throw new Error("测试数据缺少 options");
    }
    const second = options[1];
    if (typeof second !== "object" || second === null || Array.isArray(second)) {
      throw new Error("测试数据 options[1] 形状不对");
    }
    second.text = "甲";
    expect(codesOf(validateForm(form))).toContain("E_OPTIONS_INVALID");
  });

  it("同一题内选项 id 重复报 E_OPTIONS_INVALID", () => {
    const form = baseQuiz();
    const options = at(form, 1).options;
    if (!Array.isArray(options)) {
      throw new Error("测试数据缺少 options");
    }
    const second = options[1];
    if (typeof second !== "object" || second === null || Array.isArray(second)) {
      throw new Error("测试数据 options[1] 形状不对");
    }
    second.id = "a";
    expect(codesOf(validateForm(form))).toContain("E_OPTIONS_INVALID");
  });
});

describe("validateForm / R5 答案完整性", () => {
  it("填空题答案是纯空格时报 E_ANSWER_MISSING（Zod 的 min(1) 挡不住空白串）", () => {
    const form = baseQuiz();
    form.items = [
      {
        id: "q01",
        type: "fill",
        title: "填空题",
        score: 10,
        bloom: "apply",
        knowledgePoint: "kp1",
        answer: ["   "],
      },
    ];
    form.meta.totalScore = 10;
    const result = validateForm(form);
    expect(codesOf(result)).toContain("E_ANSWER_MISSING");
    expect(errorsOf(result).find((e) => e.code === "E_ANSWER_MISSING")?.path).toBe(
      "items[0].answer",
    );
  });
});

describe("validateForm / R6 分值", () => {
  it("totalScore 与自动判分题之和不符时报 E_SCORE_SUM", () => {
    const form = baseQuiz();
    form.meta.totalScore = 99;
    const result = validateForm(form);
    expect(codesOf(result)).toContain("E_SCORE_SUM");
    expect(errorsOf(result)[0]?.path).toBe("meta.totalScore");
    expect(errorsOf(result)[0]?.message).toContain("10");
  });

  it("quiz 缺少 totalScore 时报 E_SCORE_SUM 并给出应当填的数值", () => {
    const form = baseQuiz();
    delete form.meta.totalScore;
    const result = validateForm(form);
    expect(codesOf(result)).toContain("E_SCORE_SUM");
    expect(errorsOf(result)[0]?.message).toContain("10");
  });

  it("survey 里出现判分题时报 E_SURVEY_HAS_ANSWER", () => {
    const form = baseQuiz();
    form.meta.kind = "survey";
    delete form.meta.totalScore;
    expect(codesOf(validateForm(form))).toContain("E_SURVEY_HAS_ANSWER");
  });
});

describe("validateForm / R8 教学法元数据", () => {
  it("knowledgePoint 未在 objectives 中声明时报 E_KP_UNKNOWN", () => {
    const form = baseQuiz();
    at(form, 1).knowledgePoint = "kp-missing";
    const result = validateForm(form);
    expect(codesOf(result)).toContain("E_KP_UNKNOWN");
    expect(errorsOf(result)[0]?.path).toBe("items[1].knowledgePoint");
  });

  it("bloom 不是合法枚举时借结构层报出 E_BLOOM_INVALID（而非笼统的 E_SCHEMA_SHAPE）", () => {
    const form = baseQuiz();
    at(form, 0).bloom = "memorize";
    const result = validateForm(form);
    expect(codesOf(result)).toContain("E_BLOOM_INVALID");
    expect(codesOf(result)).not.toContain("E_SCHEMA_SHAPE");
  });
});

describe("validateForm / R7 LaTeX 注入点", () => {
  const rejectLongFormula: LatexChecker = (text) =>
    text.includes("\\broken") ? "未定义的命令 \\broken" : null;

  it("注入 checker 后，题干里的坏公式报 E_LATEX_INVALID 并带位置", () => {
    const form = baseQuiz();
    at(form, 0).title = "求 $\\broken{x}$ 的极限";
    const result = validateForm(form, { checkLatex: rejectLongFormula });
    expect(codesOf(result)).toContain("E_LATEX_INVALID");
    expect(errorsOf(result).find((e) => e.code === "E_LATEX_INVALID")?.path).toBe(
      "items[0].title",
    );
  });

  it("未注入 checker 时不做 LaTeX 校验", () => {
    const form = baseQuiz();
    at(form, 0).title = "求 $\\broken{x}$ 的极限";
    expect(codesOf(validateForm(form))).not.toContain("E_LATEX_INVALID");
  });

  it("选项文本里的坏公式也能被发现", () => {
    const form = baseQuiz();
    const options = at(form, 0).options;
    if (!Array.isArray(options)) {
      throw new Error("测试数据缺少 options");
    }
    const first = options[0];
    if (typeof first !== "object" || first === null || Array.isArray(first)) {
      throw new Error("测试数据 options[0] 形状不对");
    }
    first.text = "$\\broken$";
    const result = validateForm(form, { checkLatex: rejectLongFormula });
    expect(errorsOf(result).find((e) => e.code === "E_LATEX_INVALID")?.path).toBe(
      "items[0].options[0].text",
    );
  });
});

describe("formatRepairs", () => {
  it("按 path 字典序输出，且每条都带错误码与位置", () => {
    const form = baseQuiz();
    at(form, 1).id = "q01";
    form.meta.totalScore = 99;
    const result = validateForm(form);
    if (result.ok) {
      throw new Error("期望校验失败");
    }
    const text = formatRepairs(result.errors);
    const lines = text.split("\n");
    expect(lines).toHaveLength(result.errors.length);
    expect(lines.every((line) => /^- \[E_[A-Z_]+\] /.test(line))).toBe(true);
    const paths = lines.map((line) => {
      // repair 是给模型读的自然语言，内部可能出现任意全角括号，所以只认行尾那一个锚点。
      const match = /（位置 ([^）]+)）$/.exec(line);
      if (match === null) {
        throw new Error(`repair 文本缺少行尾位置信息：${line}`);
      }
      return match[1] ?? "";
    });
    expect([...paths].sort()).toEqual(paths);
  });

  it("同样的错误集合无论产生顺序如何，提示文本完全一致（回放键稳定性的前提）", () => {
    const form = baseQuiz();
    at(form, 1).id = "q01";
    form.meta.totalScore = 99;
    const result = validateForm(form);
    if (result.ok) {
      throw new Error("期望校验失败");
    }
    expect(formatRepairs([...result.errors].reverse())).toBe(formatRepairs(result.errors));
  });
});
