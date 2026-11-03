/** 覆盖矩阵补题：mock 确定性、模型输出校验、replay 明确报错。 */

import { describe, expect, it } from "vitest";
import { formSchema } from "@intentform/schema";

import { resolveLlmRuntimeConfig } from "./config.ts";
import type { FetchLike } from "./provider.ts";
import {
  SUPPLEMENT_PROMPT_VERSION,
  buildSupplementMessages,
  extractSupplementJson,
  mockSupplementItem,
  parseSupplementItem,
  supplementItem,
  type SupplementInput,
} from "./supplement.ts";

function schema(): ReturnType<typeof formSchema.parse> {
  return formSchema.parse({
    meta: {
      version: 1,
      kind: "quiz",
      title: "二次函数",
      objectives: [{ id: "kp_vertex", name: "顶点坐标" }],
      totalScore: 5,
    },
    items: [{ type: "short", id: "q_one", title: "说说顶点", score: 5, maxLength: 100 }],
  });
}

function input(config: SupplementInput["config"], extra: Partial<SupplementInput> = {}): SupplementInput {
  return {
    config,
    schema: schema(),
    knowledgePoint: "kp_vertex",
    bloom: "apply",
    ...extra,
  };
}

const mockConfig = resolveLlmRuntimeConfig("mock", {}, {});

describe("mockSupplementItem", () => {
  it("产出一道合法单选题，知识点与层级钉在请求上", () => {
    const item = mockSupplementItem(input(mockConfig));
    expect(item.type).toBe("single");
    if (item.type !== "single") return;
    expect(item.knowledgePoint).toBe("kp_vertex");
    expect(item.bloom).toBe("apply");
    expect(item.title).toContain("顶点坐标");
    expect(item.options.some((option) => option.id === item.answer)).toBe(true);
  });

  it("prompt 版本单独命名，不复用 patch", () => {
    expect(SUPPLEMENT_PROMPT_VERSION).toBe("supplement.v1");
  });
});

describe("buildSupplementMessages", () => {
  it("把知识点、层级与额外要求写进用户消息", () => {
    const messages = buildSupplementMessages(input(mockConfig, { instruction: "要带图像" }));
    const user = messages.find((message) => message.role === "user");
    expect(user?.content).toContain("kp_vertex 顶点坐标");
    expect(user?.content).toContain("apply");
    expect(user?.content).toContain("要带图像");
  });
});

describe("parseSupplementItem", () => {
  it("模型输出合法时保留题目，并覆盖作用域字段", () => {
    const item = parseSupplementItem(
      {
        id: "q_model",
        type: "single",
        title: "顶点横坐标",
        required: true,
        score: 5,
        bloom: "remember",
        knowledgePoint: "kp_other",
        options: [
          { id: "a", text: "0" },
          { id: "b", text: "1" },
        ],
        answer: "a",
      },
      "kp_vertex",
      "apply",
    );
    expect(item.bloom).toBe("apply");
    expect(item.knowledgePoint).toBe("kp_vertex");
    expect(item.score).toBe(5);
  });

  it("答案不在选项里 → llm_invalid_output", () => {
    expect(() =>
      parseSupplementItem(
        {
          id: "q_model",
          type: "single",
          title: "题",
          options: [
            { id: "a", text: "A" },
            { id: "b", text: "B" },
          ],
          answer: "z",
        },
        "kp_vertex",
        "apply",
      ),
    ).toThrowError(/答案不在选项里/);
  });

  it("分节 / 量表不能当补题", () => {
    expect(() =>
      parseSupplementItem(
        { id: "sec_one", type: "section", title: "分节" },
        "kp_vertex",
        "apply",
      ),
    ).toThrowError(/不能生成分节或量表/);
  });
});

describe("supplementItem", () => {
  it("replay 没有录像时明确报错，不回落 mock", async () => {
    const replay = resolveLlmRuntimeConfig("replay", {}, {});
    await expect(supplementItem(input(replay))).rejects.toThrowError(/还没有回放录像/);
  });

  it("live 走假 fetch：抠 JSON 后仍做结构校验", async () => {
    const live = resolveLlmRuntimeConfig("live", { LLM_API_KEY: "sk-test-not-a-real-key" }, {});
    const content = JSON.stringify({
      id: "q_model",
      type: "single",
      title: "模型补的题",
      required: true,
      score: 5,
      bloom: "apply",
      knowledgePoint: "kp_vertex",
      options: [
        { id: "a", text: "0" },
        { id: "b", text: "1" },
      ],
      answer: "a",
      explanation: "因为顶点在 x=0",
    });
    const fetchImpl: FetchLike = async () =>
      new Response(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    const result = await supplementItem(input(live, { fetchImpl }));
    expect(result.source).toBe("live");
    expect(result.item.title).toBe("模型补的题");
  });

  it("extractSupplementJson 剥围栏，正文不是 JSON 时明确报错", () => {
    const parsed = extractSupplementJson('```json\n{"id":"q_one"}\n```') as { id: string };
    expect(parsed.id).toBe("q_one");
    expect(() => extractSupplementJson("没有 JSON")).toThrowError(/没有输出题目 JSON/);
  });
});
