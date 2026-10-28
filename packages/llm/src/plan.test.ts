/**
 * 蓝图调用（省赛 R-06）：一个独立 prompt、一个独立回放键、一条明确的失败路径。
 *
 * 这里刻意不测「模型答得好不好」——那是 eval 的事。这里只测**编排口径**：
 * 输出必须结构化、不合法必须重试一次、再不行必须报错（不许降级成没有蓝图）。
 */

import { describe, expect, it } from "vitest";

import { LIMITS } from "@intentform/schema";

import { resolveLlmRuntimeConfig } from "./config.ts";
import { LlmError } from "./errors.ts";
import { PLAN_PROMPT_VERSION, buildPlanMessages, planForm } from "./plan.ts";
import type { DeltaSource } from "./sources.ts";

const MOCK_CONFIG = resolveLlmRuntimeConfig("mock", {}, {});

function scripted(outputs: readonly string[], calls?: { count: number }): DeltaSource {
  let next = 0;
  return {
    label: "mock",
    async *stream() {
      if (calls !== undefined) calls.count += 1;
      const text = outputs[Math.min(next, outputs.length - 1)] ?? "";
      next += 1;
      yield { kind: "content", delta: text, tMs: 1 };
    },
  };
}

const GOOD_BLUEPRINT = JSON.stringify({
  title: "二次函数入门测验",
  kind: "quiz",
  sections: [{ title: "基础", count: 5 }],
  totalCount: 5,
  typeMix: { single: 5 },
  totalScore: 25,
  knowledgePoints: [{ id: "kp_vertex", name: "顶点坐标" }],
});

describe("buildPlanMessages", () => {
  it("系统提示带 plan 版本，用户消息把需求包在定界块里", () => {
    const messages = buildPlanMessages("出一份测验");
    expect(messages[0]?.content).toContain(PLAN_PROMPT_VERSION);
    expect(messages[0]?.content).toContain("一行 JSON");
    expect(messages[1]?.content).toContain("出一份测验");
    expect(messages[1]?.content).toContain("<<<REQUIREMENT");
  });
});

describe("planForm", () => {
  it("合法输出：解析成蓝图，字段齐全", async () => {
    const blueprint = await planForm(
      { config: MOCK_CONFIG, source: scripted([GOOD_BLUEPRINT]) },
      { requirement: "出 5 道单选题" },
    );
    expect(blueprint.totalCount).toBe(5);
    expect(blueprint.typeMix.single).toBe(5);
    expect(blueprint.knowledgePoints).toEqual([{ id: "kp_vertex", name: "顶点坐标" }]);
  });

  it("模型加了代码围栏也能读（容错但不放宽校验）", async () => {
    const fenced = ["```json", GOOD_BLUEPRINT, "```"].join("\n");
    const blueprint = await planForm(
      { config: MOCK_CONFIG, source: scripted([fenced]) },
      { requirement: "出 5 道单选题" },
    );
    expect(blueprint.totalCount).toBe(5);
  });

  it("第一次不合法 → 重试一次；第二次合法就成功", async () => {
    const calls = { count: 0 };
    const blueprint = await planForm(
      { config: MOCK_CONFIG, source: scripted(["这不是 JSON", GOOD_BLUEPRINT], calls) },
      { requirement: "出 5 道单选题" },
    );
    expect(calls.count).toBe(2);
    expect(blueprint.totalCount).toBe(5);
  });

  it("两次都不合法 → 抛 llm_invalid_output（不降级成没有蓝图）", async () => {
    const calls = { count: 0 };
    await expect(
      planForm({ config: MOCK_CONFIG, source: scripted(["坏", "还是坏"], calls) }, {
        requirement: "出 5 道单选题",
      }),
    ).rejects.toBeInstanceOf(LlmError);
    expect(calls.count).toBe(2);
  });

  it("自洽性不过（题量对不上）也算不合法", async () => {
    const inconsistent = JSON.stringify({
      ...JSON.parse(GOOD_BLUEPRINT),
      totalCount: 8,
    });
    await expect(
      planForm({ config: MOCK_CONFIG, source: scripted([inconsistent, inconsistent]) }, {
        requirement: "出 5 道单选题",
      }),
    ).rejects.toMatchObject({ code: "llm_invalid_output" });
  });

  it("mock 模式：确定性蓝图，题量/题型/总分从需求里读得出就读", async () => {
    const first = await planForm({ config: MOCK_CONFIG }, { requirement: "出 5 道单选题，每题 4 分" });
    const second = await planForm({ config: MOCK_CONFIG }, { requirement: "出 5 道单选题，每题 4 分" });
    expect(second).toEqual(first);
    expect(first.totalCount).toBe(5);
    expect(first.typeMix.single).toBe(5);
    expect(first.totalScore).toBe(20);
  });

  it("mock 问卷：总分恒为 0", async () => {
    const blueprint = await planForm({ config: MOCK_CONFIG }, { requirement: "做个 6 道题的学情问卷" });
    expect(blueprint.kind).toBe("survey");
    expect(blueprint.totalScore).toBe(0);
    expect(blueprint.totalCount).toBe(6);
  });

  it("题量不超过 schema 上限（模型写疯了也不让它过契约）", async () => {
    const crazy = JSON.stringify({
      ...JSON.parse(GOOD_BLUEPRINT),
      sections: [{ title: "全部", count: LIMITS.fieldsMax + 50 }],
      totalCount: LIMITS.fieldsMax + 50,
      typeMix: { single: LIMITS.fieldsMax + 50 },
    });
    await expect(
      planForm({ config: MOCK_CONFIG, source: scripted([crazy, crazy]) }, {
        requirement: "出一堆题",
      }),
    ).rejects.toMatchObject({ code: "llm_invalid_output" });
  });
});
