/**
 * `buildPublishDraft()` 的测试。
 *
 * 这份测试真正要钉住的是四件会在答辩现场炸掉的事：
 *   1. quiz 的分值合计 = 各题之和（服务端 R6 会拿它逐字比对）；
 *   2. survey **一个** `score`/`answer` 都不许漏出去（漏一个就是 `E_SURVEY_HAS_ANSWER`）；
 *   3. `knowledgePoint` 必须登记进 `meta.objectives`（否则 R8 让每题都过不了门禁）；
 *   4. 需求文本 → 标题的截断规则（首行、40 码点、空则兜底）。
 */

import {
  SCHEMA_VERSION,
  createFormRequestSchema,
  validateForm,
  type FormItem,
} from "@intentform/schema";
import { describe, expect, it } from "vitest";

import {
  DRAFT_TITLE_MAX,
  DEFAULT_FORM_TITLE,
  PREFLIGHT_PREFIX,
  buildPublishDraft,
  deriveTitle,
  formatGateErrors,
} from "./build-draft";

const SECTION: FormItem = {
  type: "section",
  id: "sec-basic",
  title: "第一部分：认识二次函数",
  description: "共 4 题，$y=ax^2+bx+c$ 的形态。",
};

const SINGLE: FormItem = {
  type: "single",
  id: "q-opening",
  title: "抛物线 $y=x^2$ 的开口方向？",
  required: true,
  score: 4,
  bloom: "understand",
  knowledgePoint: "kp-parabola",
  explanation: "$a>0$ 时开口向上。",
  options: [
    { id: "a", text: "向上" },
    { id: "b", text: "向下" },
  ],
  answer: "a",
};

const MULTI: FormItem = {
  type: "multi",
  id: "q-vertex",
  title: "下列哪些点在 $y=x^2$ 上？",
  required: true,
  score: 4,
  bloom: "apply",
  knowledgePoint: "kp-parabola",
  options: [
    { id: "a", text: "$(0,0)$" },
    { id: "b", text: "$(1,1)$" },
    { id: "c", text: "$(2,3)$" },
  ],
  answer: ["a", "b"],
};

const FILL: FormItem = {
  type: "fill",
  id: "q-vertex-form",
  title: "配方后顶点横坐标是 $x=$ ____",
  required: true,
  score: 4,
  bloom: "apply",
  knowledgePoint: "kp-completing-square",
  answer: ["1"],
};

const NUMBER: FormItem = {
  type: "number",
  id: "q-axis",
  title: "对称轴 $x=$ ____",
  required: true,
  score: 4,
  bloom: "apply",
  knowledgePoint: "kp-completing-square",
  answer: { value: 1, tolerance: 0 },
};

const SHORT: FormItem = {
  type: "short",
  id: "q-explain",
  title: "用自己的话解释为什么开口方向由 $a$ 决定。",
  required: false,
  maxLength: 200,
};

const SCALE: FormItem = {
  type: "scale",
  id: "q-confidence",
  title: "对这道题的把握有多大？",
  required: true,
  min: 1,
  max: 5,
  labels: ["完全没底", "很有信心"],
};

const QUIZ_FIELDS: readonly FormItem[] = [SECTION, SINGLE, MULTI, FILL, NUMBER, SHORT, SCALE];

const REQUIREMENT = "出一份初二数学《二次函数》的入门测验，8 道题，每题 4 分";

/** `noUncheckedIndexedAccess` 下取元素要么判空要么断言，这里判空并给出可读的失败信息。 */
function at<T>(list: readonly T[], index: number): T {
  const value = list[index];
  if (value === undefined) throw new Error(`索引 ${String(index)} 不存在（长度 ${String(list.length)}）`);
  return value;
}

describe("deriveTitle", () => {
  it("取需求首行，trim 掉两端空白", () => {
    expect(deriveTitle("  初二数学小测  \n第二行不重要")).toBe("初二数学小测");
  });

  it("首行为空则用兜底标题", () => {
    expect(deriveTitle("")).toBe(DEFAULT_FORM_TITLE);
    expect(deriveTitle("   \n 还有一行")).toBe(DEFAULT_FORM_TITLE);
  });

  it("按码点截断：长需求不超过 40 字，emoji 不会被切开", () => {
    expect(deriveTitle("数".repeat(100))).toHaveLength(DRAFT_TITLE_MAX);
    const emoji = deriveTitle("🎯".repeat(50));
    expect(Array.from(emoji)).toHaveLength(DRAFT_TITLE_MAX);
    expect(emoji).toBe("🎯".repeat(DRAFT_TITLE_MAX));
  });
});

describe("buildPublishDraft — 失败是可判定的", () => {
  it("没有字段：直接失败，不发出会被门禁挡下的请求", () => {
    const result = buildPublishDraft([], REQUIREMENT, "quiz");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("empty-fields");
    expect(result.message).toContain("先生成");
  });

  it("quiz 缺答案：本地预检就报 E_ANSWER_MISSING，并带上定位路径", () => {
    const noAnswer: FormItem = {
      type: "single",
      id: "q-no-answer",
      title: "缺答案的选择题",
      required: true,
      score: 3,
      options: [
        { id: "a", text: "A" },
        { id: "b", text: "B" },
      ],
    };
    const result = buildPublishDraft([noAnswer], REQUIREMENT, "quiz");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("invalid-schema");
    expect(result.message.startsWith(PREFLIGHT_PREFIX)).toBe(true);
    expect(result.message).toContain("E_ANSWER_MISSING@items[0].answer");
  });

  it("quiz 缺分值：报 E_SCORE_SUM（不静默清零，那会把 0 分题洗成合法）", () => {
    const noScore: FormItem = {
      type: "single",
      id: "q-no-score",
      title: "缺分值的选择题",
      required: true,
      options: [
        { id: "a", text: "A" },
        { id: "b", text: "B" },
      ],
      answer: "a",
    };
    const result = buildPublishDraft([noScore], REQUIREMENT, "quiz");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.message).toContain("E_SCORE_SUM@items[0].score");
  });
});

describe("buildPublishDraft — quiz", () => {
  it("请求体走契约形状：title / kind / source / schemaVersion", () => {
    const result = buildPublishDraft(QUIZ_FIELDS, REQUIREMENT, "quiz");
    if (!result.ok) throw new Error(result.message);
    expect(result.request.kind).toBe("quiz");
    expect(result.request.source).toBe("generate");
    expect(result.request.schema.meta.version).toBe(SCHEMA_VERSION);
    expect(result.request.schema.meta.kind).toBe("quiz");
    expect(result.request.title).toBe(REQUIREMENT);
  });

  it("meta.totalScore = 各题 score 之和，且本地预检通过", () => {
    const result = buildPublishDraft(QUIZ_FIELDS, REQUIREMENT, "quiz");
    if (!result.ok) throw new Error(result.message);
    expect(result.totalScore).toBe(16);
    expect(result.request.schema.meta.totalScore).toBe(16);
    // 同一份 schema 交给服务端用的那个校验器，必须也是 ok —— 否则就是"预检放水"。
    expect(validateForm(result.request.schema).ok).toBe(true);
  });

  it("section 进 items 但不带 required/score；七种题型一个不少", () => {
    const result = buildPublishDraft(QUIZ_FIELDS, REQUIREMENT, "quiz");
    if (!result.ok) throw new Error(result.message);
    const items = result.request.schema.items;
    expect(items).toHaveLength(QUIZ_FIELDS.length);
    const section = at(items, 0);
    expect(section.type).toBe("section");
    expect(Object.hasOwn(section, "required")).toBe(false);
    expect(Object.hasOwn(section, "score")).toBe(false);
    expect(items.map((item) => item.type)).toEqual([
      "section",
      "single",
      "multi",
      "fill",
      "number",
      "short",
      "scale",
    ]);
  });

  it("quiz 原样保留答案、分值、bloom、知识点与解析", () => {
    const result = buildPublishDraft(QUIZ_FIELDS, REQUIREMENT, "quiz");
    if (!result.ok) throw new Error(result.message);
    expect(at(result.request.schema.items, 1)).toMatchObject({
      type: "single",
      score: 4,
      bloom: "understand",
      knowledgePoint: "kp-parabola",
      explanation: "$a>0$ 时开口向上。",
      answer: "a",
    });
    expect(at(result.request.schema.items, 3)).toMatchObject({ answer: ["1"] });
    expect(at(result.request.schema.items, 4)).toMatchObject({ answer: { value: 1, tolerance: 0 } });
  });

  it("knowledgePoint 去重后登记进 meta.objectives（R8 的前提）", () => {
    const result = buildPublishDraft(QUIZ_FIELDS, REQUIREMENT, "quiz");
    if (!result.ok) throw new Error(result.message);
    expect(result.request.schema.meta.objectives.map((objective) => objective.id)).toEqual([
      "kp-parabola",
      "kp-completing-square",
    ]);
  });

  it("不改动入参（纯函数）", () => {
    const before = JSON.stringify(QUIZ_FIELDS);
    buildPublishDraft(QUIZ_FIELDS, REQUIREMENT, "quiz");
    expect(JSON.stringify(QUIZ_FIELDS)).toBe(before);
  });
});

describe("buildPublishDraft — 简答分值（省赛 R-01/R-02）", () => {
  const SCORED_SHORT: FormItem = {
    type: "short",
    id: "q-open",
    title: "说说你卡在哪一步。",
    required: false,
    score: 6,
    maxLength: 300,
  };
  const FIELDS: readonly FormItem[] = [SINGLE, FILL, SCORED_SHORT];

  it("简答的分值进 meta.totalScore（全卷满分含简答，与 R6、maxScoreOf 同口径）", () => {
    const result = buildPublishDraft(FIELDS, REQUIREMENT, "quiz");
    if (!result.ok) throw new Error(`草稿应通过预检，实际 ${result.message}`);
    // 4（单选）+ 4（填空）+ 6（简答）= 14：漏掉简答就是 8，学生对不上账。
    expect(result.request.schema.meta.totalScore).toBe(14);
    expect(result.totalScore).toBe(14);
  });

  it("简答的 score 必须真的写进请求体，不能只算在 totalScore 里", () => {
    const result = buildPublishDraft(FIELDS, REQUIREMENT, "quiz");
    if (!result.ok) throw new Error(`草稿应通过预检，实际 ${result.message}`);
    const short = result.request.schema.items.find((item) => item.id === "q-open");
    expect(short).toMatchObject({ type: "short", score: 6 });
  });

  it("问卷里简答仍然不许带 score（R6：survey 没有分值语义）", () => {
    const result = buildPublishDraft(FIELDS, REQUIREMENT, "survey");
    if (!result.ok) throw new Error(`问卷草稿应通过预检，实际 ${result.message}`);
    const short = result.request.schema.items.find((item) => item.id === "q-open");
    expect(short).not.toHaveProperty("score");
    expect(result.request.schema.meta.totalScore).toBeUndefined();
  });
});

describe("buildPublishDraft — survey", () => {
  it("剥掉 score 与 answer，且不写 totalScore", () => {
    const result = buildPublishDraft(QUIZ_FIELDS, REQUIREMENT, "survey");
    if (!result.ok) throw new Error(result.message);

    const serialized = JSON.stringify(result.request.schema);
    expect(serialized).not.toContain('"answer"');
    expect(serialized).not.toContain('"score"');
    expect(serialized).not.toContain("totalScore");
    expect(Object.hasOwn(result.request.schema.meta, "totalScore")).toBe(false);
    expect(result.totalScore).toBeNull();
    expect(result.request.schema.meta.kind).toBe("survey");
  });

  it("带答案的选择题在问卷里也合法（不会报 E_SURVEY_HAS_ANSWER）", () => {
    const result = buildPublishDraft([SINGLE, MULTI, FILL, NUMBER], REQUIREMENT, "survey");
    if (!result.ok) throw new Error(result.message);
    expect(validateForm(result.request.schema).ok).toBe(true);
  });
});

describe("buildPublishDraft — 标题", () => {
  it("超长需求：短标题 ≤40、meta.title ≤200，两者都从需求派生", () => {
    const long = "数".repeat(300);
    const result = buildPublishDraft(QUIZ_FIELDS, long, "quiz");
    if (!result.ok) throw new Error(result.message);
    expect(result.title).toHaveLength(DRAFT_TITLE_MAX);
    expect(result.request.title).toBe(result.title);
    expect(result.request.schema.meta.title).toHaveLength(200);
  });

  it("多行需求：短标题取首行，meta.title 压成一行", () => {
    const result = buildPublishDraft(QUIZ_FIELDS, "第一行标题\n第二行补充说明", "quiz");
    if (!result.ok) throw new Error(result.message);
    expect(result.request.title).toBe("第一行标题");
    expect(result.request.schema.meta.title).toBe("第一行标题 第二行补充说明");
  });

  it("空需求：两处标题都兜底", () => {
    const result = buildPublishDraft(QUIZ_FIELDS, "   ", "quiz");
    if (!result.ok) throw new Error(result.message);
    expect(result.request.title).toBe(DEFAULT_FORM_TITLE);
    expect(result.request.schema.meta.title).toBe(DEFAULT_FORM_TITLE);
  });
});

describe("契约门禁", () => {
  it("quiz 草稿原样通过 createFormRequestSchema（服务端 handleCreateForm 的第一步）", () => {
    const result = buildPublishDraft(QUIZ_FIELDS, REQUIREMENT, "quiz");
    if (!result.ok) throw new Error(result.message);
    const parsed = createFormRequestSchema.safeParse(result.request);
    expect(parsed.success).toBe(true);
  });

  it("survey 草稿同样通过 createFormRequestSchema", () => {
    const result = buildPublishDraft(QUIZ_FIELDS, REQUIREMENT, "survey");
    if (!result.ok) throw new Error(result.message);
    expect(createFormRequestSchema.safeParse(result.request).success).toBe(true);
  });
});

describe("formatGateErrors", () => {
  const error = (code: "E_ANSWER_MISSING" | "E_SCORE_SUM", path: string) => ({
    code,
    path,
    message: code,
    repair: code,
  });

  it("三条以内原样列出，格式与服务端一致（code@path）", () => {
    expect(
      formatGateErrors([error("E_ANSWER_MISSING", "items[0].answer"), error("E_SCORE_SUM", "meta.totalScore")]),
    ).toBe("E_ANSWER_MISSING@items[0].answer、E_SCORE_SUM@meta.totalScore");
  });

  it("超过三条折成（共 N 处），不把真正要看的那条挤掉", () => {
    const text = formatGateErrors([
      error("E_ANSWER_MISSING", "items[0].answer"),
      error("E_ANSWER_MISSING", "items[1].answer"),
      error("E_ANSWER_MISSING", "items[2].answer"),
      error("E_SCORE_SUM", "items[3].score"),
    ]);
    expect(text).toBe(
      "E_ANSWER_MISSING@items[0].answer、E_ANSWER_MISSING@items[1].answer、E_ANSWER_MISSING@items[2].answer（共 4 处）",
    );
  });
});
