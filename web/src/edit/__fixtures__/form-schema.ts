/**
 * 编辑页纯函数层测试用的 Schema 夹具。
 *
 * 不以 `.test.ts` 结尾，所以 vitest 不会把它当测试收集；但 `tsconfig.json` 覆盖
 * src 下全部 `.ts`，类型照样过严格模式——夹具写错一个字段这里就会红。
 *
 * 形状刻意挑得"难改一点"：中间夹一道分节（无分值）、一道简答（有分值、无选项，
 * 正是加题模板用的题型），这样移动/删除/改分值的用例都在真实排版里跑，
 * 而不是在"全是单选题"的理想排列里跑。
 */

import type { FormSchema } from "@intentform/schema";

/** 测试用的基准草稿版本号；真实值是 nanoid，这里只要能对上就行。 */
export const BASE_VERSION_ID = "ver-base-1";

/**
 * quiz：5 + 10 = 15 分，`totalScore` 与逐题之和一致。
 * 分节不参与计分，用它来验"给分节写草稿分值不会变成一条 op"。
 */
export const QUIZ_SCHEMA: FormSchema = {
  meta: {
    version: 1,
    kind: "quiz",
    title: "第一单元小测",
    objectives: [
      { id: "obj-prime", name: "识别质数" },
      { id: "obj-reason", name: "说清推理过程" },
    ],
    totalScore: 15,
  },
  items: [
    {
      id: "q-single",
      type: "single",
      title: "下列哪个是质数？",
      required: true,
      options: [
        { id: "a", text: "9" },
        { id: "b", text: "11" },
      ],
      answer: "b",
      score: 5,
    },
    { id: "sec-mid", type: "section", title: "第二部分：简答" },
    {
      id: "q-short",
      type: "short",
      title: "说说你是怎么判断的",
      required: true,
      maxLength: 200,
      score: 10,
    },
  ],
};

/** survey：没有分值与总分，验"survey 加题不带 score"。 */
export const SURVEY_SCHEMA: FormSchema = {
  meta: {
    version: 1,
    kind: "survey",
    title: "课堂反馈",
    objectives: [{ id: "obj-feedback", name: "收集课堂感受" }],
  },
  items: [
    {
      id: "s-scale",
      type: "scale",
      title: "这节课的难度",
      required: true,
      min: 1,
      max: 5,
    },
  ],
};
