/**
 * 蓝图契约与「蓝图 → 成品」偏差（省赛 R-06）。
 *
 * 蓝图是**承诺**：说 8 题就得是 8 题，说 4 单选 2 填空就得是 4 和 2。
 * 这些用例钉的是「不认嘴上说的、只认能对上账的结构」。
 */

import { describe, expect, it } from "vitest";

import {
  blueprintSchema,
  compareWithBlueprint,
  summarizeBlueprint,
  type FormBlueprint,
} from "./blueprint.ts";
import { formSchema } from "./types.ts";

function blueprintJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: "二次函数入门测验",
    kind: "quiz",
    sections: [
      { title: "基础", count: 4 },
      { title: "应用", count: 4 },
    ],
    totalCount: 8,
    typeMix: { single: 4, fill: 2, short: 2 },
    totalScore: 40,
    knowledgePoints: [
      { id: "kp-open", name: "开口方向" },
      { id: "kp-vertex", name: "顶点坐标" },
    ],
    ...overrides,
  };
}

describe("blueprintSchema", () => {
  it("接受自洽的蓝图", () => {
    const parsed = blueprintSchema.parse(blueprintJson());
    expect(parsed.totalCount).toBe(8);
    expect(parsed.typeMix.single).toBe(4);
  });

  it("章节题量之和 ≠ 总题量 → 拒绝", () => {
    const result = blueprintSchema.safeParse(
      blueprintJson({ sections: [{ title: "基础", count: 3 }] }),
    );
    expect(result.success).toBe(false);
  });

  it("题型分布之和 ≠ 总题量 → 拒绝", () => {
    const result = blueprintSchema.safeParse(
      blueprintJson({ typeMix: { single: 4, fill: 2 } }),
    );
    expect(result.success).toBe(false);
  });

  it("问卷的总分必须是 0", () => {
    const result = blueprintSchema.safeParse(
      blueprintJson({
        kind: "survey",
        typeMix: { short: 4, scale: 4 },
        totalScore: 40,
      }),
    );
    expect(result.success).toBe(false);
  });

  it("题量超过字段上限 → 拒绝", () => {
    const result = blueprintSchema.safeParse(
      blueprintJson({
        sections: [{ title: "全部", count: 999 }],
        totalCount: 999,
        typeMix: { single: 999 },
      }),
    );
    expect(result.success).toBe(false);
  });

  it("接受知识点 + 题型的配额；缺省时 quotas 不存在", () => {
    const withQuotas = blueprintSchema.parse(
      blueprintJson({ quotas: [{ knowledgePoint: "kp-open", type: "short", count: 1 }] }),
    );
    expect(withQuotas.quotas).toEqual([{ knowledgePoint: "kp-open", type: "short", count: 1 }]);
    expect(blueprintSchema.parse(blueprintJson()).quotas).toBeUndefined();
  });

  it("配额指向不存在的知识点 → 拒绝", () => {
    const result = blueprintSchema.safeParse(
      blueprintJson({ quotas: [{ knowledgePoint: "kp-missing", type: "short", count: 1 }] }),
    );
    expect(result.success).toBe(false);
  });

  it("同一知识点 + 题型的配额重复 → 拒绝", () => {
    const result = blueprintSchema.safeParse(
      blueprintJson({
        quotas: [
          { knowledgePoint: "kp-open", type: "short", count: 1 },
          { knowledgePoint: "kp-open", type: "short", count: 1 },
        ],
      }),
    );
    expect(result.success).toBe(false);
  });

  it("配额超过该题型总数 → 拒绝", () => {
    const result = blueprintSchema.safeParse(
      blueprintJson({ quotas: [{ knowledgePoint: "kp-open", type: "short", count: 3 }] }),
    );
    expect(result.success).toBe(false);
  });
});

describe("summarizeBlueprint", () => {
  it("拼成一句人话：8 题 / 单选 4 · 填空 2 · 简答 2 / 共 40 分 / 2 个知识点", () => {
    const summary = summarizeBlueprint(blueprintSchema.parse(blueprintJson()));
    expect(summary).toContain("8 题");
    expect(summary).toContain("单选 4");
    expect(summary).toContain("40 分");
    expect(summary).toContain("顶点坐标");
  });
});

describe("compareWithBlueprint", () => {
  const blueprint: FormBlueprint = blueprintSchema.parse(blueprintJson());

  function quiz(
    items: readonly unknown[],
    objectives: readonly { id: string; name: string }[] = [],
    totalScore = 40,
  ): ReturnType<typeof formSchema.parse> {
    return formSchema.parse({
      meta: { version: 1, kind: "quiz", title: "二次函数入门测验", objectives, totalScore },
      items,
    });
  }

  it("完全对上：偏差全为 0、isExact 为真", () => {
    const schema = quiz(
      [
        { id: "sec-base", type: "section", title: "基础" },
        {
          id: "q-one",
          type: "single",
          title: "a",
          score: 5,
          options: [{ id: "o1", text: "x" }, { id: "o2", text: "y" }],
          answer: "o1",
          knowledgePoint: "kp-open",
        },
        {
          id: "q-two",
          type: "single",
          title: "b",
          score: 5,
          options: [{ id: "o1", text: "x" }, { id: "o2", text: "y" }],
          answer: "o1",
        },
        {
          id: "q-three",
          type: "single",
          title: "c",
          score: 5,
          options: [{ id: "o1", text: "x" }, { id: "o2", text: "y" }],
          answer: "o1",
        },
        {
          id: "q-four",
          type: "single",
          title: "d",
          score: 5,
          options: [{ id: "o1", text: "x" }, { id: "o2", text: "y" }],
          answer: "o1",
        },
        { id: "q-five", type: "fill", title: "e", score: 5, answer: ["x"] },
        { id: "q-six", type: "fill", title: "f", score: 5, answer: ["y"] },
        { id: "q-seven", type: "short", title: "g", score: 5, maxLength: 100 },
        {
          id: "q-eight",
          type: "short",
          title: "h",
          score: 5,
          maxLength: 100,
          knowledgePoint: "kp-vertex",
        },
      ],
      [{ id: "kp-open", name: "开口方向" }, { id: "kp-vertex", name: "顶点坐标" }],
    );
    const deviation = compareWithBlueprint(blueprint, {
      items: schema.items,
      totalScore: schema.meta.totalScore ?? 0,
      objectives: schema.meta.objectives,
    });
    expect(deviation).toMatchObject({ countDelta: 0, scoreDelta: 0, isExact: true });
    expect(deviation.missingKnowledgePoints).toEqual([]);
  });

  it("少出两题、总分少 10、知识点缺一个：偏差如实给出", () => {
    const schema = quiz(
      [
        {
          id: "q-one",
          type: "single",
          title: "a",
          score: 5,
          options: [{ id: "o1", text: "x" }, { id: "o2", text: "y" }],
          answer: "o1",
          knowledgePoint: "kp-open",
        },
        { id: "q-two", type: "fill", title: "b", score: 5, answer: ["x"] },
        { id: "q-three", type: "short", title: "c", score: 5, knowledgePoint: "kp-disc", maxLength: 100 },
      ],
      [
        { id: "kp-open", name: "开口方向" },
        { id: "kp-vertex", name: "顶点坐标" },
        { id: "kp-disc", name: "判别式" },
      ],
      30,
    );
    const deviation = compareWithBlueprint(blueprint, {
      items: schema.items,
      totalScore: schema.meta.totalScore ?? 0,
      objectives: schema.meta.objectives,
    });
    expect(deviation.countDelta).toBe(-5);
    expect(deviation.scoreDelta).toBe(-10);
    expect(deviation.typeMixDelta).toMatchObject({ single: -3, fill: -1, short: -1 });
    expect(deviation.missingKnowledgePoints).toEqual(["kp-vertex"]);
    expect(deviation.extraKnowledgePoints).toEqual(["kp-disc"]);
    expect(deviation.isExact).toBe(false);
  });

  it("分节不算题量（蓝图说的是题目数）", () => {
    const schema = quiz([{ id: "sec-only", type: "section", title: "只有分节" }], [], 0);
    const deviation = compareWithBlueprint(blueprint, {
      items: schema.items,
      totalScore: schema.meta.totalScore ?? 0,
      objectives: schema.meta.objectives,
    });
    expect(deviation.countDelta).toBe(-8);
  });

  it("配额未兑现：列出 (知识点, 题型) 的计划数与实际数，并判为不精确", () => {
    const withQuota = blueprintSchema.parse(
      blueprintJson({ quotas: [{ knowledgePoint: "kp-open", type: "short", count: 1 }] }),
    );
    const schema = quiz([
      {
        id: "q-one",
        type: "single",
        title: "a",
        score: 5,
        options: [{ id: "o1", text: "x" }, { id: "o2", text: "y" }],
        answer: "o1",
        knowledgePoint: "kp-open",
      },
    ]);
    const deviation = compareWithBlueprint(withQuota, {
      items: schema.items,
      totalScore: schema.meta.totalScore ?? 0,
      objectives: schema.meta.objectives,
    });
    expect(deviation.quotaMismatches).toEqual([
      { knowledgePoint: "kp-open", type: "short", planned: 1, actual: 0 },
    ]);
    expect(deviation.isExact).toBe(false);
  });

  it("配额兑现后不再产生配额差异", () => {
    const withQuota = blueprintSchema.parse(
      blueprintJson({ quotas: [{ knowledgePoint: "kp-open", type: "short", count: 1 }] }),
    );
    const schema = quiz(
      [
        { id: "q-seven", type: "short", title: "g", score: 5, maxLength: 100, knowledgePoint: "kp-open" },
      ],
      [{ id: "kp-open", name: "开口方向" }],
    );
    const deviation = compareWithBlueprint(withQuota, {
      items: schema.items,
      totalScore: schema.meta.totalScore ?? 0,
      objectives: schema.meta.objectives,
    });
    expect(deviation.quotaMismatches).toEqual([]);
  });
});
