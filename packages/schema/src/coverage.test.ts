import { describe, expect, it } from "vitest";

import { coverageMatrixOf, type FormSchema } from "@intentform/schema";

function schema(items: FormSchema["items"]): FormSchema {
  return {
    meta: {
      version: 1,
      kind: "quiz",
      title: "覆盖矩阵测试",
      objectives: [
        { id: "kp-a", name: "基础概念" },
        { id: "kp-b", name: "综合应用" },
      ],
      totalScore: 10,
    },
    items,
  };
}

describe("coverageMatrixOf", () => {
  it("按实际题目计数，并保留所有知识点与六个空层级", () => {
    const matrix = coverageMatrixOf(
      schema([
        {
          type: "single",
          id: "q-01",
          title: "概念题",
          required: true,
          score: 5,
          bloom: "remember",
          knowledgePoint: "kp-a",
          options: [{ id: "a", text: "正确" }, { id: "b", text: "错误" }],
          answer: "a",
        },
        {
          type: "short",
          id: "q-02",
          title: "未标注题",
          required: true,
          score: 5,
          maxLength: 100,
        },
        {
          type: "section",
          id: "sec-1",
          title: "第二节",
        },
      ]),
    );

    expect(matrix.blooms).toEqual(["remember", "understand", "apply", "analyze", "evaluate", "create"]);
    expect(matrix.rows).toEqual([
      {
        objectiveId: "kp-a",
        objectiveName: "基础概念",
        counts: { remember: 1, understand: 0, apply: 0, analyze: 0, evaluate: 0, create: 0 },
      },
      {
        objectiveId: "kp-b",
        objectiveName: "综合应用",
        counts: { remember: 0, understand: 0, apply: 0, analyze: 0, evaluate: 0, create: 0 },
      },
    ]);
  });

  it("只读取 schema 中已有的标注，不为蓝图知识点补造行", () => {
    const matrix = coverageMatrixOf(schema([]));
    expect(matrix.rows.map((row) => row.objectiveId)).toEqual(["kp-a", "kp-b"]);
    expect(matrix.rows.every((row) => Object.values(row.counts).every((count) => count === 0))).toBe(true);
  });
});
