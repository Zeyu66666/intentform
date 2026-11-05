import { describe, expect, it } from "vitest";

import { formSchema, type FormSchema } from "@intentform/schema";

import { buildPrintSheet, optionLetter, printHeaderText } from "./sheet";

function quiz(): FormSchema {
  return formSchema.parse({
    meta: {
      version: 1,
      kind: "quiz",
      title: "打印测试卷",
      objectives: [],
      totalScore: 15,
    },
    items: [
      { id: "sec-one", type: "section", title: "第一大题", description: "每题 5 分" },
      {
        id: "q-single",
        type: "single",
        title: "单选题",
        required: true,
        score: 5,
        options: [
          { id: "op1", text: "甲" },
          { id: "op2", text: "乙" },
        ],
        answer: "op2",
        explanation: "因为乙",
      },
      {
        id: "q-fill",
        type: "fill",
        title: "填空题",
        required: true,
        score: 5,
        answer: ["2", "4"],
      },
      { id: "q-short", type: "short", title: "简答题", required: false, score: 5, maxLength: 100 },
    ],
  });
}

describe("optionLetter", () => {
  it("0 → A、25 → Z，超过 26 个不重复也不抛错", () => {
    expect(optionLetter(0)).toBe("A");
    expect(optionLetter(25)).toBe("Z");
    expect(optionLetter(26)).toBe("A1");
    expect(optionLetter(27)).toBe("B1");
  });
});

describe("buildPrintSheet", () => {
  it("题号只数题目：分节不占号", () => {
    const rows = buildPrintSheet(quiz(), { withAnswers: false });
    const questions = rows.filter((row) => row.kind === "question");
    expect(questions.map((row) => (row.kind === "question" ? row.no : 0))).toEqual([1, 2, 3]);
    expect(rows[0]?.kind).toBe("section");
  });

  it("默认不含答案：行里连 answer/explanation 字段都没有", () => {
    const rows = buildPrintSheet(quiz(), { withAnswers: false });
    for (const row of rows) {
      if (row.kind !== "question") continue;
      expect(row).not.toHaveProperty("answer");
      expect(row).not.toHaveProperty("explanation");
    }
  });

  it("含答案时给出可读答案：选项 id 换成文字，多空用「／」", () => {
    const rows = buildPrintSheet(quiz(), { withAnswers: true });
    const single = rows.find((row) => row.kind === "question" && row.id === "q-single");
    const fill = rows.find((row) => row.kind === "question" && row.id === "q-fill");
    const short = rows.find((row) => row.kind === "question" && row.id === "q-short");
    expect(single?.kind === "question" ? single.answer : "").toBe("乙");
    expect(single?.kind === "question" ? single.explanation : "").toBe("因为乙");
    expect(fill?.kind === "question" ? fill.answer : "").toBe("2／4");
    // 简答没有标准答案：不出现 answer 键，而不是补一个空串。
    expect(short).not.toHaveProperty("answer");
  });

  it("不再生成作答横线：题目行里没有 blanks 字段", () => {
    const rows = buildPrintSheet(quiz(), { withAnswers: false });
    for (const row of rows) {
      if (row.kind !== "question") continue;
      expect(row).not.toHaveProperty("blanks");
    }
  });

  it("选项带 A/B 字母，顺序与 schema 一致", () => {
    const rows = buildPrintSheet(quiz(), { withAnswers: false });
    const single = rows.find((row) => row.kind === "question" && row.id === "q-single");
    expect(single?.kind === "question" ? single.options : []).toEqual([
      { letter: "A", text: "甲" },
      { letter: "B", text: "乙" },
    ]);
  });
});

describe("printHeaderText", () => {
  it("测验写满分；问卷不写分数", () => {
    expect(printHeaderText(quiz())).toBe("测验 · 满分 15 分");
    const survey = formSchema.parse({
      meta: { version: 1, kind: "survey", title: "问卷", objectives: [] },
      items: [{ id: "s-advice", type: "short", title: "建议", required: false, maxLength: 100 }],
    });
    expect(printHeaderText(survey)).toBe("问卷");
  });
});
