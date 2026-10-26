import { describe, expect, it } from "vitest";

import { formItemSchema } from "@intentform/schema";
import type { FormItem } from "@intentform/schema";

import { buildCandidateForm, runPublishGate } from "./publish-gate.ts";
import type { GateField } from "./publish-gate.ts";

/** 节点一律经 Zod 解析后使用：手写类型等于复制契约，迟早对不上。 */
function node(input: unknown): FormItem {
  return formItemSchema.parse(input);
}

const SINGLE = node({
  type: "single",
  id: "q_open",
  title: "二次函数 $y=2x^2$ 的开口方向？",
  required: true,
  score: 5,
  bloom: "remember",
  knowledgePoint: "kp1",
  options: [
    { id: "a", text: "向上" },
    { id: "b", text: "向下" },
  ],
  answer: "a",
});

const FILL = node({
  type: "fill",
  id: "q_value",
  title: "填写 $x^2$ 的系数",
  required: true,
  score: 5,
  bloom: "apply",
  knowledgePoint: "kp2",
  answer: ["2"],
});

const SHORT = node({
  type: "short",
  id: "s_preview",
  title: "课前你预习了吗？",
  required: true,
  maxLength: 200,
});

function fields(...nodes: readonly FormItem[]): GateField[] {
  return nodes.map((item, index) => ({ index, node: item }));
}

describe("runPublishGate · 通过", () => {
  it("合法 quiz 整表放行", () => {
    const gate = runPublishGate(fields(SINGLE, FILL), "quiz");
    expect(gate).toEqual({ ok: true, itemErrors: [], formErrors: [] });
  });

  it("合法 survey（只有非判分题）放行", () => {
    expect(runPublishGate(fields(SHORT), "survey").ok).toBe(true);
  });
});

describe("runPublishGate · 整表级失败", () => {
  it("survey 里出现判分题 → 拦住，错误挂在 meta.kind 而不是某一行", () => {
    const gate = runPublishGate(fields(SHORT, SINGLE), "survey");
    expect(gate.ok).toBe(false);
    expect(gate.itemErrors).toEqual([]);
    expect(gate.formErrors.map((error) => error.path)).toContain("meta.kind");
    expect(gate.formErrors.map((error) => error.code)).toContain("E_SURVEY_HAS_ANSWER");
  });

  it("空表 → 拦住（避免发出一个没有题的表单）", () => {
    const gate = runPublishGate([], "quiz");
    expect(gate.ok).toBe(false);
    expect(gate.formErrors).toHaveLength(1);
  });
});

describe("runPublishGate · 节点级失败", () => {
  it("答案 id 不在选项里 → 点名到那一行，带源码原文", () => {
    const broken = node({ ...SINGLE, id: "q_broken", answer: "zzz" });
    const gate = runPublishGate(fields(SINGLE, broken), "quiz");

    expect(gate.ok).toBe(false);
    expect(gate.itemErrors).toHaveLength(1);
    expect(gate.itemErrors[0]?.index).toBe(1);
    expect(gate.itemErrors[0]?.id).toBe("q_broken");
    expect(gate.itemErrors[0]?.codes).toContain("E_ANSWER_NOT_IN_OPTIONS");
    // 原文留给教师端看，截断上限来自 LIMITS.rawLineMax
    expect(gate.itemErrors[0]?.raw).toContain("q_broken");
    expect(gate.itemErrors[0]?.raw.length).toBeLessThanOrEqual(2000);
  });

  it("重复 id → 点名", () => {
    const gate = runPublishGate(fields(SINGLE, FILL, FILL), "quiz");
    expect(gate.ok).toBe(false);
    expect(gate.itemErrors.some((error) => error.codes.includes("E_DUP_ID"))).toBe(true);
  });

  it("LaTeX 写坏 → 点名到那一行（R7 走真实 KaTeX）", () => {
    const badLatex = node({ ...FILL, id: "q_latex", title: "求 $\\frac{1}{$ 的值" });
    const gate = runPublishGate(fields(badLatex), "quiz");
    expect(gate.ok).toBe(false);
    expect(gate.itemErrors[0]?.codes).toContain("E_LATEX_INVALID");
  });
});

describe("buildCandidateForm", () => {
  it("quiz 的 totalScore 按节点分值求和，objectives 按节点知识点反推", () => {
    const candidate = buildCandidateForm(fields(SINGLE, FILL), "quiz");
    expect(candidate.meta["totalScore"]).toBe(10);
    expect(candidate.meta["objectives"]).toEqual([
      { id: "kp1", name: "kp1" },
      { id: "kp2", name: "kp2" },
    ]);
  });

  it("survey 不带 totalScore", () => {
    const candidate = buildCandidateForm(fields(SHORT), "survey");
    expect("totalScore" in candidate.meta).toBe(false);
    expect(candidate.meta["objectives"]).toEqual([]);
  });

  it("占位标题只用于满足结构校验，不是要发布的内容", () => {
    const candidate = buildCandidateForm(fields(SHORT), "survey");
    expect(String(candidate.meta["title"])).toContain("候选");
  });
});
