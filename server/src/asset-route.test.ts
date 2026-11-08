/**
 * 配图上传/读取：文件头嗅探、公开范围、非 owner 的 404 与 CSRF。
 *
 * 这里不验证像素尺寸或渲染——那条由浏览器闭环负责；本文件只锁 HTTP 语义。
 */

import { afterEach, describe, expect, it } from "vitest";

import type { AssetUploadResponse, CreateFormResponse } from "@intentform/schema";

import { call, createPublishedQuiz, login, seedTeacher, startTestServer, type TestServer } from "./testing/harness.ts";
import { createFormBody } from "./testing/fixtures.ts";

let server: TestServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

/** 1×1 透明 PNG。 */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

async function boot(): Promise<{ app: TestServer; cookie: string }> {
  const app = await startTestServer();
  seedTeacher(app.db);
  const cookie = await login(app);
  server = app;
  return { app, cookie };
}

async function upload(
  app: TestServer,
  cookie: string,
  formId: string,
  data = PNG_BASE64,
  csrf = true,
): Promise<Awaited<ReturnType<typeof call<AssetUploadResponse>>>> {
  return call<AssetUploadResponse>(app, "POST", `/api/forms/${formId}/assets`, {
    body: { filename: "diagram.png", data },
    cookie,
    csrf,
  });
}

describe("POST /api/forms/:id/assets", () => {
  it("上传 PNG 后返回 assetId；已发布表单的图匿名可读", async () => {
    const { app, cookie } = await boot();
    const quiz = await createPublishedQuiz(app, cookie);
    const uploaded = await upload(app, cookie, quiz.formId);
    expect(uploaded.status).toBe(201);
    expect(uploaded.json.mime).toBe("image/png");
    expect(uploaded.json.byteLength).toBeGreaterThan(0);

    const image = await call(app, "GET", `/api/assets/${uploaded.json.assetId}`);
    expect(image.status).toBe(200);
    expect(image.contentType).toBe("image/png");
    expect(image.text.length).toBeGreaterThan(0);
    expect(image.headers.get("cache-control")).toContain("public");
  });

  it("草稿表单的图只给 owner；匿名与非 owner 都是 404", async () => {
    const { app, cookie } = await boot();
    const created = await call<CreateFormResponse>(app, "POST", "/api/forms", {
      body: createFormBody("quiz"),
      cookie,
    });
    expect(created.status).toBe(201);
    const uploaded = await upload(app, cookie, created.json.form.id);
    expect(uploaded.status).toBe(201);

    const anonymous = await call(app, "GET", `/api/assets/${uploaded.json.assetId}`);
    expect(anonymous.status).toBe(404);
    const owner = await call(app, "GET", `/api/assets/${uploaded.json.assetId}`, { cookie });
    expect(owner.status).toBe(200);
  });

  it("非图片、非法 base64、缺 CSRF 分别拒绝", async () => {
    const { app, cookie } = await boot();
    const quiz = await createPublishedQuiz(app, cookie);

    const notImage = await upload(app, cookie, quiz.formId, Buffer.from("hello").toString("base64"));
    expect(notImage.status).toBe(422);

    const badBase64 = await upload(app, cookie, quiz.formId, "***not-base64***");
    expect(badBase64.status).toBe(400);

    const noCsrf = await upload(app, cookie, quiz.formId, PNG_BASE64, false);
    expect(noCsrf.status).toBe(403);
  });

  it("删掉表单后图也 404（逻辑删除同步下线）", async () => {
    const { app, cookie } = await boot();
    const quiz = await createPublishedQuiz(app, cookie);
    const uploaded = await upload(app, cookie, quiz.formId);

    const removed = await call(app, "DELETE", `/api/forms/${quiz.formId}`, { cookie });
    expect(removed.status).toBe(200);
    const image = await call(app, "GET", `/api/assets/${uploaded.json.assetId}`);
    expect(image.status).toBe(404);
  });
});
