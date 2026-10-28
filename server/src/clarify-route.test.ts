/**
 * `POST /api/clarify`（省赛 R-05）。
 *
 * 这条路由只回答一个问题：「这段需求，还缺哪几个槽位？」
 * 它不生成、不写库、不调模型——所以测试也只看"问得对不对、拒得对不对"。
 */

import { afterEach, describe, expect, it } from "vitest";

import type { ClarifyResponse } from "@intentform/schema";
import { CLARIFY_ANSWER_MAX_CHARS, GENERATE_PRESETS, LIMITS } from "@intentform/schema";

import { call, startTestServer, type TestServer } from "./testing/harness.ts";

let server: TestServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function boot(): Promise<TestServer> {
  server = await startTestServer();
  return server;
}

describe("POST /api/clarify", () => {
  it("含糊需求：最多 3 个追问，槽位按优先级", async () => {
    const app = await boot();
    const response = await call<ClarifyResponse>(app, "POST", "/api/clarify", {
      body: { requirement: "帮我出一份英语卷子" },
    });
    expect(response.status).toBe(200);
    expect(response.json.ok).toBe(true);
    expect(response.json.kind).toBe("quiz");
    expect(response.json.questions).toHaveLength(3);
    expect(response.json.questions.map((question) => question.slot)).toEqual([
      "count",
      "score",
      "types",
    ]);
    for (const question of response.json.questions) {
      expect(question.question.length).toBeGreaterThan(0);
    }
  });

  it("完整需求：一个问题都不问（界面直接开始生成）", async () => {
    const app = await boot();
    for (const preset of GENERATE_PRESETS) {
      const response = await call<ClarifyResponse>(app, "POST", "/api/clarify", {
        body: { requirement: preset.requirement },
      });
      expect(response.status).toBe(200);
      expect(response.json.questions).toEqual([]);
    }
  });

  it("kind 可以显式指定：同一段文字按问卷问，就不问分值", async () => {
    const app = await boot();
    const response = await call<ClarifyResponse>(app, "POST", "/api/clarify", {
      body: { requirement: "帮我出一份英语卷子", kind: "survey" },
    });
    expect(response.status).toBe(200);
    expect(response.json.kind).toBe("survey");
    expect(response.json.questions.map((question) => question.slot)).not.toContain("score");
  });

  it("空需求 / 坏 JSON / 非法 kind → 400", async () => {
    const app = await boot();
    const bodies: readonly unknown[] = [
      { requirement: "   " },
      { requirement: 42 },
      {},
      { requirement: "出 5 题", kind: "exam" },
    ];
    for (const body of bodies) {
      const response = await call(app, "POST", "/api/clarify", { body });
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(response.json).toMatchObject({ ok: false });
    }
    const bad = await call(app, "POST", "/api/clarify", { rawBody: "{" });
    expect(bad.status).toBe(400);
  });

  it(`${String(LIMITS.requirementMaxChars)} 字边界：等长通过、多一字 422`, async () => {
    const app = await boot();
    const equal = await call(app, "POST", "/api/clarify", {
      body: { requirement: "题".repeat(LIMITS.requirementMaxChars) },
    });
    expect(equal.status).toBe(200);
    const over = await call(app, "POST", "/api/clarify", {
      body: { requirement: "题".repeat(LIMITS.requirementMaxChars + 1) },
    });
    expect(over.status).toBe(422);
  });

  it("跨站写保护：没有自定义头 → 403", async () => {
    const app = await boot();
    const response = await call(app, "POST", "/api/clarify", {
      body: { requirement: "帮我出一份英语卷子" },
      csrf: false,
    });
    expect(response.status).toBe(403);
  });

  it("回答长度上限与契约一致（供生成侧校验复用）", () => {
    expect(CLARIFY_ANSWER_MAX_CHARS).toBeGreaterThan(0);
    expect(CLARIFY_ANSWER_MAX_CHARS).toBeLessThanOrEqual(LIMITS.requirementMaxChars);
  });
});
