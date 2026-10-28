/**
 * `POST /api/forms/:id/suggest` —— 建议不写库。
 *
 * 这一组用例守的都是"模型说错了不该留下痕迹"这一类边界：
 * - 建议成功但**版本数不变、草稿指针不动**（写库只经 PATCH）；
 * - 基准版本过期回 409，而不是"按最新版猜"；
 * - `replay` 模式没有 `patch.v1` 录像时明确报错，不静默回空改动。
 */

import { afterEach, describe, expect, it } from "vitest";
import type { CreateFormResponse, FormDetailResponse, SuggestPatchResponse } from "@intentform/schema";
import { createFormBody } from "./testing/fixtures.ts";
import { call, login, seedTeacher, startTestServer, createTestEnv, type TestServer } from "./testing/harness.ts";

let server: TestServer | undefined;

async function boot(mode: string): Promise<{ app: TestServer; cookie: string }> {
  server = await startTestServer(createTestEnv({ LLM_MODE: mode }));
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

function countVersions(app: TestServer, formId: string): number {
  const row = app.db.prepare("SELECT COUNT(*) AS n FROM form_versions WHERE form_id = ?").get(formId) as
    | { n: number }
    | undefined;
  return row?.n ?? -1;
}

describe("POST /api/forms/:id/suggest", () => {
  it("mock 模式给出一组能应用的 ops，且版本库一个字没动", async () => {
    const { app, cookie } = await boot("mock");
    const created = await createForm(app, cookie);
    const before = countVersions(app, created.form.id);

    const response = await call<SuggestPatchResponse>(app, "POST", `/api/forms/${created.form.id}/suggest`, {
      body: { baseVersionId: created.version.id, instruction: "把第一题说得更口语一点" },
      cookie,
    });
    expect(response.status).toBe(200);
    expect(response.json.source).toBe("mock");
    expect(response.json.ops.length).toBeGreaterThan(0);
    // 改动条数 ≥ op 条数：改分值会连带改总分，`applyPatch` 会多报一条 meta 差异。
    expect(response.json.changes.length).toBeGreaterThanOrEqual(response.json.ops.length);
    expect(countVersions(app, created.form.id)).toBe(before);

    const detail = await call<FormDetailResponse>(app, "GET", `/api/forms/${created.form.id}`, { cookie });
    expect(detail.json.form.draftVersionId).toBe(created.version.id);
  });

  it("基准版本过期 → 409（建议必须基于界面上看到的那一版）", async () => {
    const { app, cookie } = await boot("mock");
    const created = await createForm(app, cookie);
    const response = await call(app, "POST", `/api/forms/${created.form.id}/suggest`, {
      body: { baseVersionId: "v_not_mine", instruction: "改题干" },
      cookie,
    });
    expect(response.status).toBe(409);
    expect(response.json).toMatchObject({ ok: false, error: "version_conflict" });
  });

  it("指令为空 → 400", async () => {
    const { app, cookie } = await boot("mock");
    const created = await createForm(app, cookie);
    const response = await call(app, "POST", `/api/forms/${created.form.id}/suggest`, {
      body: { baseVersionId: created.version.id, instruction: "   " },
      cookie,
    });
    expect(response.status).toBe(400);
  });

  it("replay 模式没有录像 → 明确报错，不静默回空改动", async () => {
    const { app, cookie } = await boot("replay");
    const created = await createForm(app, cookie);
    const response = await call(app, "POST", `/api/forms/${created.form.id}/suggest`, {
      body: { baseVersionId: created.version.id, instruction: "把第二题改成分值 8" },
      cookie,
    });
    expect(response.status).toBe(400);
    expect(String((response.json as { message?: string }).message)).toContain("回放");
  });

  it("未登录 401", async () => {
    const { app, cookie } = await boot("mock");
    const created = await createForm(app, cookie);
    const response = await call(app, "POST", `/api/forms/${created.form.id}/suggest`, {
      body: { baseVersionId: created.version.id, instruction: "改题干" },
    });
    expect(response.status).toBe(401);
  });
});
