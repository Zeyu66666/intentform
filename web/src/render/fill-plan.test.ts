import type { FormItem, PublicFormItem } from "@intentform/schema";
import { describe, expect, it } from "vitest";

// 假帧的字段本身就是**合法 FormItem**（组帧时过过 sseEventSchema），
// 直接复用，避免在测试里手搓第二套样例。
import { FIXTURE_ITEMS } from "../stream/__fixtures__/fake-frames";
import { toFillItem, toFillItems, toFillRenderPlan } from "./fill-plan";

const ALL: readonly FormItem[] = FIXTURE_ITEMS;

/** 递归收集所有键名，用来断言"某些键根本没进渲染计划"。 */
function collectKeys(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, into);
    return into;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      into.add(key);
      collectKeys(child, into);
    }
  }
  return into;
}

describe("toFillItems · 复用 schema 的 publicView", () => {
  it("7 种题型全部保留（投影不是过滤整题）", () => {
    const projected = toFillItems(ALL);
    expect(projected).toHaveLength(7);
    expect(projected.map((item) => item.type)).toEqual([
      "section",
      "single",
      "multi",
      "number",
      "fill",
      "short",
      "scale",
    ]);
  });

  it("投影后的 JSON 里没有 answer / explanation 键", () => {
    const json = JSON.stringify(toFillItems(ALL));
    expect(json).not.toContain('"answer"');
    expect(json).not.toContain('"explanation"');
  });

  it("解析文本本身也不能留在字符串里（不是只删键）", () => {
    const json = JSON.stringify(toFillItems(ALL));
    expect(json).not.toContain("二次项系数");
    expect(json).not.toContain("配方");
  });

  it("单节点投影与批量投影一致", () => {
    const single: PublicFormItem | undefined = toFillItems(ALL)[1];
    const one = toFillItem(ALL[1] as FormItem);
    expect(one).toEqual(single);
  });
});

describe("toFillRenderPlan · 作答控件", () => {
  const plans = ALL.map((item) => toFillRenderPlan(toFillItem(item)));

  it("single → 单选选项，id/text 原样", () => {
    const plan = plans[1];
    expect(plan?.control).toEqual({
      kind: "single",
      options: [
        { id: "a", text: "向上" },
        { id: "b", text: "向下" },
        { id: "c", text: "向左" },
        { id: "d", text: "无法确定" },
      ],
    });
  });

  it("multi → 多选选项", () => {
    expect(plans[2]?.control.kind).toBe("multi");
  });

  it("fill → 单行文本，不给答案", () => {
    expect(plans[4]?.control).toEqual({ kind: "text", maxLength: 200, multiline: false });
  });

  it("short → 多行文本，maxLength 取题干自己的上限", () => {
    expect(plans[5]?.control).toEqual({ kind: "text", maxLength: 200, multiline: true });
  });

  it("scale → 量表区间与两端标签", () => {
    expect(plans[6]?.control).toEqual({
      kind: "scale",
      min: 1,
      max: 5,
      labels: ["完全没底", "很有信心"],
    });
  });

  it("section → 分节标题带描述，且不需要作答", () => {
    expect(plans[0]?.control).toEqual({ kind: "section" });
    expect(plans[0]?.required).toBe(false);
    expect(plans[0]?.description).toContain("开口方向");
  });

  it("number → 数值输入", () => {
    expect(plans[3]?.control).toEqual({ kind: "number" });
  });
});

describe("toFillRenderPlan · 答案不泄露（硬安全要求）", () => {
  const plans = ALL.map((item) => toFillRenderPlan(toFillItem(item)));

  it("渲染计划上不存在 score / bloom / knowledgePoint 键", () => {
    const keys = collectKeys(plans);
    expect(keys.has("score")).toBe(false);
    expect(keys.has("bloom")).toBe(false);
    expect(keys.has("knowledgePoint")).toBe(false);
    expect(keys.has("answer")).toBe(false);
    expect(keys.has("explanation")).toBe(false);
  });

  it("单选题答案 'a' 只以选项 id 形式存在，不作为单独字段出现", () => {
    const plan = plans[1];
    expect(plan?.control.kind).toBe("single");
    if (plan?.control.kind !== "single") throw new Error("unreachable");
    // 选项 id 是合法载荷（学生要提交它），但 plan 顶层不能有 answer 字段。
    expect(Object.keys(plan)).not.toContain("answer");
    expect(plan.control.options.map((option) => option.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("数值题容差与填空答案字符串整体消失", () => {
    const json = JSON.stringify(plans);
    expect(json).not.toContain("tolerance");
    expect(json).not.toContain('"-3"');
  });

  it("所有 plan 的键集合是封闭白名单（新增字段必须先想清楚会不会泄题）", () => {
    for (const plan of plans) {
      expect(Object.keys(plan).sort()).toEqual(["control", "description", "id", "required", "title", "type"]);
    }
  });
});

describe("render 层是第二道闸门：不依赖 schema 层的剥离", () => {
  it("publicView 剥了 answer/explanation/bloom/knowledgePoint 但保留 score，plan 里一个都不剩", () => {
    // 这条断言是回归哨兵：schema 层（04c0e6f）负责剥答案类字段，render 层再按白名单重建一次。
    // 只要有人图省事直接拿 PublicFormItem 渲染，score 就会漏进学生视图——所以 plan 这一步不可省。
    const [sectionless] = toFillItems(ALL).filter((item) => item.type === "single");
    expect(sectionless).toBeDefined();

    const projected = JSON.stringify(sectionless);
    expect(projected).not.toContain('"answer"');
    expect(projected).not.toContain('"explanation"');
    expect(projected).not.toContain('"bloom"');
    expect(projected).not.toContain('"knowledgePoint"');
    // 但 score 仍在：这是 schema 层有意保留的（教师/统计要用），只能靠这里剥。
    expect(projected).toContain('"score"');

    const plan = sectionless === undefined ? null : toFillRenderPlan(sectionless);
    expect(JSON.stringify(plan)).not.toContain('"score"');
  });
});
