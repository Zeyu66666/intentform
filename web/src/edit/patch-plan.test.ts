/**
 * `patch-plan.ts` 的测试。
 *
 * 只测纯函数，不碰 DOM：这一层的价值恰恰是"把界面拿掉之后，编辑态到 op 数组的
 * 映射仍然成立"。`planPatch()` 自己会调真正的 `applyPatch()`，所以这些用例同时
 * 也是"前端没有偷偷重算分数/拼 Schema"的守门员——若哪天有人绕过 `applyPatch`
 * 自己算总分，`changes` 里那条「总分」就会对不上。
 */

import { describe, expect, it } from "vitest";

import type { FormItem, FormSchema } from "@intentform/schema";
import { LIMITS } from "@intentform/schema";

import {
  type EditState,
  type PatchPlan,
  draftOf,
  initialEditState,
  moveTargets,
  nextItemId,
  planPatch,
  resolveSelection,
  withAddItem,
  withAnswer,
  withClearItemDraft,
  withExplanation,
  withMaxLength,
  withMeta,
  withMoveItem,
  withOptions,
  withRemoveItem,
  withRequired,
  withScore,
  withSelection,
  withStem,
} from "./patch-plan";
import { BASE_VERSION_ID, QUIZ_SCHEMA, SURVEY_SCHEMA } from "./__fixtures__/form-schema";

function base(): EditState {
  return initialEditState(QUIZ_SCHEMA, BASE_VERSION_ID);
}

/** 把 `PatchPlan` 收窄到成功分支；拒绝时直接把错误信息抛出来，省得每处都写 if。 */
function expectOk(plan: PatchPlan): Extract<PatchPlan, { ok: true }> {
  if (!plan.ok) throw new Error(`预期可以保存，实际被拒：${plan.kind} ${plan.message}`);
  return plan;
}

function itemById(schema: FormSchema, itemId: string): FormItem {
  const found = schema.items.find((item) => item.id === itemId);
  if (found === undefined) throw new Error(`Schema 里没有这道题：${itemId}`);
  return found;
}

describe("planPatch", () => {
  it("改分值：出一条 setScore，且总分变化由 applyPatch 补出来", () => {
    const plan = expectOk(planPatch(withScore(base(), "q-single", 8)));

    expect(plan.ops).toEqual([{ op: "setScore", itemId: "q-single", score: 8 }]);
    expect(plan.hasChanges).toBe(true);
    // 两条：一题的分值 + 总分。总分那条**不是**前端算的，是被测代码没法伪造的旁证。
    expect(plan.changes.map((change) => change.where)).toEqual(["第 1 题", "总分"]);
    expect(plan.changes[0]?.before).toBe("5 分");
    expect(plan.changes[0]?.after).toBe("8 分");
  });

  it("没有改动：ops 与 changes 都为空，保存按钮不该亮", () => {
    const plan = expectOk(planPatch(base()));

    expect(plan.ops).toEqual([]);
    expect(plan.changes).toEqual([]);
    expect(plan.hasChanges).toBe(false);
    // 没有 op 时不必再跑 applyPatch，预览就是读回来的那份 Schema（同一引用即可）。
    expect(plan.preview).toBe(QUIZ_SCHEMA);
  });

  it("改回原值不算改动：changes 为空而不是一条 before === after", () => {
    const dirty = withScore(base(), "q-single", 8);
    const plan = expectOk(planPatch(withScore(dirty, "q-single", 5)));

    expect(plan.changes).toEqual([]);
    expect(plan.hasChanges).toBe(false);
  });

  it("改题干：预览 Schema 里的题干就是新题干，且题干已 trim", () => {
    const plan = expectOk(planPatch(withStem(base(), "q-single", "  下列哪个是合数？ ")));

    expect(itemById(plan.preview, "q-single").title).toBe("下列哪个是合数？");
    expect(plan.ops).toEqual([
      { op: "setStem", itemId: "q-single", title: "下列哪个是合数？" },
    ]);
    expect(plan.changes[0]?.where).toBe("第 1 题");
  });

  it("加题：题目数 +1，新 id 不与现有 id 重复且符合 id 规则", () => {
    const plan = expectOk(planPatch(withAddItem(base())));

    expect(plan.preview.items).toHaveLength(QUIZ_SCHEMA.items.length + 1);
    const existing = new Set(QUIZ_SCHEMA.items.map((item) => item.id));
    const added = plan.preview.items[plan.preview.items.length - 1];
    if (added === undefined) throw new Error("预览里没有新加的题");

    expect(existing.has(added.id)).toBe(false);
    expect(added.id).toMatch(LIMITS.idPattern);
    // 加题 op 的 index 是"追加"，也就是当前长度。
    expect(plan.ops).toEqual([
      { op: "addItem", index: QUIZ_SCHEMA.items.length, item: expect.objectContaining({ id: added.id }) },
    ]);
    expect(plan.changes[0]?.where).toBe(`第 ${String(QUIZ_SCHEMA.items.length + 1)} 题`);
  });

  it("连加两题：第二题拿到下一个序号，不会与第一题撞 id", () => {
    const plan = expectOk(planPatch(withAddItem(withAddItem(base()))));

    expect(nextItemId(QUIZ_SCHEMA.items)).toBe("q-new-1");
    expect(nextItemId(plan.preview.items)).toBe("q-new-3");
    expect(plan.preview.items).toHaveLength(QUIZ_SCHEMA.items.length + 2);
    expect(plan.preview.items[4]?.id).toBe("q-new-2");
  });

  it("加题后立刻改新题题干：不会顺手把它的分值清零", () => {
    const plan = expectOk(
      planPatch(withStem(withAddItem(base()), "q-new-1", "我新加的一道简答题")),
    );

    // 只有 addItem 与 setStem：新题没被碰过的分值不该凭空出现一条 setScore。
    expect(plan.ops.map((op) => op.op)).toEqual(["addItem", "setStem"]);
    expect(itemById(plan.preview, "q-new-1").title).toBe("我新加的一道简答题");
    expect(itemById(plan.preview, "q-new-1").type).toBe("short");
  });

  it("删题：预览少一题，changes 记下被删题的题干", () => {
    const plan = expectOk(planPatch(withRemoveItem(base(), "sec-mid")));

    expect(plan.preview.items).toHaveLength(QUIZ_SCHEMA.items.length - 1);
    expect(plan.preview.items.some((item) => item.id === "sec-mid")).toBe(false);
    expect(plan.ops).toEqual([{ op: "removeItem", itemId: "sec-mid" }]);
    expect(plan.changes[0]?.before).toBe("第二部分：简答");
  });

  it("删掉当前选中的题：选中回落到第一题，而不是留一个不存在的 id", () => {
    const state = withSelection(base(), "sec-mid");
    const plan = expectOk(planPatch(withRemoveItem(state, "sec-mid")));

    const selection = resolveSelection(plan.preview, state.selectedItemId);
    expect(selection?.id).toBe("q-single");
  });

  it("移动：toIndex 是移动后的下标，预览顺序随之变化", () => {
    const plan = expectOk(planPatch(withMoveItem(base(), "q-single", 1)));

    expect(plan.ops).toEqual([{ op: "moveItem", itemId: "q-single", toIndex: 1 }]);
    expect(plan.preview.items[0]?.id).toBe("sec-mid");
    expect(plan.preview.items[1]?.id).toBe("q-single");
    expect(plan.changes[0]?.where).toBe("第 1 题");
  });

  it("moveTargets：首题没有上移、末题没有下移（按钮据此禁用）", () => {
    expect(moveTargets(QUIZ_SCHEMA.items, "q-single")).toEqual({ up: null, down: 1 });
    expect(moveTargets(QUIZ_SCHEMA.items, "q-short")).toEqual({ up: 1, down: null });
    expect(moveTargets(QUIZ_SCHEMA.items, "nope")).toEqual({ up: null, down: null });
  });

  it("两处改动都在：ops 顺序与题目列表一致，请求体带当前基准版本", () => {
    const state = withScore(withStem(base(), "q-single", "改过的题干"), "q-short", 20);
    const plan = expectOk(planPatch(state));

    expect(plan.ops.map((op) => op.op)).toEqual(["setStem", "setScore"]);
    expect(plan.request.baseVersionId).toBe(BASE_VERSION_ID);
    expect("ops" in plan.request ? plan.request.ops : null).toEqual(plan.ops);
  });

  it("补题预填：手工模板带上知识点与布鲁姆层级", () => {
    const id = nextItemId(base().schema.items);
    const state = withSelection(
      withAddItem(base(), { id, knowledgePoint: "kp-a", bloom: "apply" }),
      id,
    );
    const plan = expectOk(planPatch(state));
    const added = itemById(plan.preview, id);
    if (!("bloom" in added)) throw new Error("新题应带 bloom");
    expect(added.bloom).toBe("apply");
    expect(added.knowledgePoint).toBe("kp-a");
  });

  it("模型补题：整道候选题原样成为 addItem，不由前端改字段", () => {
    const item: FormItem = {
      id: "q_model",
      type: "single",
      title: "模型补的题",
      required: true,
      score: 5,
      bloom: "apply",
      knowledgePoint: "kp-a",
      options: [
        { id: "a", text: "A" },
        { id: "b", text: "B" },
      ],
      answer: "a",
    };
    const plan = expectOk(planPatch(withSelection(withAddItem(base(), { item }), item.id)));
    const added = itemById(plan.preview, "q_model");
    expect(added.title).toBe("模型补的题");
    expect(plan.ops.some((op) => op.op === "addItem" && op.item.id === "q_model")).toBe(true);
  });

  it("草稿跨题保留：切走再改另一题，前一题的改动还在预览里", () => {
    const first = withStem(base(), "q-single", "第一题改过");
    const plan = expectOk(planPatch(withScore(withSelection(first, "q-short"), "q-short", 30)));

    expect(itemById(plan.preview, "q-single").title).toBe("第一题改过");
    expect(plan.ops).toHaveLength(2);
  });

  it("分节的草稿分值不会变成一条注定失败的 op", () => {
    const plan = expectOk(planPatch(withScore(base(), "sec-mid", 10)));

    expect(plan.ops).toEqual([]);
    expect(plan.hasChanges).toBe(false);
  });

  it("空题干与越界分值在本地就被拦住，不发请求", () => {
    const blank = planPatch(withStem(base(), "q-single", "   "));
    expect(blank.ok).toBe(false);
    if (blank.ok) return;
    expect(blank.kind).toBe("invalid-input");
    expect(blank.message).toContain("题干不能为空");

    const tooBig = planPatch(withScore(base(), "q-single", LIMITS.scoreMax + 1));
    expect(tooBig.ok).toBe(false);
    if (tooBig.ok) return;
    expect(tooBig.kind).toBe("invalid-input");

    const fractional = planPatch(withScore(base(), "q-single", 7.5));
    expect(fractional.ok).toBe(false);
  });

  it("survey 加题不带分值（语义规则：问卷没有分）", () => {
    const plan = expectOk(planPatch(withAddItem(initialEditState(SURVEY_SCHEMA, BASE_VERSION_ID))));

    const added = plan.preview.items[plan.preview.items.length - 1];
    expect(added?.type).toBe("short");
    expect(added !== undefined && "score" in added).toBe(false);
  });

  it("draftOf：没碰过的字段回落到 Schema 的值，界面不用自己兜底", () => {
    const state = withStem(base(), "q-short", "只改了题干");
    const draft = draftOf(state, itemById(QUIZ_SCHEMA, "q-short"));

    expect(draft).toStrictEqual({
      stem: "只改了题干",
      score: 10,
      options: null,
      answer: null,
      explanation: "",
      required: true,
      bloom: null,
      knowledgePoint: null,
      maxLength: 200,
    });
  });

  it("改选项文字：只出一条 setOptions，答案 op 不跟着冒出来", () => {
    const plan = expectOk(
      planPatch(
        withOptions(base(), "q-single", [
          { id: "a", text: "9（合数）" },
          { id: "b", text: "11（质数）" },
        ]),
      ),
    );

    expect(plan.ops).toEqual([
      {
        op: "setOptions",
        itemId: "q-single",
        options: [
          { id: "a", text: "9（合数）" },
          { id: "b", text: "11（质数）" },
        ],
      },
    ]);
    expect(itemById(plan.preview, "q-single")).toMatchObject({
      options: [
        { id: "a", text: "9（合数）" },
        { id: "b", text: "11（质数）" },
      ],
      answer: "b",
    });
  });

  it("勾正确项：出一条 setAnswer，changes 用选项文字而不是 id", () => {
    const plan = expectOk(planPatch(withAnswer(base(), "q-single", { type: "single", answer: "a" })));

    expect(plan.ops).toEqual([
      { op: "setAnswer", itemId: "q-single", answer: { type: "single", answer: "a" } },
    ]);
    expect(plan.changes[0]).toMatchObject({
      where: "第 1 题 · 答案",
      before: "11",
      after: "9",
    });
    expect(itemById(plan.preview, "q-single")).toMatchObject({ answer: "a" });
  });

  it("删掉正确项：答案引用了不存在的选项，本地就拦住", () => {
    const plan = planPatch(
      withOptions(base(), "q-single", [
        { id: "a", text: "9" },
        { id: "c", text: "13" },
      ]),
    );

    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.kind).toBe("invalid-input");
    expect(plan.message).toContain("正确答案不在选项里");
  });

  it("改解析：空串落成 null（删键），不是写空字符串", () => {
    const withText = expectOk(planPatch(withExplanation(base(), "q-short", "因为 11 只有 1 和它本身两个因数")));
    expect(withText.ops).toEqual([
      {
        op: "setExplanation",
        itemId: "q-short",
        explanation: "因为 11 只有 1 和它本身两个因数",
      },
    ]);
    expect(itemById(withText.preview, "q-short")).toMatchObject({
      explanation: "因为 11 只有 1 和它本身两个因数",
    });

    // 清空要有东西可清：Schema 里本来就有解析，才谈得上"删键"。
    const withExisting: FormSchema = {
      meta: QUIZ_SCHEMA.meta,
      items: QUIZ_SCHEMA.items.map((item) =>
        item.id === "q-short" && item.type === "short" ? { ...item, explanation: "原有解析" } : item,
      ),
    };
    const cleared = expectOk(
      planPatch(withExplanation(initialEditState(withExisting, BASE_VERSION_ID), "q-short", "   ")),
    );
    expect(cleared.ops).toEqual([{ op: "setExplanation", itemId: "q-short", explanation: null }]);
    expect("explanation" in itemById(cleared.preview, "q-short")).toBe(false);
  });

  it("分节的说明走 setExplanation，预览写到 description", () => {
    const plan = expectOk(planPatch(withExplanation(base(), "sec-mid", "这一部分考推理")));

    expect(plan.ops).toEqual([
      { op: "setExplanation", itemId: "sec-mid", explanation: "这一部分考推理" },
    ]);
    expect(itemById(plan.preview, "sec-mid")).toMatchObject({ description: "这一部分考推理" });
  });

  it("必答与教学标注：各出一条 op，标注两个字段同时给", () => {
    const required = expectOk(planPatch(withRequired(base(), "q-single", false)));
    expect(required.ops).toEqual([{ op: "setRequired", itemId: "q-single", required: false }]);
    expect(required.changes[0]).toMatchObject({ where: "第 1 题 · 必答", before: "必答", after: "选答" });

    const meta = expectOk(
      planPatch(withMeta(base(), "q-single", { bloom: "apply", knowledgePoint: "obj-prime" })),
    );
    expect(meta.ops).toEqual([
      { op: "setMeta", itemId: "q-single", bloom: "apply", knowledgePoint: "obj-prime" },
    ]);
    expect(itemById(meta.preview, "q-single")).toMatchObject({
      bloom: "apply",
      knowledgePoint: "obj-prime",
    });
  });

  it("简答改字数上限：一条 setMaxLength；越界在本地拦", () => {
    const plan = expectOk(planPatch(withMaxLength(base(), "q-short", 300)));
    expect(plan.ops).toEqual([{ op: "setMaxLength", itemId: "q-short", maxLength: 300 }]);
    expect(itemById(plan.preview, "q-short")).toMatchObject({ maxLength: 300 });

    const tooBig = planPatch(withMaxLength(base(), "q-short", LIMITS.shortMaxLengthCap + 1));
    expect(tooBig.ok).toBe(false);
    if (tooBig.ok) return;
    expect(tooBig.message).toContain("字数上限");
  });

  it("解析超长在本地拦：不发一个注定 400 的请求", () => {
    const plan = planPatch(withExplanation(base(), "q-short", "长".repeat(LIMITS.explanationMax + 1)));

    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.kind).toBe("invalid-input");
    expect(plan.message).toContain("解析最多");
  });

  it("survey 不产答案与分值 op（R5）", () => {
    const survey: FormSchema = {
      meta: { ...SURVEY_SCHEMA.meta },
      items: [
        {
          id: "s-single",
          type: "single",
          title: "今天听懂了吗？",
          required: true,
          options: [
            { id: "a", text: "听懂了" },
            { id: "b", text: "没听懂" },
          ],
          answer: "a",
        },
      ],
    };
    const state = withScore(withAnswer(initialEditState(survey, BASE_VERSION_ID), "s-single", { type: "single", answer: "b" }), "s-single", 5);
    const plan = expectOk(planPatch(state));

    expect(plan.ops).toEqual([]);
    expect(plan.hasChanges).toBe(false);
  });

  it("这题改回原样：只删草稿，不产生任何 op", () => {
    const dirty = withAnswer(withExplanation(base(), "q-single", "改过的解析"), "q-single", {
      type: "single",
      answer: "a",
    });
    expect(planPatch(dirty).ok).toBe(true);

    const cleared = expectOk(planPatch(withClearItemDraft(dirty, "q-single")));
    expect(cleared.ops).toEqual([]);
    expect(cleared.hasChanges).toBe(false);
    expect(cleared.preview).toBe(QUIZ_SCHEMA);
  });
});
