/**
 * 判分口径的单元测试。
 *
 * 这些用例是「谁改判分就必须先来这里改一行」的地方：multi 顺序无关、
 * fill 按空逐个比、number 容差、未知字段拒收——都是《计划 v3.0》§3.5 的明文规则。
 */

import { describe, expect, it } from "vitest";
import { formSchema } from "@intentform/schema";
import {
  correctnessItemsOf,
  gradeSubmission,
  isAnswered,
  isJudgeableItem,
  judgeItem,
  maxScoreOf,
} from "./grading.ts";
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
    expect(result).toEqual({ ok: true, score: 20, maxScore: 20, pendingScore: 0 });
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
    expect(halfWidth).toEqual({ ok: true, score: 5, maxScore: 20, pendingScore: 0 });
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
      pendingScore: 0,
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
    expect(grade({})).toEqual({ ok: true, score: 0, maxScore: 20, pendingScore: 0 });
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

/**
 * 省赛 R-04：每题正确率的判定必须与判分**同一个函数**。
 * 这两组用例是那条约束的执行器——谁把 `judgeItem` 改坏，判分与看板会同时红。
 */
describe("judgeItem", () => {
  const byId = new Map(schema.items.map((item) => [item.id, item]));

  function judge(itemId: string, value: string | string[]): boolean {
    const item = byId.get(itemId);
    if (item === undefined || !isJudgeableItem(item)) {
      throw new Error(`fixture 里 ${itemId} 不是可判分题`);
    }
    return judgeItem(item, value);
  }

  it("四种自动判分题型各按自己的口径判对", () => {
    expect(judge("q-single", "op1")).toBe(true);
    expect(judge("q-multi", ["op3", "op1"])).toBe(true);
    expect(judge("q-fill", [" 2 ", " X "])).toBe(true);
    expect(judge("q-number", "3.145")).toBe(true);
  });

  it("答错与空值都判错，且不抛异常", () => {
    expect(judge("q-single", "op2")).toBe(false);
    expect(judge("q-single", "")).toBe(false);
    expect(judge("q-multi", ["op1"])).toBe(false);
    expect(judge("q-fill", ["2"])).toBe(false);
    expect(judge("q-number", "三点一四")).toBe(false);
  });

  it("multi 重复选项判错（判分侧会整份拒收，这里是统计侧的兜底）", () => {
    expect(judge("q-multi", ["op1", "op1", "op3"])).toBe(false);
  });
});

describe("isAnswered", () => {
  it("空串、全空白、空数组都算未作答", () => {
    expect(isAnswered("")).toBe(false);
    expect(isAnswered("   ")).toBe(false);
    expect(isAnswered([])).toBe(false);
    expect(isAnswered(["", "  "])).toBe(false);
  });

  it("有内容就算作答——答错也是作答", () => {
    expect(isAnswered("op1")).toBe(true);
    expect(isAnswered("错答案")).toBe(true);
    expect(isAnswered(["", "x"])).toBe(true);
  });
});

describe("correctnessItemsOf", () => {
  it("quiz 只返回四种自动判分题：分节与简答不在内", () => {
    expect(correctnessItemsOf(schema).map((item) => item.id)).toEqual([
      "q-single",
      "q-multi",
      "q-fill",
      "q-number",
    ]);
  });

  it("survey 里没有带标准答案的字段，返回空数组（不该四处 0%）", () => {
    expect(correctnessItemsOf(surveySchema())).toEqual([]);
  });

  it("缺标准答案的题被跳过，而不是按全错统计", () => {
    // 结构上合法但没答案的 quiz 是校验器该拦的输入；统计层不能因为上游漏拦就
    // 输出一个「正确率 0%」的假数字——那看起来像「学生全错」，实际是「这题没法判」。
    const noAnswer = formSchema.parse({
      meta: { version: 1, kind: "quiz", title: "缺答案", objectives: [], totalScore: 5 },
      items: [
        {
          id: "q-noans",
          type: "single",
          title: "没有答案的题",
          score: 5,
          required: true,
          options: [
            { id: "op1", text: "一" },
            { id: "op2", text: "二" },
          ],
        },
      ],
    });
    expect(correctnessItemsOf(noAnswer)).toEqual([]);
  });
});

describe("统计与判分同源", () => {
  it("gradeSubmission 的得分 = judgeItem 判对的题的分值之和", () => {
    // 一条会同时踩到「对 / 错 / 未作答 / 顺序无关」的答卷：手写的期望值与函数算出的
    // 值必须一致，否则看板的每题正确率会和学生的得分对不上账。
    const answers: Record<string, string | string[]> = {
      "q-single": "op1", // 对，5 分
      "q-multi": ["op1"], // 错
      "q-number": "3.2", // 错
      // q-fill 未作答
    };
    const result = gradeSubmission(schema, answers);
    expect(result).toMatchObject({ ok: true, score: 5 });

    const expected = correctnessItemsOf(schema).reduce((sum, item) => {
      const value = answers[item.id];
      if (value === undefined) return sum;
      return judgeItem(item, value) ? sum + (item.score ?? 0) : sum;
    }, 0);
    expect(expected).toBe(5);
  });
});
