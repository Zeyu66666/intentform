/**
 * `POST /api/plan`（省赛 R-06）。
 *
 * mock 模式下蓝图是确定性实现，所以这里能断死具体数字：它验的是
 * 「请求怎么解析、品类怎么定、补答怎么拼、失败怎么拒」，不是模型质量。
 */

import { afterEach, describe, expect, it } from "vitest";

import { GENERATE_PRESETS, LIMITS, type PlanResponse } from "@intentform/schema";

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

describe("POST /api/plan", () => {
  it("mock 模式给出确定性蓝图：题量/题型/总分从需求里读得出就读", async () => {
    const app = await boot();
    const response = await call<PlanResponse>(app, "POST", "/api/plan", {
      body: { requirement: "出 5 道单选题，每题 4 分，覆盖《顶点坐标》" },
    });
    expect(response.status).toBe(200);
    expect(response.json.ok).toBe(true);
    expect(response.json.kind).toBe("quiz");
    expect(response.json.blueprint.totalCount).toBe(5);
    expect(response.json.blueprint.typeMix.single).toBe(5);
    expect(response.json.blueprint.totalScore).toBe(20);
    expect(response.json.blueprint.knowledgePoints).toEqual([
      { id: "kp_mock_1", name: "顶点坐标" },
    ]);
    expect(response.json.summary).toContain("5 题");
  });

  it("同一需求两次调用结果一致（确定性）", async () => {
    const app = await boot();
    const body = { requirement: "出 8 道题：4 道单选、4 道填空，共 40 分" };
    const first = await call<PlanResponse>(app, "POST", "/api/plan", { body });
    const second = await call<PlanResponse>(app, "POST", "/api/plan", { body });
    expect(second.json.blueprint).toEqual(first.json.blueprint);
  });

  it("补答会先拼进需求再规划（与生成用的是同一串）", async () => {
    const app = await boot();
    const response = await call<PlanResponse>(app, "POST", "/api/plan", {
      body: { requirement: "帮我出一份英语卷子", clarifications: [{ slot: "count", answer: "10 题" }] },
    });
    expect(response.status).toBe(200);
    expect(response.json.requirement).toContain("【教师补充的约束】");
    expect(response.json.requirement).toContain("题量：10 题");
    expect(response.json.blueprint.totalCount).toBe(10);
  });

  it("品类以请求为准：选了问卷，蓝图就是问卷、总分 0", async () => {
    const app = await boot();
    const response = await call<PlanResponse>(app, "POST", "/api/plan", {
      body: { requirement: "出 3 道单选题", kind: "survey" },
    });
    expect(response.json.kind).toBe("survey");
    expect(response.json.blueprint.kind).toBe("survey");
    expect(response.json.blueprint.totalScore).toBe(0);
  });

  it("空需求 / 非法 kind / 非法补答 → 400；超长 → 422", async () => {
    const app = await boot();
    const bad: readonly unknown[] = [
      { requirement: "   " },
      { requirement: 42 },
      {},
      { requirement: "出 5 题", kind: "exam" },
      { requirement: "出 5 题", clarifications: [{ slot: "subject", answer: "数学" }] },
    ];
    for (const body of bad) {
      const response = await call(app, "POST", "/api/plan", { body });
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    const over = await call(app, "POST", "/api/plan", {
      body: { requirement: "题".repeat(LIMITS.requirementMaxChars + 1) },
    });
    expect(over.status).toBe(422);
  });

  it("跨站写保护：没有自定义头 → 403", async () => {
    const app = await boot();
    const response = await call(app, "POST", "/api/plan", {
      body: { requirement: "出 5 道单选题" },
      csrf: false,
    });
    expect(response.status).toBe(403);
  });

  it("三条预置需求都能规划出结构（界面上的主线路径）", async () => {
    const app = await boot();
    for (const preset of GENERATE_PRESETS) {
      const response = await call<PlanResponse>(app, "POST", "/api/plan", {
        body: { requirement: preset.requirement },
      });
      expect(response.status).toBe(200);
      expect(response.json.blueprint.totalCount).toBeGreaterThan(0);
    }
  });
});
