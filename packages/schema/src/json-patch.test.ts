/**
 * 通用 JSON Patch：语法按 RFC 6902，落库仍翻译回受限 op。
 *
 * 两组测试分开写：
 * 1. `applyJsonPatch` 只证明指针与六种操作的行为；
 * 2. `translateJsonPatch` 证明「通用语法」没有绕过白名单、结构锁与题型约束。
 */

import { describe, expect, it } from "vitest";

import {
  applyJsonPatch,
  jsonPatchOpsSchema,
  translateJsonPatch,
  type JsonPatchOp,
} from "./json-patch.ts";
import { formSchema, type FormSchema } from "./types.ts";

function base(): FormSchema {
  return formSchema.parse({
    meta: {
      version: 1,
      kind: "quiz",
      title: "小测",
      objectives: [{ id: "kp-a", name: "知识点 A" }],
      totalScore: 15,
    },
    items: [
      { id: "sec-one", type: "section", title: "第一部分", description: "说明" },
      {
        id: "q-single",
        type: "single",
        title: "单选",
        required: true,
        score: 5,
        bloom: "remember",
        knowledgePoint: "kp-a",
        explanation: "因为 A",
        options: [
          { id: "a", text: "选项 A" },
          { id: "b", text: "选项 B" },
        ],
        answer: "a",
      },
      {
        id: "q-short",
        type: "short",
        title: "简答",
        required: false,
        score: 10,
        maxLength: 100,
      },
    ],
  });
}

const okTranslation = (ops: readonly JsonPatchOp[]): ReturnType<typeof translateJsonPatch> =>
  translateJsonPatch(base(), ops);

describe("applyJsonPatch", () => {
  it("add / replace / remove 同时支持对象键与数组下标", () => {
    const added = applyJsonPatch(
      { list: [1, 2], obj: { a: 1 } },
      [
        { op: "add", path: "/list/1", value: 9 },
        { op: "add", path: "/list/-", value: 3 },
        { op: "replace", path: "/obj/a", value: 2 },
        { op: "remove", path: "/obj/a" },
      ],
    );
    expect(added).toEqual({ ok: true, value: { list: [1, 9, 2, 3], obj: {} } });
  });

  it("move 先删后插，copy 保留源值", () => {
    const moved = applyJsonPatch(
      { list: ["a", "b", "c"] },
      [{ op: "move", from: "/list/0", path: "/list/2" }],
    );
    expect(moved).toEqual({ ok: true, value: { list: ["b", "c", "a"] } });

    const copied = applyJsonPatch(
      { list: ["a"] },
      [{ op: "copy", from: "/list/0", path: "/list/-" }],
    );
    expect(copied).toEqual({ ok: true, value: { list: ["a", "a"] } });
  });

  it("JSON Pointer 的 ~1 与 ~0 转义能用", () => {
    const result = applyJsonPatch(
      { "a/b": { "~key": 1 } },
      [{ op: "replace", path: "/a~1b/~0key", value: 2 }],
    );
    expect(result).toEqual({ ok: true, value: { "a/b": { "~key": 2 } } });
  });

  it("test 只读；值不等时不返回半套改动", () => {
    const current = { a: 1, b: 2 };
    const passed = applyJsonPatch(current, [{ op: "test", path: "/a", value: 1 }]);
    expect(passed).toEqual({ ok: true, value: current });

    const failed = applyJsonPatch(current, [
      { op: "replace", path: "/a", value: 9 },
      { op: "test", path: "/a", value: 1 },
    ]);
    expect(failed.ok).toBe(false);
    expect(current).toEqual({ a: 1, b: 2 });
  });

  it("目标不存在或下标非法时明确报错", () => {
    expect(applyJsonPatch({ list: [] }, [{ op: "remove", path: "/list/0" }]).ok).toBe(false);
    expect(applyJsonPatch({ a: 1 }, [{ op: "replace", path: "/b", value: 2 }]).ok).toBe(false);
    expect(applyJsonPatch({ a: 1 }, [{ op: "add", path: "a", value: 2 }]).ok).toBe(false);
    expect(applyJsonPatch({ a: 1 }, [{ op: "add", path: "/a/b", value: 2 }]).ok).toBe(false);
  });

  it("契约拒收多余字段：add 不能带 from", () => {
    expect(
      jsonPatchOpsSchema.safeParse([{ op: "add", path: "/a", value: 1, from: "/b" }]).success,
    ).toBe(false);
  });
});

describe("translateJsonPatch：通用语法 → 受限 op", () => {
  it("replace 题干/分值/必答/解析/标注/字数上限各自翻译成单条 op", () => {
    const result = okTranslation([
      { op: "replace", path: "/items/0/title", value: "新分节" },
      { op: "replace", path: "/items/1/title", value: "新题干" },
      { op: "replace", path: "/items/1/score", value: 8 },
      { op: "replace", path: "/items/1/required", value: false },
      { op: "replace", path: "/items/1/explanation", value: "新解析" },
      { op: "replace", path: "/items/1/bloom", value: "apply" },
      { op: "replace", path: "/items/2/maxLength", value: 300 },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ops.map((op) => op.op)).toEqual([
      "setStem",
      "setStem",
      "setScore",
      "setExplanation",
      "setRequired",
      "setMeta",
      "setMaxLength",
    ]);
  });

  it("选项数组上的 add / remove / move 合并为一条 setOptions", () => {
    const result = okTranslation([
      { op: "add", path: "/items/1/options/-", value: { id: "c", text: "选项 C" } },
      { op: "remove", path: "/items/1/options/0" },
      { op: "move", from: "/items/1/options/0", path: "/items/1/options/1" },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ops).toHaveLength(1);
    expect(result.ops[0]?.op).toBe("setOptions");
  });

  it("改答案翻译成 setAnswer，载荷与题型一致", () => {
    const result = okTranslation([{ op: "replace", path: "/items/1/answer", value: "b" }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ops).toEqual([
      { op: "setAnswer", itemId: "q-single", answer: { type: "single", answer: "b" } },
    ]);
  });

  it("remove 解析键翻译成 setExplanation(null)，落库是删键", () => {
    const result = okTranslation([{ op: "remove", path: "/items/1/explanation" }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ops).toEqual([{ op: "setExplanation", itemId: "q-single", explanation: null }]);
  });

  it("只有 test 时不产生 op；test 不成立则整包拒绝", () => {
    const passed = okTranslation([{ op: "test", path: "/items/1/title", value: "单选" }]);
    expect(passed).toEqual({ ok: true, ops: [] });

    const failed = okTranslation([{ op: "test", path: "/items/1/title", value: "别的" }]);
    expect(failed.ok).toBe(false);
    if (failed.ok) return;
    expect(failed.errors[0]?.code).toBe("json_patch_test_failed");
  });

  it("meta / 题目数量 / 题目 id 都被结构锁住", () => {
    for (const ops of [
      [{ op: "replace", path: "/meta/title", value: "改标题" }],
      [{ op: "add", path: "/items/3", value: { id: "q-new", type: "short", title: "新题", maxLength: 10 } }],
      [{ op: "remove", path: "/items/1" }],
      [{ op: "replace", path: "/items/1/id", value: "q-other" }],
      [{ op: "replace", path: "/items/1/type", value: "multi" }],
    ] satisfies JsonPatchOp[][]) {
      const result = okTranslation(ops);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.errors[0]?.code).toBe("json_patch_unsupported_path");
    }
  });

  it("字段与题型不匹配时在翻译阶段就拒绝", () => {
    const result = okTranslation([{ op: "replace", path: "/items/0/required", value: false }]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.message).toContain("不支持字段 required");
  });

  it("不能通过删除答案键来清空答案", () => {
    const result = okTranslation([{ op: "remove", path: "/items/1/answer" }]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.code).toBe("json_patch_unsupported_change");
  });

  it("把选项删到不足两条时，最终结构校验拒绝", () => {
    const result = okTranslation([{ op: "remove", path: "/items/1/options/0" }]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.code).toBe("json_patch_schema_invalid");
  });
});
