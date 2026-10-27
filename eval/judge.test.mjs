import { describe, expect, it } from "vitest";

import { JUDGE_VERSION, countTypes, judgeForm, summarize, sumScore } from "./judge.mjs";

/**
 * 判定器是「尺子」，它自己出错比被测产品出错更危险——错误的方向永远是「看着更好」。
 * 这里每个用例都对着一个具体的骗人方式写：
 *   1. 空成品被洗成「结构匹配」（曾经真的发生过，见 §summarize 的第一条 CASE）
 *   2. 满分靠 `meta.totalScore` 自报，而不是逐题合计
 *   3. 问卷偷偷带答案还能过
 */

/** 造一份最小合格考卷：3 单选 + 2 填空，每题 5 分，共 25 分，知识点落在题干里。 */
function makeQuiz(overrides = {}) {
  return {
    kind: "quiz",
    items: [
      { id: "q1", type: "single", title: "关于折射，下列正确的是？", score: 5, options: [{ text: "A" }, { text: "B" }] },
      { id: "q2", type: "single", title: "折射角与入射角的关系是？", score: 5 },
      { id: "q3", type: "single", title: "光从空气进水的偏折方向？", score: 5 },
      { id: "q4", type: "fill", title: "折射定律又叫____定律", score: 5 },
      { id: "q5", type: "fill", title: "折射率记作____", score: 5 },
    ],
    ...overrides,
  };
}

const EXPECT_QUIZ = {
  kind: "quiz",
  count: 5,
  types: { single: 3, fill: 2 },
  totalScore: 25,
};

describe("judgeForm", () => {
  it("合格的成品：判定通过，蓝图层全绿", () => {
    const result = judgeForm(makeQuiz(), EXPECT_QUIZ);
    expect(result.passed, JSON.stringify(result.checks, null, 2)).toBe(true);
    expect(result.checks.filter((check) => check.layer === "blueprint").every((check) => check.ok)).toBe(true);
    expect(result.deviation.countDelta).toBe(0);
  });

  it("题量差一道：count 不通过，偏差记 -1", () => {
    const quiz = makeQuiz();
    quiz.items.pop();
    const result = judgeForm(quiz, EXPECT_QUIZ);
    expect(result.passed).toBe(false);
    expect(result.checks.find((check) => check.name === "count")?.ok).toBe(false);
    expect(result.deviation.countDelta).toBe(-1);
  });

  it("题型换掉一个：type-mix 不通过，并指出是哪个类型", () => {
    const quiz = makeQuiz();
    quiz.items[4].type = "short";
    const result = judgeForm(quiz, EXPECT_QUIZ);
    const check = result.checks.find((item) => item.name === "type-mix");
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain("fill");
  });

  it("分值不够：总分以逐题合计为准，不信自报", () => {
    const quiz = makeQuiz();
    for (const item of quiz.items) item.score = 4;
    // 假装 meta 说自己 25 分——事件流里根本没有 meta，判定器也不该去看
    const result = judgeForm({ ...quiz, totalScore: 25 }, EXPECT_QUIZ);
    const check = result.checks.find((item) => item.name === "total-score");
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain("20");
    expect(result.deviation.scoreDelta).toBe(-5);
  });

  it("知识点只在选项里出现，也算落在题里", () => {
    const quiz = makeQuiz();
    quiz.items[0].title = "下列哪个正确？";
    quiz.items[0].options = [{ text: "折射定律" }, { text: "牛顿第一定律" }];
    const result = judgeForm(quiz, { ...EXPECT_QUIZ, objectives: ["折射定律"] });
    expect(result.checks.find((check) => check.name === "objectives")?.ok).toBe(true);
  });

  it("知识点题干里查不到：判缺失", () => {
    const result = judgeForm(makeQuiz(), { ...EXPECT_QUIZ, objectives: ["全反射"] });
    const check = result.checks.find((item) => item.name === "objectives");
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain("全反射");
  });

  it("问卷带答案：validation 层不通过（R3/R5）", () => {
    const survey = {
      kind: "survey",
      items: [
        { id: "s1", type: "single", title: "你预习了吗？", options: [{ text: "有" }, { text: "没有" }] },
        { id: "s2", type: "fill", title: "具体困惑是____", answer: "看情况" },
      ],
    };
    const result = judgeForm(survey, { kind: "survey", count: 2, types: { single: 1, fill: 1 }, noAnswers: true });
    const check = result.checks.find((item) => item.name === "survey-no-answer");
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain("s2");
  });

  it("问卷带 bloom/knowledgePoint 但没答案与分值：算合格（v2 曾误伤，v3 对齐 R3/R5）", () => {
    const survey = {
      kind: "survey",
      items: [
        {
          id: "s1",
          type: "single",
          title: "你觉得课后服务时长合适吗？",
          bloom: "understand",
          knowledgePoint: "kp1",
          options: [{ text: "合适" }, { text: "偏长" }],
        },
      ],
    };
    const result = judgeForm(survey, { kind: "survey", count: 1, types: { single: 1 }, noAnswers: true });
    expect(result.checks.find((check) => check.name === "survey-no-answer")?.ok).toBe(true);
    expect(result.passed, JSON.stringify(result.checks, null, 2)).toBe(true);
  });

  it("问卷带 score：validation 层不通过（R5 禁分值）", () => {
    const survey = {
      kind: "survey",
      items: [{ id: "s1", type: "single", title: "你预习了吗？", score: 5, options: [{ text: "有" }] }],
    };
    const result = judgeForm(survey, { kind: "survey", count: 1, types: { single: 1 }, noAnswers: true });
    expect(result.checks.find((check) => check.name === "survey-no-answer")?.ok).toBe(false);
  });

  it("含简答且需求写了总分：单列 capability 层，说明结构上凑不出总分", () => {
    const quiz = {
      kind: "quiz",
      items: [
        { id: "q1", type: "single", title: "选一个", score: 5 },
        { id: "q2", type: "short", title: "说说你的思路" }, // schema 里 short 没有 score 字段
      ],
    };
    const result = judgeForm(quiz, { kind: "quiz", count: 2, types: { single: 1, short: 1 }, totalScore: 10 });
    const check = result.checks.find((item) => item.name === "short-unscored");
    expect(check?.layer).toBe("capability");
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain("简答题没有分值字段");
    // 总分那条也要点出原因，而不是只报一个差额
    expect(result.checks.find((item) => item.name === "total-score")?.detail).toContain("简答题无分值字段");
    expect(result.passed).toBe(false);
  });

  it("需求不含简答、或需求没写总分：不出 capability 判断", () => {
    const noShort = judgeForm(makeQuiz(), EXPECT_QUIZ);
    expect(noShort.checks.some((check) => check.name === "short-unscored")).toBe(false);
    const surveyNoTotal = judgeForm(
      { kind: "survey", items: [{ id: "s1", type: "short", title: "你的建议？" }] },
      { kind: "survey", count: 1, types: { short: 1 }, noAnswers: true },
    );
    expect(surveyNoTotal.checks.some((check) => check.name === "short-unscored")).toBe(false);
  });

  it("问卷干净：validation 层通过", () => {
    const survey = {
      kind: "survey",
      items: [{ id: "s1", type: "single", title: "你预习了吗？", options: [{ text: "有" }, { text: "没有" }] }],
    };
    const result = judgeForm(survey, { kind: "survey", count: 1, types: { single: 1 }, noAnswers: true });
    expect(result.passed).toBe(true);
  });

  it("空成品：只有一条 form-present，偏差为 null（不假装算过结构）", () => {
    const result = judgeForm({ kind: null, items: [] }, EXPECT_QUIZ);
    expect(result.passed).toBe(false);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0].name).toBe("form-present");
    expect(result.deviation).toBe(null);
  });

  it("成品是 null：不抛异常，按空成品判", () => {
    const result = judgeForm(null, EXPECT_QUIZ);
    expect(result.passed).toBe(false);
    expect(result.checks[0].name).toBe("form-present");
  });
});

describe("summarize", () => {
  const passRecord = {
    id: "ok",
    judgeable: true,
    passed: true,
    checks: [
      { layer: "blueprint", name: "form-present", ok: true },
      { layer: "blueprint", name: "count", ok: true },
    ],
    deviation: { countDelta: 0, typeDiff: [], scoreDelta: 0, missingObjectives: [] },
    errorCodes: {},
    repairs: [],
    usage: { promptTokens: 100, completionTokens: 200 },
    ms: 1000,
  };

  const failRecord = {
    id: "bad",
    judgeable: true,
    passed: false,
    checks: [
      { layer: "blueprint", name: "form-present", ok: true },
      { layer: "blueprint", name: "count", ok: false },
    ],
    deviation: { countDelta: -3, typeDiff: ["fill 需求 2 实得 0"], scoreDelta: null, missingObjectives: [] },
    errorCodes: {},
    repairs: [],
    usage: { promptTokens: 100, completionTokens: 200 },
    ms: 3000,
  };

  // 这条是回归：曾经用 `every(check => check.layer !== "blueprint" || ok)`
  // 判蓝图层匹配，空成品的 checks 里一条蓝图层都没有，`every` 直接为真 ——
  // 于是「一条字段都没产出」被算成「结构完全匹配」，实测把 0/28 报成了 25/28。
  const emptyRecord = {
    id: "empty",
    judgeable: true,
    passed: false,
    checks: [{ layer: "policy", name: "form-present", ok: false }],
    deviation: null,
    errorCodes: {},
    repairs: [],
    usage: null,
    ms: 10,
  };

  const probeRecord = {
    id: "probe",
    judgeable: false,
    passed: false,
    checks: [{ layer: "clarify", name: "clarify-needed", ok: false }],
    deviation: null,
    errorCodes: {},
    repairs: [],
    usage: null,
    ms: 20,
  };

  it("分母只数 judgeable，探针不进分母", () => {
    const summary = summarize([passRecord, failRecord, emptyRecord, probeRecord]);
    expect(summary.judged).toBe(3);
    expect(summary.passed).toBe(1);
    expect(summary.rate).toBeCloseTo(1 / 3, 5);
  });

  it("空成品不算「结构完全匹配」（回归：曾经把 0/28 报成 25/28）", () => {
    const summary = summarize([passRecord, emptyRecord]);
    expect(summary.blueprint.exact).toBe(1);
    expect(summary.blueprint.rate).toBeCloseTo(0.5, 5);
  });

  it("空成品单列计数，且不参与题量偏差均值", () => {
    const summary = summarize([passRecord, failRecord, emptyRecord]);
    expect(summary.noOutput).toBe(1);
    // 只在 ok(0) 与 bad(-3) 上算：|0| + |−3| = 3，均值 1.5；若把空成品的 0 也算进来会变成 1.0
    expect(summary.blueprint.meanAbsCountDelta).toBeCloseTo(1.5, 5);
  });

  it("首轮达标：判定通过且没有错行、没有修复", () => {
    const repaired = { ...passRecord, id: "repaired", repairs: [{ id: "q1", round: 1, status: "fixed" }] };
    const summary = summarize([passRecord, repaired]);
    expect(summary.passed).toBe(2);
    expect(summary.validation.firstPass).toBe(1);
    expect(summary.repair).toMatchObject({ attempts: 1, fixed: 1, failed: 0, rounds: { 1: 1 } });
  });

  it("失败清单带具体约束名，不带原始需求正文以外的废话", () => {
    const summary = summarize([failRecord]);
    expect(summary.failures).toHaveLength(1);
    expect(summary.failures[0].failed[0]).toContain("count");
  });

  it("能力层缺口单列，可表达子集另算一份达标率（主指标不变）", () => {
    const capabilityBlocked = {
      ...failRecord,
      id: "short-quiz",
      checks: [
        { layer: "blueprint", name: "form-present", ok: true },
        { layer: "blueprint", name: "count", ok: true },
        { layer: "capability", name: "short-unscored", ok: false },
      ],
    };
    const summary = summarize([passRecord, capabilityBlocked, emptyRecord]);
    // 主指标：3 条分母，1 条达标 —— 能力缺口不在主指标里被剔除
    expect(summary.judged).toBe(3);
    expect(summary.passed).toBe(1);
    // 第二口径：剔除（能力缺口 + 空成品无产出者）后，剩下 ok 一条，达标 1/1
    expect(summary.capability.gap).toBe(1);
    expect(summary.capability.gapIds).toEqual(["short-quiz"]);
    expect(summary.capability.expressible).toBe(2);
    expect(summary.capability.expressibleRate).toBeCloseTo(0.5, 5);
  });

  it("分母为 0 时不除零", () => {
    const summary = summarize([probeRecord]);
    expect(summary.judged).toBe(0);
    expect(summary.rate).toBe(0);
    expect(summary.blueprint.rate).toBe(0);
  });
});

describe("辅助函数", () => {
  it("section 不算题", () => {
    const items = [{ type: "section" }, { type: "single" }, { type: "fill" }];
    expect(countTypes(items)).toMatchObject({ single: 1, fill: 1, multi: 0, number: 0, short: 0, scale: 0 });
  });

  it("score 缺省按 0 算", () => {
    expect(sumScore([{ type: "single", score: 5 }, { type: "fill" }])).toBe(5);
  });

  it("判定器版本是显式常量，便于报告标注", () => {
    expect(JUDGE_VERSION).toMatch(/^fitness\.v\d+$/u);
  });
});
