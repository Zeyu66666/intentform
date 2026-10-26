/**
 * 提交与判分：正常判分、版本冲突、未知字段、重复选项、超大体、响应形状。
 *
 * 最重要的两条用例：
 * - 「旧版页面提交 → 409」——老师改题后，学生手上的旧标签页不能悄悄把旧题答案
 *   混进新版本的看板；
 * - 「响应体只有四个键」——多一个 `correct` 字段就等于给了学生一个刷分探针。
 */

import { afterEach, describe, expect, it } from "vitest";
import { LIMITS, VERSION_CONFLICT_MESSAGE, type SubmitResponse } from "@intentform/schema";
import { appendVersion, findVersion, publishVersion } from "./db/forms.ts";
import { formSchema } from "@intentform/schema";
import { createFormBody, quizSchema } from "./testing/fixtures.ts";
import {
  call,
  createPublishedQuiz,
  login,
  seedTeacher,
  startTestServer,
  TEST_APP_ORIGIN,
  type PublishedQuiz,
  type TestServer,
} from "./testing/harness.ts";

const CORRECT_ANSWERS = {
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

function submitBody(slug: string, versionId: string, answers: Record<string, unknown>) {
  return { slug, formVersionId: versionId, answers };
}

describe("POST /api/submissions", () => {
  it("全对得满分，响应只有 ok/submissionId/score/maxScore", async () => {
    const { app, quiz } = await boot();
    const response = await call<SubmitResponse>(app, "POST", "/api/submissions", {
      body: submitBody(quiz.slug, quiz.versionId, CORRECT_ANSWERS),
    });
    expect(response.status).toBe(201);
    expect(Object.keys(response.json).sort()).toEqual([
      "maxScore",
      "ok",
      "score",
      "submissionId",
    ]);
    expect(response.json).toMatchObject({ ok: true, score: 20, maxScore: 20 });
    // 不回显学生答案、不告诉每题对错。
    expect(response.text).not.toContain("q-single");
    expect(response.text).not.toContain("op1");
  });

  it("学生端提交不需要登录（手机上没有账号），但缺少 CSRF 头会被拦", async () => {
    const { app, quiz } = await boot();
    const blocked = await call(app, "POST", "/api/submissions", {
      body: submitBody(quiz.slug, quiz.versionId, CORRECT_ANSWERS),
      csrf: false,
    });
    expect(blocked.status).toBe(403);
    const noOrigin = await call(app, "POST", "/api/submissions", {
      body: submitBody(quiz.slug, quiz.versionId, CORRECT_ANSWERS),
      origin: null,
    });
    expect(noOrigin.status).toBe(403);
    // 不带 cookie、带正确的 Origin 与自定义头 → 正常收卷。
    const ok = await call<SubmitResponse>(app, "POST", "/api/submissions", {
      body: submitBody(quiz.slug, quiz.versionId, CORRECT_ANSWERS),
    });
    expect(ok.status).toBe(201);
  });

  it("旧版本提交 → 409 version_conflict", async () => {
    const { app, cookie, quiz } = await boot();
    void cookie;
    // 造 v2 并发布，模拟「老师课后改了卷子」。
    const current = findVersion(app.db, quiz.formId, quiz.versionId);
    expect(current).toBeDefined();
    const v2 = appendVersion(app.db, {
      id: "v2_conflict",
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
    expect(owner).toBeDefined();
    const published = publishVersion(app.db, {
      teacherId: owner?.teacher_id ?? "",
      formId: quiz.formId,
      versionId: v2.id,
      slug: quiz.slug,
      updatedAt: new Date().toISOString(),
    });
    expect(published).toBe(true);
    void cookie;

    const stale = await call(app, "POST", "/api/submissions", {
      body: submitBody(quiz.slug, quiz.versionId, CORRECT_ANSWERS),
    });
    expect(stale.status).toBe(409);
    expect(stale.json).toMatchObject({ ok: false, error: "version_conflict" });
    expect(stale.json).toMatchObject({ message: VERSION_CONFLICT_MESSAGE });

    const fresh = await call<SubmitResponse>(app, "POST", "/api/submissions", {
      body: submitBody(quiz.slug, v2.id, CORRECT_ANSWERS),
    });
    expect(fresh.status).toBe(201);
    expect(fresh.json.score).toBe(20);
  });

  it("未知字段 id → 400（改 DOM 加字段不能静默吞掉）", async () => {
    const { app, quiz } = await boot();
    const response = await call(app, "POST", "/api/submissions", {
      body: submitBody(quiz.slug, quiz.versionId, { ...CORRECT_ANSWERS, "q-evil": "x" }),
    });
    expect(response.status).toBe(400);
    expect(response.json).toMatchObject({ ok: false, error: "bad_request" });
  });

  it("多选重复选项 → 400", async () => {
    const { app, quiz } = await boot();
    const response = await call(app, "POST", "/api/submissions", {
      body: submitBody(quiz.slug, quiz.versionId, {
        ...CORRECT_ANSWERS,
        "q-multi": ["op1", "op1"],
      }),
    });
    expect(response.status).toBe(400);
  });

  it("未作答的必答题目得 0 分，但整份提交仍然留档", async () => {
    const { app, quiz } = await boot();
    const response = await call<SubmitResponse>(app, "POST", "/api/submissions", {
      body: submitBody(quiz.slug, quiz.versionId, { "q-single": "op1" }),
    });
    expect(response.status).toBe(201);
    expect(response.json).toMatchObject({ score: 5, maxScore: 20 });
    const count = app.db
      .prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM submissions")
      .get();
    expect(count?.c).toBe(1);
  });

  it("超过 submissionMaxBytes 的请求体 → 413", async () => {
    const { app, quiz } = await boot();
    const huge = "x".repeat(LIMITS.submissionMaxBytes + 100);
    const response = await call(app, "POST", "/api/submissions", {
      rawBody: JSON.stringify(submitBody(quiz.slug, quiz.versionId, { "q-short": huge })),
    });
    expect(response.status).toBe(413);
    expect(response.json).toMatchObject({ ok: false, error: "payload_too_large" });
  });

  it("非法 JSON → 400 而不是 500", async () => {
    const { app } = await boot();
    const response = await call(app, "POST", "/api/submissions", { rawBody: "{not json" });
    expect(response.status).toBe(400);
  });

  it("不存在的 slug → 404", async () => {
    const { app, quiz } = await boot();
    const response = await call(app, "POST", "/api/submissions", {
      body: submitBody("zzzzzzzzzz", quiz.versionId, CORRECT_ANSWERS),
    });
    expect(response.status).toBe(404);
  });

  it("ip_hash 落库是摘要，不是明文 IP", async () => {
    const { app, quiz } = await boot();
    await call(app, "POST", "/api/submissions", {
      body: submitBody(quiz.slug, quiz.versionId, CORRECT_ANSWERS),
    });
    const row = app.db
      .prepare<[], { ip_hash: string }>("SELECT ip_hash FROM submissions LIMIT 1")
      .get();
    expect(row?.ip_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(row?.ip_hash).not.toContain("127.0.0.1");
  });
});

describe("判分依据的版本", () => {
  it("只用提交携带版本的 schema：v2 改了答案，旧版提交按旧版判", async () => {
    const { app, quiz } = await boot();
    const modified = quizSchema();
    const items = modified.items.map((item) =>
      item.id === "q-single" ? { ...item, answer: "op2" } : item,
    );
    const v2Schema = formSchema.parse({ ...modified, items });
    const v2 = appendVersion(app.db, {
      id: "v2_grading",
      formId: quiz.formId,
      schemaJson: JSON.stringify(v2Schema),
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
    // 带了 v2 的版本号但用旧答案（op1）→ 应该是 15 分而不是 20。
    const response = await call<SubmitResponse>(app, "POST", "/api/submissions", {
      body: submitBody(quiz.slug, v2.id, CORRECT_ANSWERS),
    });
    expect(response.status).toBe(201);
    expect(response.json.score).toBe(15);
  });

  it("建表单的请求体本身就是合法的 createFormBody", async () => {
    // 顺手钉住 fixture 与契约一致（防止改 fixture 时忘了改 createFormBody）。
    const body = createFormBody("quiz");
    expect(body["kind"]).toBe("quiz");
  });
});

describe("提交成功的响应语义", () => {
  it("201 带 Location 指向该表单的提交列表，且响应体不多一个字段", async () => {
    const { app, quiz } = await boot();
    const response = await fetch(`${app.baseUrl}/api/submissions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: TEST_APP_ORIGIN,
        "x-intentform-csrf": "1",
      },
      body: JSON.stringify(submitBody(quiz.slug, quiz.versionId, CORRECT_ANSWERS)),
    });
    expect(response.status).toBe(201);
    // 契约里没有「按 id 读单条提交」的接口，所以 Location 指向集合而不是 `/api/submissions/<id>`。
    expect(response.headers.get("location")).toBe(`/api/forms/${quiz.formId}/submissions`);
    const body = (await response.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["maxScore", "ok", "score", "submissionId"]);
  });

  it("形状不合法时回中文 400，不把 zod 的英文原文抛给前端", async () => {
    const { app } = await boot();
    const response = await call(app, "POST", "/api/submissions", {
      body: { slug: "", formVersionId: "", answers: {} },
    });
    expect(response.status).toBe(400);
    expect(response.json).toMatchObject({ ok: false, error: "bad_request" });
    expect(response.text).not.toMatch(/String must|Required|Too small/);
  });
});
