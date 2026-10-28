/**
 * 「一句话改成操作集」的单元测试。
 *
 * 守的四条：
 * 1. mock 脚本产出的 ops 必须真能应用（否则演示会卡在"建议生成成功但套用失败"）；
 * 2. 模型输出带代码围栏/前后废话时能抠出 JSON，但**只宽容这一种**；
 * 3. 结构不对的 ops 在 llm 层就被拒（不把脏数据交给路由层去补救）；
 * 4. 上游返回的合法 JSON 走通 live 路径——用注入的假 fetch，不联网。
 */

import { describe, expect, it } from "vitest";
import { formSchema } from "@intentform/schema";
import type { FetchLike } from "./provider.ts";
import { resolveLlmRuntimeConfig } from "./config.ts";
import {
  applySuggestedOps,
  describeForm,
  extractOpsJson,
  mockPatchOps,
  parseOpsPayload,
  suggestPatch,
} from "./patch-suggest.ts";

function sampleSchema(): ReturnType<typeof formSchema.parse> {
  // 用最小但**完整合法**的 quiz：单选题要够两个选项（LIMITS.optionsMin = 2），
  // meta 必须带 version / kind / title / objectives（objectives 可以是空数组）。
  return formSchema.parse({
    meta: { version: 1, kind: "quiz", title: "小测：分数加减", objectives: [], totalScore: 15 },
    items: [
      {
        type: "single",
        id: "q_one",
        title: "1/2 + 1/3 = ?",
        score: 5,
        options: [
          { id: "a", text: "5/6" },
          { id: "b", text: "2/5" },
        ],
        answer: "a",
      },
      { type: "short", id: "q_two", title: "说说你的思路", score: 10 },
    ],
  });
}

const liveConfig = resolveLlmRuntimeConfig(
  "live",
  { LLM_API_KEY: "sk-test-not-a-real-key" },
  {},
);

/** 把若干 SSE data 行拼成一个假的 fetch：内容即 `choices[0].delta.content`。 */
function fakeFetch(content: string): FetchLike {
  const chunks = [content.slice(0, 8), content.slice(8)];
  const body = chunks
    .map((piece) => `data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`)
    .join("") + "data: [DONE]\n\n";
  return async () =>
    new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
}

describe("mock 的 ops", () => {
  it("能原样应用，且差异非空", () => {
    const schema = sampleSchema();
    const ops = mockPatchOps(schema);
    expect(ops.length).toBeGreaterThan(0);
    const changes = applySuggestedOps(schema, ops);
    expect(changes.length).toBeGreaterThanOrEqual(ops.length);
  });

  it("不改 id、不改题型——只动题干与分值", () => {
    const schema = sampleSchema();
    for (const op of mockPatchOps(schema)) {
      expect(["setStem", "setScore"]).toContain(op.op);
    }
  });
});

describe("extractOpsJson", () => {
  it("剥掉 ```json 围栏", () => {
    const parsed = extractOpsJson('```json\n{"ops":[]}\n```') as { ops: unknown[] };
    expect(parsed.ops).toEqual([]);
  });

  it("抠出夹在客套话里的对象", () => {
    const parsed = extractOpsJson('好的，改动如下：{"ops":[{"op":"setScore","itemId":"q_one","score":8}]} 请确认') as {
      ops: unknown[];
    };
    expect(parsed.ops).toHaveLength(1);
  });

  it("没有花括号 → llm_invalid_output", () => {
    expect(() => extractOpsJson("我建议你改一下分值")).toThrowError(/没有输出 JSON/);
  });

  it("JSON 坏掉 → llm_invalid_output", () => {
    expect(() => extractOpsJson('{"ops":[}')).toThrowError(/解析失败/);
  });
});

describe("parseOpsPayload", () => {
  it("缺 ops 字段 → 报错（而不是当成空改动）", () => {
    expect(() => parseOpsPayload({ changes: [] })).toThrowError(/没有 ops/);
  });

  it("op 名不在六种之内 → 报错", () => {
    expect(() => parseOpsPayload({ ops: [{ op: "renameForm", title: "x" }] })).toThrowError(/不合法/);
  });

  it("合法 ops 原样返回", () => {
    const ops = parseOpsPayload({ ops: [{ op: "setScore", itemId: "q_one", score: 8 }] });
    expect(ops).toHaveLength(1);
  });
});

describe("describeForm", () => {
  it("把 id / 题型 / 题干 / 分值 / 选项 id 都写进去（模型据此选 itemId）", () => {
    const text = describeForm(sampleSchema());
    expect(text).toContain("id=q_one");
    expect(text).toContain("type=short");
    expect(text).toContain("score=10");
    expect(text).toContain("options=a");
    expect(text).toContain("满分：15");
  });
});

describe("suggestPatch", () => {
  it("mock 模式不碰上游", async () => {
    const result = await suggestPatch({
      config: resolveLlmRuntimeConfig("mock", {}, {}),
      schema: sampleSchema(),
      instruction: "改一下",
    });
    expect(result.source).toBe("mock");
    expect(result.ops.length).toBeGreaterThan(0);
  });

  it("replay 模式明确报缺录像", async () => {
    await expect(
      suggestPatch({
        config: resolveLlmRuntimeConfig("replay", {}, {}),
        schema: sampleSchema(),
        instruction: "改一下",
      }),
    ).rejects.toThrowError(/回放/);
  });

  it("live 模式：合法 JSON 走通并算出差异（假 fetch，不联网）", async () => {
    const result = await suggestPatch({
      config: liveConfig,
      schema: sampleSchema(),
      instruction: "把第一题分值改成 8",
      fetchImpl: fakeFetch('{"ops":[{"op":"setScore","itemId":"q_one","score":8}]}'),
    });
    expect(result.source).toBe("live");
    expect(result.ops).toHaveLength(1);
    expect(result.changes.length).toBeGreaterThan(0);
  });

  it("live 模式：ops 引用了不存在的 itemId → 在 llm 层就拒", async () => {
    await expect(
      suggestPatch({
        config: liveConfig,
        schema: sampleSchema(),
        instruction: "改第九题",
        fetchImpl: fakeFetch('{"ops":[{"op":"setScore","itemId":"nope","score":8}]}'),
      }),
    ).rejects.toThrowError(/没法应用/);
  });
});
