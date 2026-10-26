/**
 * 判分口径的单元测试。
 *
 * 这些用例是「谁改判分就必须先来这里改一行」的地方：multi 顺序无关、
 * fill 按空逐个比、number 容差、未知字段拒收——都是《计划 v3.0》§3.5 的明文规则。
 */

import { describe, expect, it } from "vitest";
import { formSchema } from "@intentform/schema";
import { gradeSubmission, maxScoreOf } from "./grading.ts";
import { quizSchema, surveySchema } from "./testing/fixtures.ts";

const schema = quizSchema();

function grade(answers: Record<string, string | string[]>): ReturnType<typeof gradeSubmission> {
  return gradeSubmission(schema, answers);
}

describe("gradeSubmission", () => {
  it("全对拿满分，maxScore 是自动判分题分值之和", () => {
    const result = grade({
      "q-single": "op1",
      "q-multi": ["op1", "op3"],
      "q-fill": ["2", "x"],
      "q-number": "3.14",
    });
    expect(result).toEqual({ ok: true, score: 20, maxScore: 20 });
  });

  it("multi 与选项顺序无关", () => {
    const result = grade({ "q-multi": ["op3", "op1"] });
    expect(result).toMatchObject({ ok: true, score: 5 });
  });

  it("multi 少选、多选都算错", () => {
    expect(grade({ "q-multi": ["op1"] })).toMatchObject({ score: 0 });
    expect(grade({ "q-multi": ["op1", "op2", "op3"] })).toMatchObject({ score: 0 });
  });

  it("multi 重复选项整份拒收", () => {
    const result = grade({ "q-multi": ["op1", "op1", "op3"] });
    expect(result.ok).toBe(false);
  });

  it("fill 按空逐个比，带首尾空白与大小写不影响", () => {
    expect(grade({ "q-fill": [" 2 ", " X "] })).toMatchObject({ score: 5 });
  });

  it("fill 允许用全角斜杠分隔多个空的单字符串形态", () => {
    expect(grade({ "q-fill": "2／x" })).toMatchObject({ score: 5 });
  });

  it("fill 的半角斜杠与全角斜杠得到同样结果", () => {
    // 中文输入法敲出全角「／」，从别处粘贴过来是半角「/」。两种都得算对，
    // 否则学生答对了却拿 0 分，而且服务端不会有任何报错（fill-ui 联调踩到过）。
    const halfWidth = grade({ "q-fill": "2/x" });
    const fullWidth = grade({ "q-fill": "2／x" });
    expect(halfWidth).toEqual(fullWidth);
    expect(halfWidth).toEqual({ ok: true, score: 5, maxScore: 20 });
  });

  it("只有一个空时，答案里的斜杠是内容而不是分隔符", () => {
    // `1/2` 这种答案的斜杠不能当分隔符拆开：拆了就变成两段，长度不匹配，整题 0 分。
    const single = formSchema.parse({
      meta: { version: 1, kind: "quiz", title: "单空填空", objectives: [], totalScore: 5 },
      items: [
        {
          id: "q-half",
          type: "fill",
          title: "化到最简：2/4 = ?",
          answer: ["1/2"],
          score: 5,
          required: true,
        },
      ],
    });
    expect(gradeSubmission(single, { "q-half": "1/2" })).toEqual({
      ok: true,
      score: 5,
      maxScore: 5,
    });
    // 全角写法的同一个答案也一样（归一化对斜杠不敏感，但分段必须还是 1 段）。
    expect(gradeSubmission(single, { "q-half": "1／2" })).toMatchObject({ ok: true, score: 0 });
  });

  it("fill 段数与答案数不一致算错，但整份不拒收", () => {
    const result = grade({ "q-fill": "2" });
    expect(result).toMatchObject({ ok: true, score: 0 });
  });

  it("fill 不做模糊匹配", () => {
    expect(grade({ "q-fill": ["2.0", "x"] })).toMatchObject({ score: 0 });
  });

  it("number 在容差内算对、容差外算错", () => {
    expect(grade({ "q-number": "3.145" })).toMatchObject({ score: 5 });
    expect(grade({ "q-number": "3.2" })).toMatchObject({ score: 0 });
  });

  it("number 解析失败只算错，不抛异常", () => {
    expect(() => grade({ "q-number": "三点一四" })).not.toThrow();
    expect(grade({ "q-number": "三点一四" })).toMatchObject({ ok: true, score: 0 });
  });

  it("未作答得 0 分但不拒收整份提交", () => {
    expect(grade({})).toEqual({ ok: true, score: 0, maxScore: 20 });
  });

  it("未知字段 id 整份拒收（不能静默按 0 分）", () => {
    const result = grade({ "q-single": "op1", "q-evil": "x" });
    expect(result.ok).toBe(false);
  });

  it("只取提交里出现过的字段作答，不会因为多传 section 而得错", () => {
    // section 是合法字段 id，但没有分值；带上它不算未知字段。
    const result = grade({ "sec-main": "irrelevant" });
    expect(result).toMatchObject({ ok: true, score: 0 });
  });

  it("survey 没有自动判分题，满分是 0", () => {
    expect(maxScoreOf(surveySchema())).toBe(0);
  });
});
