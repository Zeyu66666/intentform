/**
 * 表单路由：建 / 列 / 详情 / 发布。
 *
 * 重点在两条：
 * 1. **发布不改版本行**——发布前后的 `schema_json` 一模一样，版本数不变；
 * 2. **归属**——别人的表单详情是 403（存在但不是你的），不存在的表单是 404。
 */

import { afterEach, describe, expect, it } from "vitest";
import type {
  CreateFormResponse,
  FormDetailResponse,
  ListFormsResponse,
  PublishResponse,
} from "@intentform/schema";
import { createFormBody } from "./testing/fixtures.ts";
import { call, login, seedTeacher, startTestServer, type TestServer } from "./testing/harness.ts";

let server: TestServer | undefined;

async function boot(): Promise<{ app: TestServer; cookie: string }> {
  server = await startTestServer();
  seedTeacher(server.db);
  const cookie = await login(server);
  return { app: server, cookie };
}

afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function createForm(app: TestServer, cookie: string): Promise<CreateFormResponse> {
  const response = await call<CreateFormResponse>(app, "POST", "/api/forms", {
    body: createFormBody("quiz"),
    cookie,
  });
  expect(response.status).toBe(201);
  return response.json;
}

describe("POST /api/forms", () => {
  it("落 v1，草稿状态，没有 slug", async () => {
    const { app, cookie } = await boot();
    const created = await createForm(app, cookie);
    expect(created.form.status).toBe("draft");
    expect(created.form.slug).toBeUndefined();
    expect(created.form.publishedVersionId).toBeUndefined();
    expect(created.version.n).toBe(1);
    expect(created.version.source).toBe("generate");
  });

  it("未登录 401", async () => {
    const { app } = await boot();
    const response = await call(app, "POST", "/api/forms", { body: createFormBody("quiz") });
    expect(response.status).toBe(401);
  });

  it("结构不合法 400", async () => {
    const { app, cookie } = await boot();
    const response = await call(app, "POST", "/api/forms", {
      body: { title: "", kind: "quiz", schema: { meta: {}, items: [] } },
      cookie,
    });
    expect(response.status).toBe(400);
  });
});

describe("GET /api/forms 与详情", () => {
  it("只列出自己的表单，详情带完整 schema（含答案）", async () => {
    const { app, cookie } = await boot();
    const created = await createForm(app, cookie);
    const list = await call<ListFormsResponse>(app, "GET", "/api/forms", { cookie });
    expect(list.json.forms).toHaveLength(1);
    const detail = await call<FormDetailResponse>(app, "GET", `/api/forms/${created.form.id}`, {
      cookie,
    });
    expect(detail.status).toBe(200);
    // 教师自己看卷子要带答案，这是设计的（只有 /f/:slug 才脱敏）。
    expect(detail.text).toContain('"answer"');
  });

  it("别人的表单 403，不存在的表单 404", async () => {
    const { app, cookie } = await boot();
    const created = await createForm(app, cookie);
    seedTeacher(app.db, "intruder@example.com");
    const intruderCookie = await login(app, "intruder@example.com");

    const forbidden = await call(app, "GET", `/api/forms/${created.form.id}`, {
      cookie: intruderCookie,
    });
    expect(forbidden.status).toBe(403);
    expect(forbidden.json).toMatchObject({ error: "forbidden" });

    const missing = await call(app, "GET", "/api/forms/f_doesnotexist", { cookie });
    expect(missing.status).toBe(404);
  });
});

describe("POST /api/forms/:id/publish", () => {
  it("写指针 + 生成 slug，版本行不变", async () => {
    const { app, cookie } = await boot();
    const created = await createForm(app, cookie);

    const published = await call<PublishResponse>(app, "POST", `/api/forms/${created.form.id}/publish`, {
      body: { versionId: created.version.id },
      cookie,
    });
    expect(published.status).toBe(200);
    expect(published.json.slug).toMatch(/^[a-z0-9]{10}$/);

    const detailBefore = await call<FormDetailResponse>(app, "GET", `/api/forms/${created.form.id}`, {
      cookie,
    });
    expect(detailBefore.json.form.status).toBe("published");
    expect(detailBefore.json.form.publishedVersionId).toBe(created.version.id);
    expect(detailBefore.json.version.id).toBe(created.version.id);

    const rowCount = app.db
      .prepare<[string], { c: number }>("SELECT COUNT(*) AS c FROM form_versions WHERE form_id = ?")
      .get(created.form.id);
    expect(rowCount?.c).toBe(1);
  });

  it("不属于该表单的 versionId → 400", async () => {
    const { app, cookie } = await boot();
    const created = await createForm(app, cookie);
    const response = await call(app, "POST", `/api/forms/${created.form.id}/publish`, {
      body: { versionId: "v_notmine" },
      cookie,
    });
    expect(response.status).toBe(400);
  });

  it("重复发布复用同一个 slug（学生的链接不失效）", async () => {
    const { app, cookie } = await boot();
    const created = await createForm(app, cookie);
    const first = await call<PublishResponse>(app, "POST", `/api/forms/${created.form.id}/publish`, {
      body: { versionId: created.version.id },
      cookie,
    });
    const second = await call<PublishResponse>(app, "POST", `/api/forms/${created.form.id}/publish`, {
      body: { versionId: created.version.id },
      cookie,
    });
    expect(second.json.slug).toBe(first.json.slug);
  });

  it("别人的表单不能发布（403）", async () => {
    const { app, cookie } = await boot();
    const created = await createForm(app, cookie);
    seedTeacher(app.db, "intruder@example.com");
    const intruderCookie = await login(app, "intruder@example.com");
    const response = await call(app, "POST", `/api/forms/${created.form.id}/publish`, {
      body: { versionId: created.version.id },
      cookie: intruderCookie,
    });
    expect(response.status).toBe(403);
  });

  it("没过整表门禁 → 400，message 里带错误码与路径（可诊断）", async () => {
    const { app, cookie } = await boot();
    // 形状合法（zod 过）但语义不自洽：quiz 声明了 kind 却没写 meta.totalScore → E_SCORE_SUM。
    const created = await call<CreateFormResponse>(app, "POST", "/api/forms", {
      body: {
        title: "门禁失败卷",
        kind: "quiz",
        schema: {
          meta: { version: 1, kind: "quiz", title: "门禁失败卷", objectives: [] },
          items: [
            {
              id: "q-one",
              type: "single",
              title: "题",
              required: true,
              score: 5,
              options: [
                { id: "op1", text: "A" },
                { id: "op2", text: "B" },
              ],
              answer: "op1",
            },
          ],
        },
      },
      cookie,
    });
    expect(created.status).toBe(201);
    const published = await call(app, "POST", `/api/forms/${created.json.form.id}/publish`, {
      body: { versionId: created.json.version.id },
      cookie,
    });
    expect(published.status).toBe(400);
    expect(published.json).toMatchObject({ ok: false, error: "bad_request" });
    // 错误码是稳定的，评审/前端可以按码写提示；路径要能直接定位到字段。
    expect(published.text).toContain("E_SCORE_SUM");
    expect(published.text).toContain("meta.totalScore");
    // 只列前 3 条：message 是提示，不是日志。
    expect((published.text.match(/E_[A-Z_]+@/g) ?? []).length).toBeLessThanOrEqual(3);
    // 发布失败不许留下 slug 或发布指针。
    const after = await call<FormDetailResponse>(app, "GET", `/api/forms/${created.json.form.id}`, {
      cookie,
    });
    expect(after.json.form.slug).toBeUndefined();
    expect(after.json.form.status).toBe("draft");
  });
});
