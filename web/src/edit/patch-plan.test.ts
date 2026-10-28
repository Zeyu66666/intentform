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
  withMoveItem,
  withRemoveItem,
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
    expect(plan.request.ops).toEqual(plan.ops);
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

    expect(draft).toEqual({ stem: "只改了题干", score: 10 });
  });
});
