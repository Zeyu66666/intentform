import { describe, expect, it } from "vitest";

import { formItemSchema } from "@intentform/schema";
import type { SseEventBody } from "@intentform/schema";

import { REPLAY_MISS_HINT } from "./fixtures.ts";
import { generateForm, inferFormKind, placeholderVersionId } from "./generate.ts";
import type { LlmRuntimeConfig } from "./config.ts";
import { resolveLlmRuntimeConfig } from "./config.ts";
import type { DeltaSource, SourceDelta } from "./sources.ts";
import { MOCK_BROKEN_LINE_ID, mockLines } from "./sources.ts";

const MOCK_CONFIG: LlmRuntimeConfig = resolveLlmRuntimeConfig("mock", {}, {});

/** 用一个固定脚本替代真实来源：测试只关心「编排怎么处理这些 delta」。 */
function scriptedSource(deltas: readonly string[], label = "mock" as const): DeltaSource {
  return {
    label,
    async *stream(): AsyncGenerator<SourceDelta, void, undefined> {
      let t = 0;
      for (const delta of deltas) {
        t += 1;
        yield { kind: "content", delta, tMs: t };
      }
    },
  };
}

async function collect(
  deps: Parameters<typeof generateForm>[0],
  requirement: string,
): Promise<SseEventBody[]> {
  const bodies: SseEventBody[] = [];
  for await (const body of generateForm(deps, { requirement })) bodies.push(body);
  return bodies;
}

function types(bodies: readonly SseEventBody[]): string[] {
  return bodies.map((body) => body.type);
}

describe("generateForm · mock 模式", () => {
  it("跑完整序列：phase 进度 → field → usage → done，终态唯一且在最后", async () => {
    const bodies = await collect({ config: MOCK_CONFIG }, "出一份初二数学测验，8 道题");

    const terminal = bodies.filter((body) => body.type === "done" || body.type === "error");
    expect(terminal.map((body) => body.type)).toEqual(["done"]);

    const phases = bodies
      .filter((body): body is Extract<SseEventBody, { type: "phase" }> => body.type === "phase")
      .map((body) => body.phase);
    expect(phases).toEqual(["understand", "plan", "generate", "validate", "repair", "done"]);
    expect(phases.at(-1)).toBe("done");

    const fields = bodies.filter((body): body is Extract<SseEventBody, { type: "field" }> => body.type === "field");
    // 5 个一次通过 + 1 个修复后补上的（索引按通过顺序分配，所以补上的排在最后）。
    expect(fields.map((field) => field.index)).toEqual([0, 1, 2, 3, 4, 5]);
    for (const field of fields) expect(() => formItemSchema.parse(field.node)).not.toThrow();

    const done = bodies.at(-1);
    expect(done).toMatchObject({
      type: "done",
      stats: { fields: mockLines("x").length, errors: 0, repairs: 1 },
    });
    const usage = bodies.find((body) => body.type === "usage");
    expect(usage).toMatchObject({ type: "usage" });
    if (usage !== undefined && usage.type === "usage") {
      expect(usage.promptTokens).toBeGreaterThan(0);
      expect(usage.completionTokens).toBeGreaterThan(0);
    }
  });

  it("修复环是真实路径：坏行 → field_error → repair(fixed) → 补回 field，门禁照样放行", async () => {
    const bodies = await collect({ config: MOCK_CONFIG }, "出一份初二数学测验，8 道题");

    const errors = bodies.filter(
      (body): body is Extract<SseEventBody, { type: "field_error" }> => body.type === "field_error",
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]?.id).toBe(MOCK_BROKEN_LINE_ID);
    // bloom 不是 6 级之一 → 结构码 + 语义码都要报出来，前端才能提示"该修哪"
    expect(errors[0]?.codes).toEqual(expect.arrayContaining(["E_SCHEMA_SHAPE", "E_BLOOM_INVALID"]));

    const repairs = bodies.filter(
      (body): body is Extract<SseEventBody, { type: "repair" }> => body.type === "repair",
    );
    expect(repairs).toHaveLength(1);
    expect(repairs[0]).toMatchObject({
      id: MOCK_BROKEN_LINE_ID,
      round: 1,
      status: "fixed",
      codesAfter: [],
    });
    // 单调性：修复前的码集合非空且真包含修复后的空集合
    expect((repairs[0]?.codesBefore ?? []).length).toBeGreaterThan(0);

    const repaired = bodies
      .filter((body): body is Extract<SseEventBody, { type: "field" }> => body.type === "field")
      .find((body) => body.node.id === MOCK_BROKEN_LINE_ID);
    expect(repaired).toBeDefined();
    // 修好的行必须真的被改对了，而不是只把错误码吞掉：答案要回到选项集合内
    expect(JSON.stringify(repaired?.node)).toContain('"answer":"a"');

    // 修复有效 → 整表门禁通过 → 终态是 done，而不是"修过就报错"
    // `errors` 统计的是「修完仍未解决的行数」，这一行修好了所以是 0；`repairs` 记修复次数。
    expect(bodies.at(-1)).toMatchObject({ type: "done", stats: { errors: 0, repairs: 1 } });
  });

  it("mock 不落盘、不联网：重复跑两次事件体完全一致（除时间字段）", async () => {
    const strip = (bodies: readonly SseEventBody[]): string =>
      JSON.stringify(
        bodies.map((body) =>
          body.type === "field"
            ? { ...body, tMs: 0 }
            : body.type === "usage"
              ? { ...body, ms: 0 }
              : body.type === "phase"
                ? { ...body, ts: 0 }
                : body.type === "done"
                  ? { ...body, stats: { ...body.stats, ms: 0 } }
                  : body,
        ),
      );
    const first = strip(await collect({ config: MOCK_CONFIG }, "同一份需求"));
    const second = strip(await collect({ config: MOCK_CONFIG }, "同一份需求"));
    expect(first).toBe(second);
  });
});

describe("generateForm · 坏行处理", () => {
  it("坏行发 field_error 但不掐流：后面的好行照常渲染", async () => {
    // 好行必须是**可判分题**：§2.5 门禁要求整表至少一道判分题，
    // 只给一个分节的话终态会是 error，这条测试要证明的「不掐流」就测不到了。
    const good = `${JSON.stringify({
      type: "single",
      id: "q01",
      title: "一题",
      score: 4,
      bloom: "remember",
      knowledgePoint: "kp1",
      options: [
        { id: "a", text: "甲" },
        { id: "b", text: "乙" },
      ],
      answer: "a",
    })}\n`;
    const bodies = await collect(
      { config: MOCK_CONFIG, source: scriptedSource(['{"type":"single","id":\n', good]) },
      "测试",
    );

    const errors = bodies.filter(
      (body): body is Extract<SseEventBody, { type: "field_error" }> => body.type === "field_error",
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]?.codes).toEqual(["E_SCHEMA_SHAPE"]);
    expect(errors[0]?.raw.length).toBeLessThanOrEqual(200);
    expect(types(bodies).filter((type) => type === "field")).toHaveLength(1);
    expect(bodies.at(-1)).toMatchObject({ type: "done", stats: { fields: 1, errors: 1 } });
  });

  it("一个节点都没成功 → 终态 llm_invalid_output（不再假装 done）", async () => {
    const bodies = await collect(
      { config: MOCK_CONFIG, source: scriptedSource(["不是 JSON\n", '{"type":"nope"}\n']) },
      "测试",
    );
    expect(bodies.at(-1)).toMatchObject({ type: "error", code: "llm_invalid_output" });
  });

  it("修复只有在错误码集合严格变小时才算 fixed", async () => {
    const broken = `${JSON.stringify({
      type: "fill",
      id: "q_fill",
      title: "缺答案的填空题",
      score: 5,
      bloom: "remember",
      knowledgePoint: "kp_basic",
      answer: [],
    })}\n`;
    // 同上：门禁要求整表至少一道可判分题（§2.5），只给分节的话终态会是 error。
    const good = `${JSON.stringify({
      type: "single",
      id: "q_good",
      title: "一题",
      score: 5,
      bloom: "remember",
      knowledgePoint: "kp_basic",
      options: [
        { id: "a", text: "甲" },
        { id: "b", text: "乙" },
      ],
      answer: "a",
    })}\n`;
    const bodies = await collect(
      {
        config: MOCK_CONFIG,
        source: scriptedSource([broken, good]),
        // 第一轮：换了个错法（错误码集合没变小）→ 必须判 failed 并停止。
        repair: () =>
          Promise.resolve([
            `${JSON.stringify({
              type: "fill",
              id: "q_fill",
              title: "还是错的",
              score: 5,
              bloom: "memorize",
              knowledgePoint: "kp_basic",
              answer: [],
            })}\n`,
          ]),
      },
      "测试",
    );

    const repairs = bodies.filter(
      (body): body is Extract<SseEventBody, { type: "repair" }> => body.type === "repair",
    );
    expect(repairs).toHaveLength(1);
    expect(repairs[0]?.status).toBe("failed");
    expect(repairs[0]?.round).toBe(1);
    expect(bodies.at(-1)).toMatchObject({ type: "done", stats: { repairs: 0, errors: 1 } });
  });
});

describe("generateForm · replay 未命中", () => {
  it("没录过的需求 → error 事件码 llm_config，提示改 mock 或重录，绝不静默成功", async () => {
    const config = resolveLlmRuntimeConfig("replay", {}, { fixtureDir: "./fixtures/replays-does-not-exist" });
    const bodies = await collect({ config }, "这条需求从来没有被录过");

    const last = bodies.at(-1);
    expect(last?.type).toBe("error");
    if (last?.type === "error") {
      expect(last.code).toBe("llm_config");
      expect(last.retryable).toBe(false);
      expect(last.message).toContain("回放未命中");
    }
    expect(bodies.some((body) => body.type === "done")).toBe(false);
  });
});

describe("纯函数", () => {
  it("inferFormKind：问卷关键词判 survey，其余判 quiz", () => {
    expect(inferFormKind("做一份学习习惯调查问卷")).toBe("survey");
    expect(inferFormKind("出一份初二数学测验")).toBe("quiz");
  });

  it("placeholderVersionId 稳定且以 gen_ 开头", () => {
    const a = placeholderVersionId("需求", "deepseek-chat");
    const b = placeholderVersionId("需求", "deepseek-chat");
    expect(a).toBe(b);
    expect(a.startsWith("gen_")).toBe(true);
    expect(placeholderVersionId("需求", "other-model")).not.toBe(a);
  });

  it("REPLAY_MISS_HINT 明确说了「不伪造结果」与两条出路", () => {
    expect(REPLAY_MISS_HINT).toContain("回放未命中");
    expect(REPLAY_MISS_HINT).toContain("LLM_MODE=mock");
    expect(REPLAY_MISS_HINT).toContain("record");
  });
});

describe("generateForm · 整表门禁（§2.5）", () => {
  it("门禁不过时不发 done：survey 需求 + 判分题 → 终态是 error", async () => {
    // 需求里带「问卷/调查」→ kind 判为 survey；而模型给出的是一条带 answer 的单选题，
    // 逐行校验会放它过去（这一行自己是合法的），只有整表规则能看出矛盾。
    const single = {
      type: "single",
      id: "q_habit",
      title: "你每天学习多久？",
      required: true,
      score: 5,
      bloom: "remember",
      knowledgePoint: "kp1",
      options: [
        { id: "a", text: "1 小时以内" },
        { id: "b", text: "1 小时以上" },
      ],
      answer: "a",
    };
    const bodies = await collect(
      { config: MOCK_CONFIG, source: scriptedSource([`${JSON.stringify(single)}
`]) },
      "做一份学习习惯调查问卷，5 道题",
    );

    expect(bodies.some((body) => body.type === "done")).toBe(false);
    const terminal = bodies.at(-1);
    expect(terminal).toMatchObject({ type: "error", code: "llm_invalid_output" });
    // 报错文案不许把内部规则原文甩给用户
    expect(String(terminal?.type === "error" ? terminal.message : "")).toContain("整表校验未通过");
  });

  it("门禁不过时把节点级矛盾作为 field_error 回喂，而不是只给一个笼统终态", async () => {
    const broken = {
      type: "single",
      id: "q_bad",
      title: "答案 id 写错的题",
      required: true,
      score: 5,
      bloom: "remember",
      knowledgePoint: "kp1",
      options: [
        { id: "a", text: "甲" },
        { id: "b", text: "乙" },
      ],
      answer: "zzz",
    };
    const bodies = await collect(
      { config: MOCK_CONFIG, source: scriptedSource([`${JSON.stringify(broken)}
`]) },
      "出一份初二数学测验",
    );

    const gateErrors = bodies.filter(
      (body): body is Extract<SseEventBody, { type: "field_error" }> => body.type === "field_error",
    );
    expect(gateErrors.some((body) => body.codes.includes("E_ANSWER_NOT_IN_OPTIONS"))).toBe(true);
    expect(bodies.some((body) => body.type === "done")).toBe(false);
  });
});

describe("generateForm · 澄清说明（R-05）", () => {
  async function collectWithClarify(clarifyNote: string | undefined): Promise<SseEventBody[]> {
    const bodies: SseEventBody[] = [];
    const options =
      clarifyNote === undefined
        ? { requirement: "出一份初二数学测验，8 道题" }
        : { requirement: "出一份初二数学测验，8 道题", clarifyNote };
    for await (const body of generateForm({ config: MOCK_CONFIG }, options)) bodies.push(body);
    return bodies;
  }

  it("有澄清就多发一条 thinking，且排在 understand 之后、plan 之前", async () => {
    const bodies = await collectWithClarify("澄清 2 项：题量=8 题、总分=40 分");
    const clarifyIndex = bodies.findIndex(
      (body) => body.type === "thinking" && body.delta.includes("澄清 2 项"),
    );
    expect(clarifyIndex).toBeGreaterThan(-1);
    const understandIndex = bodies.findIndex(
      (body) => body.type === "phase" && body.phase === "understand",
    );
    const planIndex = bodies.findIndex((body) => body.type === "phase" && body.phase === "plan");
    expect(clarifyIndex).toBeGreaterThan(understandIndex);
    expect(clarifyIndex).toBeLessThan(planIndex);
  });

  it("没有澄清就不许在时间线上演出澄清（只发真实事件）", async () => {
    const bodies = await collectWithClarify(undefined);
    expect(
      bodies.some((body) => body.type === "thinking" && body.delta.includes("澄清")),
    ).toBe(false);
  });
});
