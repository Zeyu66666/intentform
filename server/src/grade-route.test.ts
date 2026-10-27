/**
 * 人工批改（省赛 R-02）：`POST /api/forms/:id/submissions/:submissionId/grades`。
 *
 * 钉住的六条口径（每一条都对应一个真实的误用方式）：
 * 1. 未登录 401、别人的表单 404 —— 与其它写接口同一套鉴权，不因为"只是个分数"放松；
 * 2. `itemId` 必须是**这份版本里带分值的简答**：给单选录分、给不存在的题录分都拒绝；
 * 3. 分值是**覆盖写**：同一题批两次，第二次覆盖而不是相加（教师改错重发是常态）；
 * 4. 超过单题满分按满分夹住：30 分卷子不该出现 55 分；
 * 5. 批完 `pendingScore` 归零、`score` 上升，看板的 `pendingCount` 跟着降；
 * 6. 批改只影响这一条提交，别的提交分数不动。
 */

import { afterEach, describe, expect, it } from "vitest";
import type { GradeResponse, SubmitResponse, SubmissionsResponse } from "@intentform/schema";
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

/** 自动判分 20 分 + 简答 5 分 = 25 分。 */
const ANSWERS = {
  "q-single": "op1",
  "q-multi": ["op1", "op3"],
  "q-fill": ["2", "x"],
  "q-number": "3.14",
  "q-short": "我的推导是……",
};

let server: TestServer | undefined;

async function boot(): Promise<{ app: TestServer; cookie: string; quiz: PublishedQuiz }> {
  server = await startTestServer();
  seedTeacher(server.db);
  const cookie = await login(server);
  const quiz = await createPublishedQuiz(server, cookie, "quiz", scoredShortQuizSchema());
  return { app: server, cookie, quiz };
}

afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function submit(app: TestServer, quiz: PublishedQuiz, answers: Record<string, unknown>) {
  const response = await call<SubmitResponse>(app, "POST", "/api/submissions", {
    body: { slug: quiz.slug, formVersionId: quiz.versionId, answers },
  });
  expect(response.status).toBe(201);
  return response.json;
}

function grade(
  app: TestServer,
  quiz: PublishedQuiz,
  submissionId: string,
  body: Record<string, unknown>,
  cookie?: string,
) {
  return call<GradeResponse>(
    app,
    "POST",
    `/api/forms/${quiz.formId}/submissions/${submissionId}/grades`,
    cookie === undefined ? { body } : { body, cookie },
  );
}

describe("POST .../grades 鉴权与输入", () => {
  it("未登录 401", async () => {
    const { app, quiz } = await boot();
    const submitted = await submit(app, quiz, ANSWERS);
    const response = await grade(app, quiz, submitted.submissionId, { itemId: "q-short", score: 3 });
    expect(response.status).toBe(401);
  });

  it("批别人的表单 404（不泄露存在性）", async () => {
    const { app, cookie, quiz } = await boot();
    const submitted = await submit(app, quiz, ANSWERS);
    const response = await grade(
      app,
      { ...quiz, formId: "form-does-not-exist" },
      submitted.submissionId,
      { itemId: "q-short", score: 3 },
      cookie,
    );
    expect(response.status).toBe(404);
  });

  it("给单选题录分 400：只有简答需要人工判分", async () => {
    const { app, cookie, quiz } = await boot();
    const submitted = await submit(app, quiz, ANSWERS);
    const response = await grade(app, quiz, submitted.submissionId, { itemId: "q-single", score: 5 }, cookie);
    expect(response.status).toBe(400);
    expect(response.text).toContain("简答");
  });

  it("itemId 不存在 400；分值是小数 400", async () => {
    const { app, cookie, quiz } = await boot();
    const submitted = await submit(app, quiz, ANSWERS);
    const missing = await grade(app, quiz, submitted.submissionId, { itemId: "q-nope", score: 3 }, cookie);
    expect(missing.status).toBe(400);
    const decimal = await grade(app, quiz, submitted.submissionId, { itemId: "q-short", score: 2.5 }, cookie);
    expect(decimal.status).toBe(400);
  });

  it("提交不属于这份表单时 404", async () => {
    const { app, cookie, quiz } = await boot();
    const response = await grade(app, quiz, "sub-does-not-exist", { itemId: "q-short", score: 3 }, cookie);
    expect(response.status).toBe(404);
  });
});

describe("POST .../grades 计分口径", () => {
  it("批完简答：score 上升、pendingScore 归零，且两者相加等于满分", async () => {
    const { app, cookie, quiz } = await boot();
    const submitted = await submit(app, quiz, ANSWERS);
    // 交卷时：自动分 20，简答 5 分待批（`SubmitResponse` 是平铺的，没有 `row` 外壳）。
    expect(submitted.score).toBe(20);
    expect(submitted.pendingScore).toBe(5);

    const graded = await grade(app, quiz, submitted.submissionId, { itemId: "q-short", score: 4 }, cookie);
    expect(graded.status).toBe(200);
    expect(graded.json.submission.score).toBe(24);
    expect(graded.json.submission.pendingScore).toBe(0);
    expect(graded.json.submission.manualScores).toEqual({ "q-short": 4 });
    // 给 4/5 分不是"还有 1 分待批"，是"扣了 1 分"：待批额度必须归零，
    // 否则学生成绩上永远挂着"待批改"，教师也没法判断自己批完没有。
    expect(graded.json.submission.pendingScore).toBe(0);
  });

  it("覆盖写：同一题批两次，第二次替换而不是累加", async () => {
    const { app, cookie, quiz } = await boot();
    const submitted = await submit(app, quiz, ANSWERS);
    await grade(app, quiz, submitted.submissionId, { itemId: "q-short", score: 5 }, cookie);
    const again = await grade(app, quiz, submitted.submissionId, { itemId: "q-short", score: 2 }, cookie);
    expect(again.json.submission.score).toBe(22);
    expect(again.json.submission.manualScores).toEqual({ "q-short": 2 });
  });

  it("超过该题满分 400 并说清满分多少（30 分卷子不该出现 55 分）", async () => {
    const { app, cookie, quiz } = await boot();
    const submitted = await submit(app, quiz, ANSWERS);
    const graded = await grade(app, quiz, submitted.submissionId, { itemId: "q-short", score: 6 }, cookie);
    expect(graded.status).toBe(400);
    expect(graded.text).toContain("满分 5");
  });

  it("超过契约上限（>100）直接 400，而不是悄悄夹住", async () => {
    const { app, cookie, quiz } = await boot();
    const submitted = await submit(app, quiz, ANSWERS);
    const graded = await grade(app, quiz, submitted.submissionId, { itemId: "q-short", score: 101 }, cookie);
    expect(graded.status).toBe(400);
  });

  it("0 分是合法批改结果：score 不涨，但不再算待批", async () => {
    const { app, cookie, quiz } = await boot();
    const submitted = await submit(app, quiz, ANSWERS);
    const graded = await grade(app, quiz, submitted.submissionId, { itemId: "q-short", score: 0 }, cookie);
    expect(graded.json.submission.score).toBe(20);
    expect(graded.json.submission.pendingScore).toBe(0);
  });

  it("批改只影响这一条提交", async () => {
    const { app, cookie, quiz } = await boot();
    const first = await submit(app, quiz, ANSWERS);
    const second = await submit(app, quiz, ANSWERS);
    await grade(app, quiz, first.submissionId, { itemId: "q-short", score: 5 }, cookie);

    const response = await call<SubmissionsResponse>(
      app,
      "GET",
      `/api/forms/${quiz.formId}/submissions`,
      { cookie },
    );
    const rows = response.json.rows;
    const target = rows.find((row) => row.submissionId === first.submissionId);
    const other = rows.find((row) => row.submissionId === second.submissionId);
    expect(target?.score).toBe(25);
    expect(other?.score).toBe(20);
    expect(other?.pendingScore).toBe(5);
    // 均分 = (25 + 20) / 2，待批只有 1 条。
    expect(response.json.summary.avgScore).toBe(22.5);
    expect(response.json.summary.pendingCount).toBe(1);
  });

  it("看板给出批改清单：题干与满分都来自当前版本", async () => {
    const { app, cookie, quiz } = await boot();
    await submit(app, quiz, ANSWERS);
    const response = await call<SubmissionsResponse>(
      app,
      "GET",
      `/api/forms/${quiz.formId}/submissions`,
      { cookie },
    );
    expect(response.json.shortItems).toEqual([
      { itemId: "q-short", title: "简答题（不自动判分）", score: 5 },
    ]);
  });
});
