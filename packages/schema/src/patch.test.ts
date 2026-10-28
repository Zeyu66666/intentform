/**
 * 受限修改的纯函数层：六个 op 的语义、拒绝路径、总分自动重算。
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
});
