/**
 * 表单展示设置与提交后答案解析（省赛附加 A-18）。
 *
 * 三条不变量：
 * 1. **默认关闭**：没有任何记录时，提交响应里连 `review` 键都没有；
 * 2. **开启后才回答案**：`review` 只随提交成功的响应返回，`GET /f/:slug` 一行不变；
 * 3. **口径与判分同源**：对错来自 `judgeItem`，简答/量表固定 `null`。
 */

import { afterEach, describe, expect, it } from "vitest";

import type { SubmitResponse, SubmissionsResponse } from "@intentform/schema";
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
};

let server: TestServer | undefined;

async function boot(): Promise<{ app: TestServer; cookie: string; quiz: PublishedQuiz }> {
  server = await startTestServer();
  seedTeacher(server.db);
  const cookie = await login(server);
  const quiz = await createPublishedQuiz(server, cookie);
  return { app: server, cookie, quiz };
}

afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function submit(app: TestServer, quiz: PublishedQuiz, answers: Record<string, unknown>) {
  return call<SubmitResponse>(app, "POST", "/api/submissions", {
    body: { slug: quiz.slug, formVersionId: quiz.versionId, answers },
  });
}

async function setShowAnswers(
  app: TestServer,
  cookie: string,
  formId: string,
  enabled: boolean,
) {
  return call<{ ok: true; showAnswersAfterSubmit: boolean }>(
    app,
    "POST",
    `/api/forms/${formId}/settings`,
    { body: { showAnswersAfterSubmit: enabled }, cookie },
  );
}

describe("表单展示设置", () => {
  it("默认关闭；开关往返读写一致，且不产生新版本", async () => {
    const { app, cookie, quiz } = await boot();
    const initial = await call<{ ok: true; showAnswersAfterSubmit: boolean }>(
      app,
      "GET",
      `/api/forms/${quiz.formId}/settings`,
      { cookie },
    );
    expect(initial.status).toBe(200);
    expect(initial.json.showAnswersAfterSubmit).toBe(false);

    const on = await setShowAnswers(app, cookie, quiz.formId, true);
    expect(on.status).toBe(200);
    expect(on.json.showAnswersAfterSubmit).toBe(true);

    const readBack = await call<{ ok: true; showAnswersAfterSubmit: boolean }>(
      app,
      "GET",
      `/api/forms/${quiz.formId}/settings`,
      { cookie },
    );
    expect(readBack.json.showAnswersAfterSubmit).toBe(true);

    // 展示策略不进版本快照：草稿/发布指针都没动，版本号还是 1。
    const detail = await call<{ version: { n: number } }>(app, "GET", `/api/forms/${quiz.formId}`, {
      cookie,
    });
    expect(detail.json.version.n).toBe(1);

    const off = await setShowAnswers(app, cookie, quiz.formId, false);
    expect(off.json.showAnswersAfterSubmit).toBe(false);
  });

  it("别人的表单 403，未登录 401，请求体不合法 400", async () => {
    const { app, cookie, quiz } = await boot();
    seedTeacher(app.db, "intruder@example.com");
    const intruder = await login(app, "intruder@example.com");
    const forbidden = await setShowAnswers(app, intruder, quiz.formId, true);
    expect(forbidden.status).toBe(403);

    const anonymous = await call(app, "POST", `/api/forms/${quiz.formId}/settings`, {
      body: { showAnswersAfterSubmit: true },
    });
    expect(anonymous.status).toBe(401);

    const bad = await call(app, "POST", `/api/forms/${quiz.formId}/settings`, {
      body: { showAnswersAfterSubmit: "yes" },
      cookie,
    });
    expect(bad.status).toBe(400);
  });
});

describe("提交后答案解析", () => {
  it("关闭时提交响应里没有 review 键（与 R-09 之前逐字节相同）", async () => {
    const { app, quiz } = await boot();
    const submitted = await submit(app, quiz, ANSWERS);
    expect(submitted.status).toBe(201);
    expect(submitted.json).not.toHaveProperty("review");
    // 学生端零泄漏的既有断言在这里再钉一次：答案不出现在提交响应里。
    expect(submitted.text).not.toContain("因为 A");
  });

  it("开启后返回逐题回看：对错来自 judgeItem，选项 id 换成文字", async () => {
    const { app, cookie, quiz } = await boot();
    await setShowAnswers(app, cookie, quiz.formId, true);

    const submitted = await submit(app, quiz, ANSWERS);
    expect(submitted.status).toBe(201);
    const review = submitted.json.review ?? [];
    expect(review.map((item) => item.itemId)).toEqual([
      "q-single",
      "q-multi",
      "q-fill",
      "q-number",
      "q-short",
    ]);

    expect(review[0]).toMatchObject({
      given: "选项一",
      correct: true,
      expected: "选项一",
      explanation: "因为 A",
    });
    expect(review[1]).toMatchObject({ given: "选项一、选项三", correct: true, expected: "选项一、选项三" });
    expect(review[2]).toMatchObject({ given: "2／x", correct: true, expected: "2／x" });
    expect(review[3]).toMatchObject({ given: "3.14", correct: true, expected: "3.14" });
    // 简答没有对错，也没有标准答案——null 与空串都不伪填。
    expect(review[4]).toMatchObject({ correct: null, expected: "" });
    expect(review[4]).not.toHaveProperty("explanation");
  });

  it("答错与未作答都按「未答对」算，且如实显示学生答案", async () => {
    const { app, cookie, quiz } = await boot();
    await setShowAnswers(app, cookie, quiz.formId, true);

    const wrong = await submit(app, quiz, { "q-single": "op2" });
    const review = wrong.json.review ?? [];
    expect(review[0]).toMatchObject({ given: "选项二", correct: false, expected: "选项一" });
    expect(review[1]).toMatchObject({ given: "", correct: false });
  });

  it("学生端公开视图不受开关影响：GET /f/:slug 仍然零答案", async () => {
    const { app, cookie, quiz } = await boot();
    await setShowAnswers(app, cookie, quiz.formId, true);
    const view = await call(app, "GET", `/f/${quiz.slug}`);
    expect(view.status).toBe(200);
    for (const key of ["answer", "explanation", "bloom", "knowledgePoint", "objectives"]) {
      expect(view.text).not.toContain(`"${key}"`);
    }
  });

  it("survey 开启后 review 里没有对错与标准答案（问卷本来就没有）", async () => {
    const { app, cookie } = await boot();
    const survey = await createPublishedQuiz(app, cookie, "survey");
    await setShowAnswers(app, cookie, survey.formId, true);

    const submitted = await call<SubmitResponse>(app, "POST", "/api/submissions", {
      body: {
        slug: survey.slug,
        formVersionId: survey.versionId,
        answers: { "s-short": "还行", "s-scale": "3" },
      },
    });
    expect(submitted.status).toBe(201);
    const review = submitted.json.review ?? [];
    expect(review.map((item) => item.itemId)).toEqual(["s-short", "s-scale"]);
    expect(review.every((item) => item.correct === null && item.expected === "")).toBe(true);
    // 回收看板不受影响：问卷的 itemStats 仍为空数组。
    const dashboard = await call<SubmissionsResponse>(
      app,
      "GET",
      `/api/forms/${survey.formId}/submissions`,
      { cookie },
    );
    expect(dashboard.json.itemStats).toEqual([]);
  });
});
