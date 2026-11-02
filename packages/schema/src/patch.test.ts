/**
 * 受限修改的纯函数层：十个 op 的语义、拒绝路径、总分自动重算。
 *
 * 这里刻意**不碰 HTTP 与数据库**——`applyPatch` 是前后端共用的那一份规则，
 * 前端拿它做 Diff 预览、服务端拿它落版本，两边跑的必须是同一段代码。
 * 这条不变量靠本文件与 `server/src/forms-route.test.ts` 两侧各测一遍来守。
 */

import { describe, expect, it } from "vitest";
import { applyPatch, patchOpSchema, patchOpsSchema, type PatchOp } from "./patch.ts";
import { formSchema, type FormSchema } from "./types.ts";

/** 最小 quiz：一道单选 5 分 + 一道简答 5 分，总分 10。 */
function quiz(): FormSchema {
  return formSchema.parse({
    meta: { version: 1, kind: "quiz", title: "小测", objectives: [], totalScore: 10 },
    items: [
      {
        id: "q-single",
        type: "single",
        title: "二选一",
        score: 5,
        options: [
          { id: "op1", text: "甲" },
          { id: "op2", text: "乙" },
        ],
        answer: "op1",
      },
      { id: "q-short", type: "short", title: "说说看", score: 5, maxLength: 100 },
    ],
  });
}

function apply(schema: FormSchema, ops: readonly PatchOp[]): ReturnType<typeof applyPatch> {
  return applyPatch(schema, ops);
}

describe("applyPatch：六种操作", () => {
  it("setStem 改题干，只动目标题", () => {
    const result = apply(quiz(), [{ op: "setStem", itemId: "q-single", title: "二选一新题干" }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.schema.items[0]?.title).toBe("二选一新题干");
    expect(result.schema.items[1]?.title).toBe("说说看");
    expect(result.changes).toEqual([
      { op: "setStem", itemId: "q-single", where: "第 1 题", before: "二选一", after: "二选一新题干" },
    ]);
  });

  it("setOptions 换选项，并记一条人话差异", () => {
    const result = apply(quiz(), [
      {
        op: "setOptions",
        itemId: "q-single",
        options: [
          { id: "op1", text: "甲甲" },
          { id: "op2", text: "乙乙" },
        ],
      },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const item = result.schema.items[0];
    expect(item?.type).toBe("single");
    if (item?.type !== "single") return;
    expect(item.options.map((option) => option.text)).toEqual(["甲甲", "乙乙"]);
    expect(result.changes[0]?.before).toBe("甲 / 乙");
    expect(result.changes[0]?.after).toBe("甲甲 / 乙乙");
  });

  it("setScore 改分值，quiz 总分自动跟着重算（不当成两个人的活）", () => {
    const result = apply(quiz(), [{ op: "setScore", itemId: "q-single", score: 8 }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.schema.meta.totalScore).toBe(13);
    // 两条：题目分值、总分。总分那条没有 itemId，界面按「总分」渲染。
    expect(result.changes.map((change) => change.where)).toEqual(["第 1 题", "总分"]);
    expect(result.changes[1]).toMatchObject({ before: "10 分", after: "13 分" });
  });

  it("addItem 插到指定位置，index === length 表示追加", () => {
    const extra = {
      id: "q-fill",
      type: "fill" as const,
      title: "填空",
      required: true,
      score: 2,
      answer: ["答"],
    };
    const result = apply(quiz(), [{ op: "addItem", index: 1, item: extra }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.schema.items.map((item) => item.id)).toEqual(["q-single", "q-fill", "q-short"]);
    expect(result.schema.meta.totalScore).toBe(12);
  });

  it("removeItem 删除题目，总分同步下降", () => {
    const result = apply(quiz(), [{ op: "removeItem", itemId: "q-short" }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.schema.items.map((item) => item.id)).toEqual(["q-single"]);
    expect(result.schema.meta.totalScore).toBe(5);
    expect(result.changes[0]).toMatchObject({ before: "说说看", after: "（已删除）" });
  });

  it("moveItem 调顺序，toIndex 是移动后的下标", () => {
    const result = apply(quiz(), [{ op: "moveItem", itemId: "q-short", toIndex: 0 }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.schema.items.map((item) => item.id)).toEqual(["q-short", "q-single"]);
    expect(result.changes[0]).toMatchObject({ before: "第 2 位", after: "第 1 位" });
  });

  it("多个 op 按顺序叠加，一次算总分", () => {
    const result = apply(quiz(), [
      { op: "setStem", itemId: "q-short", title: "为什么" },
      { op: "setScore", itemId: "q-single", score: 7 },
      { op: "removeItem", itemId: "q-short" },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.schema.items.map((item) => item.id)).toEqual(["q-single"]);
    expect(result.schema.meta.totalScore).toBe(7);
  });
});

describe("applyPatch：拒绝路径", () => {
  it("找不到题目 → patch_item_not_found，并指出第几个 op", () => {
    const result = apply(quiz(), [
      { op: "setStem", itemId: "q-single", title: "ok" },
      { op: "setStem", itemId: "q-nope", title: "改不到" },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual([
      { code: "patch_item_not_found", opIndex: 1, message: "改题干：找不到题目 q-nope" },
    ]);
  });

  it("加题撞 id → patch_duplicate_item_id", () => {
    const result = apply(quiz(), [
      { op: "addItem", index: 0, item: { id: "q-single", type: "short", title: "重名", required: true, maxLength: 10 } },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.code).toBe("patch_duplicate_item_id");
  });

  it("越界插题 → patch_index_out_of_range", () => {
    const result = apply(quiz(), [
      { op: "addItem", index: 5, item: { id: "q-x", type: "short", title: "越界", required: true, maxLength: 10 } },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.code).toBe("patch_index_out_of_range");
  });

  it("给分节改分值 → patch_score_unsupported", () => {
    const withSection = formSchema.parse({
      ...quiz(),
      items: [{ id: "sec-a", type: "section", title: "第一大题" }, ...quiz().items],
    });
    const result = apply(withSection, [{ op: "setScore", itemId: "sec-a", score: 3 }]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.code).toBe("patch_score_unsupported");
  });

  it("给填空题改选项 → patch_options_unsupported", () => {
    const schema = formSchema.parse({
      ...quiz(),
      items: [
        ...quiz().items,
        { id: "q-fill", type: "fill", title: "填空", score: 1, answer: ["x"] },
      ],
    });
    const result = apply(schema, [
      {
        op: "setOptions",
        itemId: "q-fill",
        options: [
          { id: "op1", text: "甲" },
          { id: "op2", text: "乙" },
        ],
      },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.code).toBe("patch_options_unsupported");
  });

  it("组合结果结构不合法（选项被删到不足两条）→ patch_schema_invalid", () => {
    // 单条 op 看不出问题，组合结果才不合法——这正是"applier 之后再跑一遍 zod"的理由。
    // 线缆层其实也会拦（见下面的 patchOpSchema 用例），但纯函数必须自己兜住，
    // 因为前端预览走的是同一个函数、不过线缆。
    const result = apply(quiz(), [
      { op: "setOptions", itemId: "q-single", options: [{ id: "op1", text: "只剩一个" }] },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.code).toBe("patch_schema_invalid");
    expect(result.errors[0]?.message).toContain("items.0.options");
  });
});

describe("applyPatch：空改动不产生版本", () => {
  it("把分值改成原值 → changes 为空（界面据此提示「没有改动」而不是多一版）", () => {
    const result = apply(quiz(), [{ op: "setScore", itemId: "q-single", score: 5 }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changes).toEqual([]);
    expect(result.schema.meta.totalScore).toBe(10);
  });
});

/* ------------------------- P18：单题编辑的四个 op ------------------------- */

describe("applyPatch：setAnswer", () => {
  it("改单选答案只动目标题，差异用选项文字而不是 id", () => {
    const result = apply(quiz(), [
      { op: "setAnswer", itemId: "q-single", answer: { type: "single", answer: "op2" } },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const item = result.schema.items[0];
    expect(item?.type).toBe("single");
    if (item?.type !== "single") return;
    expect(item.answer).toBe("op2");
    expect(result.schema.items[1]?.title).toBe("说说看");
    expect(result.changes).toEqual([
      {
        op: "setAnswer",
        itemId: "q-single",
        where: "第 1 题 · 答案",
        before: "甲",
        after: "乙",
      },
    ]);
  });

  it("载荷 type 与题目 type 不符 → patch_answer_unsupported", () => {
    const result = apply(quiz(), [
      { op: "setAnswer", itemId: "q-single", answer: { type: "multi", answer: ["op1"] } },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.code).toBe("patch_answer_unsupported");
    expect(result.errors[0]?.message).toContain("single");
  });

  it("简答 / 量表 / 分节没有标准答案 → patch_answer_unsupported", () => {
    const withSection = formSchema.parse({
      ...quiz(),
      items: [
        { id: "sec-a", type: "section", title: "第一大题" },
        ...quiz().items,
        { id: "q-scale", type: "scale", title: "满意度", min: 1, max: 5 },
      ],
    });
    for (const itemId of ["q-short", "sec-a", "q-scale"]) {
      const result = apply(withSection, [
        { op: "setAnswer", itemId, answer: { type: "fill", answer: ["x"] } },
      ]);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.errors[0]?.code).toBe("patch_answer_unsupported");
    }
  });

  it("答案没变 → 不产生一条假差异", () => {
    const result = apply(quiz(), [
      { op: "setAnswer", itemId: "q-single", answer: { type: "single", answer: "op1" } },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changes).toEqual([]);
  });
});

describe("applyPatch：setExplanation", () => {
  it("分节的解析写进 description（同一概念：这段说明文字）", () => {
    const withSection = formSchema.parse({
      ...quiz(),
      items: [{ id: "sec-a", type: "section", title: "第一大题" }, ...quiz().items],
    });
    const result = apply(withSection, [
      { op: "setExplanation", itemId: "sec-a", explanation: "本大题考基础运算" },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const section = result.schema.items[0];
    expect(section?.type).toBe("section");
    if (section?.type !== "section") return;
    expect(section.description).toBe("本大题考基础运算");
  });

  it("explanation:null 删键，而不是写空串或 null", () => {
    const withExplanation = formSchema.parse({
      ...quiz(),
      items: quiz().items.map((item) =>
        item.id === "q-single" ? { ...item, explanation: "先移项再相减" } : item,
      ),
    });
    const result = apply(withExplanation, [
      { op: "setExplanation", itemId: "q-single", explanation: null },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const item = result.schema.items[0];
    expect(item).toBeDefined();
    expect(item === undefined ? true : "explanation" in item).toBe(false);
  });

  it("量表没有解析栏 → patch_explanation_unsupported", () => {
    const withScale = formSchema.parse({
      ...quiz(),
      items: [...quiz().items, { id: "q-scale", type: "scale", title: "满意度", min: 1, max: 5 }],
    });
    const result = apply(withScale, [
      { op: "setExplanation", itemId: "q-scale", explanation: "不该有" },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.code).toBe("patch_explanation_unsupported");
  });
});

describe("applyPatch：setRequired", () => {
  it("必答 ↔ 选答，差异写成中文", () => {
    const result = apply(quiz(), [{ op: "setRequired", itemId: "q-short", required: false }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const item = result.schema.items[1];
    if (item === undefined || !("required" in item)) throw new Error("第 2 题没有 required 字段");
    expect(item.required).toBe(false);
    expect(result.changes[0]).toMatchObject({
      where: "第 2 题 · 必答",
      before: "必答",
      after: "选答",
    });
  });

  it("分节没有 required → patch_required_unsupported", () => {
    const withSection = formSchema.parse({
      ...quiz(),
      items: [{ id: "sec-a", type: "section", title: "第一大题" }, ...quiz().items],
    });
    const result = apply(withSection, [{ op: "setRequired", itemId: "sec-a", required: true }]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.code).toBe("patch_required_unsupported");
  });
});

describe("applyPatch：setMeta", () => {
  it("两个字段同改，不出现「改了一个、另一个留在旧值」", () => {
    const result = apply(quiz(), [
      { op: "setMeta", itemId: "q-single", bloom: "apply", knowledgePoint: "kp2" },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const item = result.schema.items[0];
    expect(item?.type).toBe("single");
    if (item?.type !== "single") return;
    expect(item.bloom).toBe("apply");
    expect(item.knowledgePoint).toBe("kp2");
    expect(result.changes[0]?.where).toBe("第 1 题 · 标注");
  });

  it("两个 null 一起清空 = 两个键都删掉", () => {
    const withMeta = formSchema.parse({
      ...quiz(),
      items: quiz().items.map((item) =>
        item.id === "q-single" ? { ...item, bloom: "apply", knowledgePoint: "kp2" } : item,
      ),
    });
    const result = apply(withMeta, [
      { op: "setMeta", itemId: "q-single", bloom: null, knowledgePoint: null },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const item = result.schema.items[0];
    expect(item === undefined ? {} : item).not.toHaveProperty("bloom");
    expect(item === undefined ? {} : item).not.toHaveProperty("knowledgePoint");
  });

  it("量表/分节没有教学标注 → patch_meta_unsupported", () => {
    const withScale = formSchema.parse({
      ...quiz(),
      items: [...quiz().items, { id: "q-scale", type: "scale", title: "满意度", min: 1, max: 5 }],
    });
    const result = apply(withScale, [
      { op: "setMeta", itemId: "q-scale", bloom: "apply", knowledgePoint: null },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.code).toBe("patch_meta_unsupported");
  });
});

describe("applyPatch：setMaxLength", () => {
  it("改简答字数上限", () => {
    const result = apply(quiz(), [{ op: "setMaxLength", itemId: "q-short", maxLength: 300 }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const item = result.schema.items[1];
    expect(item?.type).toBe("short");
    if (item?.type !== "short") return;
    expect(item.maxLength).toBe(300);
    expect(result.changes[0]).toMatchObject({
      where: "第 2 题 · 字数上限",
      before: "100 字",
      after: "300 字",
    });
  });

  it("非简答题 → patch_maxlength_unsupported", () => {
    const result = apply(quiz(), [{ op: "setMaxLength", itemId: "q-single", maxLength: 300 }]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.code).toBe("patch_maxlength_unsupported");
  });
});

describe("applyPatch：新 op 不碰总分", () => {
  it("改答案 / 解析 / 必答 / 标注都不改变 totalScore", () => {
    const result = apply(quiz(), [
      { op: "setAnswer", itemId: "q-single", answer: { type: "single", answer: "op2" } },
      { op: "setExplanation", itemId: "q-single", explanation: "解析" },
      { op: "setRequired", itemId: "q-single", required: false },
      { op: "setMeta", itemId: "q-single", bloom: "apply", knowledgePoint: "kp2" },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.schema.meta.totalScore).toBe(10);
    expect(result.changes.some((change) => change.where === "总分")).toBe(false);
  });
});

describe("patchOpSchema / patchOpsSchema", () => {
  it("未知 op 被拒", () => {
    expect(patchOpSchema.safeParse({ op: "setEverything", itemId: "q-single" }).success).toBe(false);
  });

  it("空 ops 数组被拒（一次改动至少一步）", () => {
    expect(patchOpsSchema.safeParse([]).success).toBe(false);
  });

  it("选项不足两条的 setOptions 在线缆层就进不来", () => {
    expect(
      patchOpSchema.safeParse({
        op: "setOptions",
        itemId: "q-single",
        options: [{ id: "op1", text: "只剩一个" }],
      }).success,
    ).toBe(false);
  });

  it("setScore 负分被拒", () => {
    expect(patchOpSchema.safeParse({ op: "setScore", itemId: "q-single", score: -1 }).success).toBe(false);
  });

  it("setAnswer 缺 type 被拒（载荷必须自带题型）", () => {
    expect(
      patchOpSchema.safeParse({ op: "setAnswer", itemId: "q-single", answer: { answer: "op1" } }).success,
    ).toBe(false);
  });

  it("setMeta 缺一个字段被拒（不做稀疏，避免静默抹掉另一个）", () => {
    expect(
      patchOpSchema.safeParse({ op: "setMeta", itemId: "q-single", bloom: "apply" }).success,
    ).toBe(false);
  });
});
