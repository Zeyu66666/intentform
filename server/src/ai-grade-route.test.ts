/**
 * AI 辅助评分（A-23）：默认关闭、只对简答、只回建议不落库。
 *
 * 这组测试同时也是 AGENTS §5 新增例外的守门员：关闭时连模型都不该被调用。
 */

import { afterEach, describe, expect, it } from "vitest";
import type {
  AiGradeResponse,
  FormSettingsResponse,
  SubmissionsResponse,
  SubmitResponse,
} from "@intentform/schema";

import { scoredShortQuizSchema } from "./testing/fixtures.ts";
import {
  call,
  createPublishedQuiz,
  login,
  seedTeacher,
  startTestServer,
  type PublishedQuiz,
  type TestServer,
} from "./testing/harness.ts";

const ANSWERS = {
  "q-single": "op1",
  "q-multi": ["op1", "op3"],
  "q-fill": ["2", "x"],
  "q-number": "3.14",
  "q-short": "先把函数配方，顶点横坐标是 -b/2a。",
};

let server: TestServer | undefined;

async function boot(): Promise<{ app: TestServer; cookie: string; quiz: PublishedQuiz }> {
  server = await startTestServer();
  seedTeacher(server.db);
  const cookie = await login(server);
  const quiz = await createPublishedQuiz(server, cookie, "quiz", scoredShortQuizSchema());
  return { app: server, cookie, quiz };
}

async function submit(app: TestServer, quiz: PublishedQuiz): Promise<string> {
  const response = await call<SubmitResponse>(app, "POST", "/api/submissions", {
    body: { slug: quiz.slug, formVersionId: quiz.versionId, answers: ANSWERS },
  });
  expect(response.status).toBe(201);
  return response.json.submissionId;
}

async function setAi(app: TestServer, cookie: string, formId: string, enabled: boolean) {
  const response = await call<FormSettingsResponse>(app, "POST", `/api/forms/${formId}/settings`, {
    body: { showAnswersAfterSubmit: false, aiGradingEnabled: enabled },
    cookie,
  });
  expect(response.status).toBe(200);
  return response.json;
}

afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe("POST /api/forms/:id/submissions/:submissionId/ai-grade", () => {
  it("默认关闭：403，且不写任何人工分", async () => {
    const { app, cookie, quiz } = await boot();
    const submissionId = await submit(app, quiz);
    const response = await call(app, "POST", `/api/forms/${quiz.formId}/submissions/${submissionId}/ai-grade`, {
      body: { itemId: "q-short" },
      cookie,
    });
    expect(response.status).toBe(403);
    expect(response.json).toMatchObject({ error: "forbidden" });
    const count = app.db
      .prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM manual_grades")
      .get();
    expect(count?.c).toBe(0);
  });

  it("开启后回建议分与理由，但不落分", async () => {
    const { app, cookie, quiz } = await boot();
    const submissionId = await submit(app, quiz);
    const settings = await setAi(app, cookie, quiz.formId, true);
    expect(settings.aiGradingEnabled).toBe(true);

    const response = await call<AiGradeResponse>(
      app,
      "POST",
      `/api/forms/${quiz.formId}/submissions/${submissionId}/ai-grade`,
      { body: { itemId: "q-short" }, cookie },
    );
    expect(response.status).toBe(200);
    expect(response.json.itemId).toBe("q-short");
    expect(response.json.maxScore).toBe(5);
    expect(response.json.suggestedScore).toBe(2);
    expect(response.json.source).toBe("mock");
    expect(response.json.promptVersion).toBe("grade.v1");

    const submissions = await call<SubmissionsResponse>(
      app,
      "GET",
      `/api/forms/${quiz.formId}/submissions`,
      { cookie },
    );
    const row = submissions.json.rows.find((entry) => entry.submissionId === submissionId);
    expect(row?.manualScores).toEqual({});
    expect(row?.pendingScore).toBe(5);
  });

  it("只接受简答题：给单选题请求 400", async () => {
    const { app, cookie, quiz } = await boot();
    const submissionId = await submit(app, quiz);
    await setAi(app, cookie, quiz.formId, true);
    const response = await call(app, "POST", `/api/forms/${quiz.formId}/submissions/${submissionId}/ai-grade`, {
      body: { itemId: "q-single" },
      cookie,
    });
    expect(response.status).toBe(400);
    expect(response.text).toContain("只支持简答题");
  });

  it("未登录 401，别人的表单 403", async () => {
    const { app, cookie, quiz } = await boot();
    const submissionId = await submit(app, quiz);
    await setAi(app, cookie, quiz.formId, true);

    const anonymous = await call(app, "POST", `/api/forms/${quiz.formId}/submissions/${submissionId}/ai-grade`, {
      body: { itemId: "q-short" },
    });
    expect(anonymous.status).toBe(401);

    seedTeacher(app.db, "intruder@example.com");
    const intruder = await login(app, "intruder@example.com");
    const forbidden = await call(app, "POST", `/api/forms/${quiz.formId}/submissions/${submissionId}/ai-grade`, {
      body: { itemId: "q-short" },
      cookie: intruder,
    });
    expect(forbidden.status).toBe(403);
  });
});
