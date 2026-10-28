/**
 * 看板与 CSV。
 *
 * 三条硬规则在这里被钉住：
 * 1. 缺省看当前发布版；`?versionId=` 切历史版；**跨版本不合并**（v2 的看板看不到 v1 的提交）；
 * 2. `count === 0` 时 `avgScore` 是 `null`；
 * 3. CSV 表头 = 四列固定 + 字段 id，**没有 answer 列**，单元格按 RFC 4180 转义。
 */

import { afterEach, describe, expect, it } from "vitest";
import { CSV_BASE_COLUMNS, type SubmissionsResponse, type SubmitResponse } from "@intentform/schema";
import { appendVersion, publishVersion } from "./db/forms.ts";
import { quizSchema } from "./testing/fixtures.ts";
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
  const response = await call<SubmitResponse>(app, "POST", "/api/submissions", {
    body: { slug: quiz.slug, formVersionId: quiz.versionId, answers },
  });
  expect(response.status).toBe(201);
  return response.json;
}

describe("GET /api/forms/:id/submissions", () => {
  it("缺省看当前发布版：条数、平均分、满分都对", async () => {
    const { app, cookie, quiz } = await boot();
    await submit(app, quiz, ANSWERS); // 20 分
    await submit(app, quiz, { "q-single": "op1" }); // 5 分
    const response = await call<SubmissionsResponse>(
      app,
      "GET",
      `/api/forms/${quiz.formId}/submissions`,
      { cookie },
    );
    expect(response.status).toBe(200);
    expect(response.json.summary).toMatchObject({
      versionId: quiz.versionId,
      versionN: 1,
      count: 2,
      avgScore: 12.5,
      maxScore: 20,
    });
    expect(response.json.rows).toHaveLength(2);
    // 行的键集合就是契约本身：**教师的看板可以看答案**（那是批改的前提），
    // 但键必须逐个点名——多出来的键（比如 `answer`、`knowledgePoint`）是回归。
    expect(Object.keys(response.json.rows[0] ?? {}).sort()).toEqual([
      "answers",
      "createdAt",
      "manualScores",
      "maxScore",
      "pendingScore",
      "score",
      "submissionId",
    ]);
  });

  it("还没有提交时 avgScore 是 null（不是 0）", async () => {
    const { app, cookie, quiz } = await boot();
    const response = await call<SubmissionsResponse>(
      app,
      "GET",
      `/api/forms/${quiz.formId}/submissions`,
      { cookie },
    );
    expect(response.json.summary.count).toBe(0);
    expect(response.json.summary.avgScore).toBeNull();
  });

  it("跨版本不合并：v2 的看板看不到 v1 的提交", async () => {
    const { app, cookie, quiz } = await boot();
    await submit(app, quiz, ANSWERS);
    const v2 = appendVersion(app.db, {
      id: "v2_analytics",
      formId: quiz.formId,
      schemaJson: JSON.stringify(quizSchema()),
      source: "patch",
      parentId: quiz.versionId,
      promptVersion: "test",
      createdAt: new Date().toISOString(),
    });
    const owner = app.db
      .prepare<[string], { teacher_id: string }>("SELECT teacher_id FROM forms WHERE id = ?")
      .get(quiz.formId);
    publishVersion(app.db, {
      teacherId: owner?.teacher_id ?? "",
      formId: quiz.formId,
      versionId: v2.id,
      slug: quiz.slug,
      updatedAt: new Date().toISOString(),
    });

    const current = await call<SubmissionsResponse>(
      app,
      "GET",
      `/api/forms/${quiz.formId}/submissions`,
      { cookie },
    );
    expect(current.json.summary.versionId).toBe(v2.id);
    expect(current.json.summary.count).toBe(0);
    expect(current.json.summary.avgScore).toBeNull();
    // 逐题统计也按版本走（R-04）：v2 没有提交，rate 必须是 null 而不是 0。
    expect(current.json.itemStats.map((stat) => stat.rate)).toEqual([null, null, null, null]);

    const historical = await call<SubmissionsResponse>(
      app,
      "GET",
      `/api/forms/${quiz.formId}/submissions?versionId=${quiz.versionId}`,
      { cookie },
    );
    expect(historical.json.summary.versionId).toBe(quiz.versionId);
    expect(historical.json.summary.count).toBe(1);
    expect(historical.json.summary.avgScore).toBe(20);
    expect(historical.json.itemStats.map((stat) => stat.rate)).toEqual([1, 1, 1, 1]);
  });

  it("未登录 401，别人的表单 403", async () => {
    const { app, cookie, quiz } = await boot();
    const anonymous = await call(app, "GET", `/api/forms/${quiz.formId}/submissions`);
    expect(anonymous.status).toBe(401);

    seedTeacher(app.db, "intruder@example.com");
    const intruder = await login(app, "intruder@example.com");
    const forbidden = await call(app, "GET", `/api/forms/${quiz.formId}/submissions`, {
      cookie: intruder,
    });
    expect(forbidden.status).toBe(403);
    void cookie;
  });

  it("未发布的表单没有看板（404，而不是编一个空版本）", async () => {
    const { app, cookie } = await boot();
    const created = await call<{ form: { id: string } }>(app, "POST", "/api/forms", {
      body: { title: "草稿卷", kind: "survey", schema: { meta: { version: 1, kind: "survey", title: "草稿卷", objectives: [] }, items: [] } },
      cookie,
    });
    const response = await call(app, "GET", `/api/forms/${created.json.form.id}/submissions`, {
      cookie,
    });
    expect(response.status).toBe(404);
  });
});

describe("GET /api/forms/:id/submissions.csv", () => {
  it("表头是四列固定 + 字段 id，且没有 answer 列", async () => {
    const { app, cookie, quiz } = await boot();
    await submit(app, quiz, ANSWERS);
    const response = await call(app, "GET", `/api/forms/${quiz.formId}/submissions.csv`, {
      cookie,
    });
    expect(response.status).toBe(200);
    expect(response.contentType).toBe("text/csv; charset=utf-8");
    const header = response.text.split("\r\n")[0] ?? "";
    const columns = header.split(",");
    expect(columns.slice(0, 4)).toEqual([...CSV_BASE_COLUMNS]);
    expect(columns).toEqual([
      ...CSV_BASE_COLUMNS,
      "q-single",
      "q-multi",
      "q-fill",
      "q-number",
      "q-short",
    ]);
    expect(header).not.toContain("answer");
    // 数据行里也必须没有答案文本。
    expect(response.text).not.toContain('"answer"');
  });

  it("多选答案用 | 连接，含逗号/引号/换行的单元格被正确转义", async () => {
    const { app, cookie, quiz } = await boot();
    const nasty = 'a,b"c\nd';
    await call(app, "POST", "/api/submissions", {
      body: {
        slug: quiz.slug,
        formVersionId: quiz.versionId,
        answers: { ...ANSWERS, "q-short": nasty },
      },
    });
    const response = await call(app, "GET", `/api/forms/${quiz.formId}/submissions.csv`, {
      cookie,
    });
    const lines = response.text.split("\r\n");
    expect(lines[0]).toContain("q-multi");
    const body = lines.slice(1).join("\r\n");
    // 引号加倍、整格加引号：`"a,b""c\nd"`。
    expect(body).toContain('"a,b""c\nd"');
    // 多选两个选项用竖线连接。
    expect(body).toContain("op1|op3");
  });

  it("未登录 401", async () => {
    const { app, quiz } = await boot();
    const response = await call(app, "GET", `/api/forms/${quiz.formId}/submissions.csv`);
    expect(response.status).toBe(401);
  });
});

/**
 * 省赛 R-04：每题正确率。
 *
 * 三个数各有各的坑，所以每个都要点名断言：
 * - **分母是提交份数**，未作答算没答对（不是"从分母里剔掉"）；
 * - `answered` 单列，教师才能分清"这题没人做"与"都做错了"；
 * - 零提交时 `rate` 是 `null`——`0` 会被读成"全班全错"，与 `avgScore: null` 同一条口径。
 */
describe("GET /api/forms/:id/submissions · 逐题正确率（R-04）", () => {
  async function statsOf(
    app: TestServer,
    cookie: string,
    formId: string,
  ): Promise<SubmissionsResponse["itemStats"]> {
    const response = await call<SubmissionsResponse>(
      app,
      "GET",
      `/api/forms/${formId}/submissions`,
      { cookie },
    );
    expect(response.status).toBe(200);
    return response.json.itemStats;
  }

  it("分母是提交份数，未作答按未答对计，answered 单列", async () => {
    const { app, cookie, quiz } = await boot();
    await submit(app, quiz, ANSWERS); // 四题全对
    await submit(app, quiz, { "q-single": "op1", "q-multi": ["op1"] }); // 单选对、多选错、后两题没做
    await submit(app, quiz, {}); // 整份没作答，仍然进分母

    expect(await statsOf(app, cookie, quiz.formId)).toEqual([
      { itemId: "q-single", title: "单选", score: 5, total: 3, answered: 2, correct: 2, rate: 0.6667 },
      { itemId: "q-multi", title: "多选", score: 5, total: 3, answered: 2, correct: 1, rate: 0.3333 },
      { itemId: "q-fill", title: "填空（两个空）", score: 5, total: 3, answered: 1, correct: 1, rate: 0.3333 },
      { itemId: "q-number", title: "数值题", score: 5, total: 3, answered: 1, correct: 1, rate: 0.3333 },
    ]);
  });

  it("还没有提交时 rate 是 null，不是 0", async () => {
    const { app, cookie, quiz } = await boot();
    const stats = await statsOf(app, cookie, quiz.formId);
    expect(stats).toHaveLength(4);
    for (const stat of stats) {
      expect(stat.total).toBe(0);
      expect(stat.answered).toBe(0);
      expect(stat.correct).toBe(0);
      expect(stat.rate).toBeNull();
    }
  });

  it("简答与分节不进统计：它们没有对错", async () => {
    const { app, cookie, quiz } = await boot();
    await submit(app, quiz, { ...ANSWERS, "q-short": "我的论述" });
    const ids = (await statsOf(app, cookie, quiz.formId)).map((stat) => stat.itemId);
    expect(ids).toEqual(["q-single", "q-multi", "q-fill", "q-number"]);
    expect(ids).not.toContain("q-short");
    expect(ids).not.toContain("sec-main");
  });

  it("survey 没有标准答案，itemStats 是空数组（不能显示 0%）", async () => {
    const { app, cookie } = await boot();
    const survey = await createPublishedQuiz(app, cookie, "survey");
    await call(app, "POST", "/api/submissions", {
      body: {
        slug: survey.slug,
        formVersionId: survey.versionId,
        answers: { "s-short": "还行", "s-scale": "3" },
      },
    });
    expect(await statsOf(app, cookie, survey.formId)).toEqual([]);
  });

});
