/** 覆盖矩阵补题：只回候选、不写库；归属/乐观锁/知识点三处都挡住。 */

import { afterEach, describe, expect, it } from "vitest";
import type {
  CreateFormResponse,
  FormDetailResponse,
  SupplementItemResponse,
} from "@intentform/schema";

import { createFormBody } from "./testing/fixtures.ts";
import { call, login, seedTeacher, startTestServer, type TestServer } from "./testing/harness.ts";

let server: TestServer | undefined;

async function boot(): Promise<{ app: TestServer; cookie: string; created: CreateFormResponse }> {
  server = await startTestServer();
  seedTeacher(server.db);
  const cookie = await login(server);
  const created = await call<CreateFormResponse>(server, "POST", "/api/forms", {
    body: createFormBody("quiz"),
    cookie,
  });
  expect(created.status).toBe(201);
  return { app: server, cookie, created: created.json };
}

afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe("POST /api/forms/:id/supplement", () => {
  it("mock 模式回一道合法候选题，知识点/层级钉在请求上，且不写库", async () => {
    const { app, cookie, created } = await boot();
    const response = await call<SupplementItemResponse>(
      app,
      "POST",
      `/api/forms/${created.form.id}/supplement`,
      {
        body: { baseVersionId: created.version.id, knowledgePoint: "kp-a", bloom: "apply" },
        cookie,
      },
    );
    expect(response.status).toBe(200);
    expect(response.json.ok).toBe(true);
    expect(response.json.item.type).toBe("single");
    if (response.json.item.type !== "single") return;
    expect(response.json.item.knowledgePoint).toBe("kp-a");
    expect(response.json.item.bloom).toBe("apply");
    expect(response.json.item.id).toMatch(/^q_/u);
    expect(response.json.source).toBe("mock");
    expect(response.json.promptVersion).toBe("supplement.v1");

    const detail = await call<FormDetailResponse>(app, "GET", `/api/forms/${created.form.id}`, {
      cookie,
    });
    expect(detail.json.version.n).toBe(1);
    expect(detail.json.schema.items.some((item) => item.id === response.json.item.id)).toBe(false);
  });

  it("知识点不在本版大纲里 → 422", async () => {
    const { app, cookie, created } = await boot();
    const response = await call(app, "POST", `/api/forms/${created.form.id}/supplement`, {
      body: { baseVersionId: created.version.id, knowledgePoint: "kp_missing", bloom: "apply" },
      cookie,
    });
    expect(response.status).toBe(422);
    expect(response.json).toMatchObject({ error: "unprocessable" });
  });

  it("旧 baseVersionId → 409，不按最新版猜", async () => {
    const { app, cookie, created } = await boot();
    const response = await call(app, "POST", `/api/forms/${created.form.id}/supplement`, {
      body: { baseVersionId: "v_stale", knowledgePoint: "kp-a", bloom: "apply" },
      cookie,
    });
    expect(response.status).toBe(409);
    expect(response.json).toMatchObject({ error: "version_conflict" });
  });

  it("未登录 401，别人的表单 403", async () => {
    const { app, created } = await boot();
    const anonymous = await call(app, "POST", `/api/forms/${created.form.id}/supplement`, {
      body: { baseVersionId: created.version.id, knowledgePoint: "kp-a", bloom: "apply" },
    });
    expect(anonymous.status).toBe(401);

    seedTeacher(app.db, "other@example.com");
    const other = await login(app, "other@example.com");
    const forbidden = await call(app, "POST", `/api/forms/${created.form.id}/supplement`, {
      body: { baseVersionId: created.version.id, knowledgePoint: "kp-a", bloom: "apply" },
      cookie: other,
    });
    expect(forbidden.status).toBe(403);
  });
});
