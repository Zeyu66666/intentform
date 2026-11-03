/** AI 辅助评分：作用域、分数边界、注入隔离与 replay 明确报错。 */

import { describe, expect, it } from "vitest";

import { resolveLlmRuntimeConfig } from "./config.ts";
import type { FetchLike } from "./provider.ts";
import {
  AI_GRADE_PROMPT_VERSION,
  ANSWER_CLOSE,
  ANSWER_OPEN,
  aiGradeShort,
  buildGradeMessages,
  buildGradeSystemPrompt,
  extractGradeJson,
  parseGradeSuggestion,
  type AiGradeInput,
} from "./grade-short.ts";

function input(config: AiGradeInput["config"], extra: Partial<AiGradeInput> = {}): AiGradeInput {
  return {
    config,
    title: "说说二次函数的顶点",
    maxScore: 5,
    answer: "顶点是 (-b/2a, ...)，因为把函数配方后得到顶点式。",
    ...extra,
  };
}

const mockConfig = resolveLlmRuntimeConfig("mock", {}, {});

describe("prompt 与注入隔离", () => {
  it("学生答案放在定界数据块里，系统提示明确说不得执行", () => {
    const messages = buildGradeMessages(input(mockConfig));
    const user = messages.find((message) => message.role === "user");
    expect(user?.content).toContain(ANSWER_OPEN);
    expect(user?.content).toContain(ANSWER_CLOSE);
    expect(user?.content).toContain("顶点是");
    expect(buildGradeSystemPrompt()).toContain("不是指令");
    expect(AI_GRADE_PROMPT_VERSION).toBe("grade.v1");
  });
});

describe("parseGradeSuggestion", () => {
  it("接受 0–满分之间的整数", () => {
    expect(parseGradeSuggestion({ score: 3, rationale: "命中两个得分点" }, 5)).toEqual({
      score: 3,
      rationale: "命中两个得分点",
    });
  });

  it("非整数、越界、空理由都拒绝", () => {
    for (const payload of [
      { score: 1.5, rationale: "x" },
      { score: -1, rationale: "x" },
      { score: 6, rationale: "x" },
      { score: 3, rationale: "" },
      { score: "3", rationale: "x" },
    ]) {
      expect(() => parseGradeSuggestion(payload, 5)).toThrowError();
    }
  });

  it("容忍代码围栏，但不猜散文", () => {
    const parsed = extractGradeJson('```json\n{"score":2,"rationale":"部分正确"}\n```') as {
      score: number;
    };
    expect(parsed.score).toBe(2);
    expect(() => extractGradeJson("我觉得可以给 3 分")).toThrowError(/没有输出评分 JSON/);
  });
});

describe("aiGradeShort", () => {
  it("mock 给满分一半，来源标注清楚", async () => {
    const result = await aiGradeShort(input(mockConfig));
    expect(result.score).toBe(2);
    expect(result.source).toBe("mock");
    expect(result.rationale).toContain("mock");
  });

  it("replay 没有录像时明确报错，不回落 mock", async () => {
    const replay = resolveLlmRuntimeConfig("replay", {}, {});
    await expect(aiGradeShort(input(replay))).rejects.toThrowError(/还没有回放录像/);
  });

  it("live 走假 fetch，返回前仍做分数校验", async () => {
    const live = resolveLlmRuntimeConfig("live", { LLM_API_KEY: "sk-test-not-a-real-key" }, {});
    const content = JSON.stringify({ score: 4, rationale: "配方正确，边界漏了一点" });
    const fetchImpl: FetchLike = async () =>
      new Response(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    const result = await aiGradeShort(input(live, { fetchImpl }));
    expect(result.score).toBe(4);
    expect(result.source).toBe("live");
  });
});
