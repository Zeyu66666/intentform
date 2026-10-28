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
  PatchFormResponse,
  PublishResponse,
  UndoDraftResponse,
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

/* ---------------------- 受限修改与撤销（省赛 R-03） ---------------------- */

describe("PATCH /api/forms/:id", () => {
  it("追加一个新草稿版本，草稿指针前进，已发布指针不动", async () => {
    const { app, cookie } = await boot();
    const created = await createForm(app, cookie);
    const formId = created.form.id;
    // 先发布一版：之后的改动不许影响学生手上的收集页（这条是 R-03 与 §3.5 的交界）。
    const published = await call<PublishResponse>(app, "POST", `/api/forms/${formId}/publish`, {
      body: { versionId: created.version.id },
      cookie,
    });
    expect(published.status).toBe(200);

    const patched = await call<PatchFormResponse>(app, "PATCH", `/api/forms/${formId}`, {
      body: {
        baseVersionId: created.version.id,
        ops: [{ op: "setScore", itemId: "q-single", score: 8 }],
        title: "判分测试卷（改）",
      },
      cookie,
    });
    expect(patched.status).toBe(200);
    expect(patched.json.version.n).toBe(2);
    expect(patched.json.version.source).toBe("patch");
    expect(patched.json.version.parentId).toBe(created.version.id);
    // 总分从 20 变 23（5→8），服务端算的，不是前端传的。
    expect(patched.json.schema.meta.totalScore).toBe(23);
    expect(patched.json.changes.map((change) => change.where)).toEqual(["第 2 题", "总分"]);
    expect(patched.json.form.title).toBe("判分测试卷（改）");
    expect(patched.json.form.draftVersionId).toBe(patched.json.version.id);
    // 发布指针没动，slug 也没变。
    expect(patched.json.form.publishedVersionId).toBe(created.version.id);
    expect(patched.json.form.slug).toBe(published.json.slug);
  });

  it("baseVersionId 过期 → 409（乐观锁，不静默覆盖别人的改动）", async () => {
    const { app, cookie } = await boot();
    const created = await createForm(app, cookie);
    const formId = created.form.id;
    const first = await call<PatchFormResponse>(app, "PATCH", `/api/forms/${formId}`, {
      body: { baseVersionId: created.version.id, ops: [{ op: "setStem", itemId: "q-single", title: "第一次改" }] },
      cookie,
    });
    expect(first.status).toBe(200);
    // 拿着旧版本 id 再改一次：界面上"看到的草稿"已经不是当前草稿了。
    const stale = await call(app, "PATCH", `/api/forms/${formId}`, {
      body: { baseVersionId: created.version.id, ops: [{ op: "setStem", itemId: "q-single", title: "第二次改" }] },
      cookie,
    });
    expect(stale.status).toBe(409);
    expect(stale.text).toContain("刷新");
  });

  it("非法 op 明细进 400 的 message（可诊断，不是一句「未通过校验」）", async () => {
    const { app, cookie } = await boot();
    const created = await createForm(app, cookie);
    const response = await call(app, "PATCH", `/api/forms/${created.form.id}`, {
      body: { baseVersionId: created.version.id, ops: [{ op: "setStem", itemId: "q-nope", title: "x" }] },
      cookie,
    });
    expect(response.status).toBe(400);
    expect(response.text).toContain("找不到题目 q-nope");
  });

  it("空改动不产生新版本（点一次保存不该多一版）", async () => {
    const { app, cookie } = await boot();
    const created = await createForm(app, cookie);
    const formId = created.form.id;
    const response = await call<PatchFormResponse>(app, "PATCH", `/api/forms/${formId}`, {
      body: { baseVersionId: created.version.id, ops: [{ op: "setScore", itemId: "q-single", score: 5 }] },
      cookie,
    });
    expect(response.status).toBe(200);
    expect(response.json.changes).toEqual([]);
    expect(response.json.version.id).toBe(created.version.id);
    const detail = await call<FormDetailResponse>(app, "GET", `/api/forms/${formId}`, { cookie });
    expect(detail.json.form.draftVersionId).toBe(created.version.id);
  });

  it("别人的表单 403，未登录 401", async () => {
    const { app, cookie } = await boot();
    const created = await createForm(app, cookie);
    const anonymous = await call(app, "PATCH", `/api/forms/${created.form.id}`, {
      body: { baseVersionId: created.version.id, ops: [{ op: "setStem", itemId: "q-single", title: "x" }] },
    });
    expect(anonymous.status).toBe(401);

    seedTeacher(app.db, "other@example.com");
    const other = await login(app, "other@example.com");
    const forbidden = await call(app, "PATCH", `/api/forms/${created.form.id}`, {
      body: { baseVersionId: created.version.id, ops: [{ op: "setStem", itemId: "q-single", title: "x" }] },
      cookie: other,
    });
    expect(forbidden.status).toBe(403);
  });
});

describe("POST /api/forms/:id/undo", () => {
  it("退回父版本；再退一步到 v1 后 undone=false 且不多造版本", async () => {
    const { app, cookie } = await boot();
    const created = await createForm(app, cookie);
    const formId = created.form.id;
    const patched = await call<PatchFormResponse>(app, "PATCH", `/api/forms/${formId}`, {
      body: { baseVersionId: created.version.id, ops: [{ op: "removeItem", itemId: "q-short" }] },
      cookie,
    });
    expect(patched.status).toBe(200);

    const undo1 = await call<UndoDraftResponse>(app, "POST", `/api/forms/${formId}/undo`, {
      body: { fromVersionId: patched.json.version.id },
      cookie,
    });
    expect(undo1.status).toBe(200);
    expect(undo1.json.undone).toBe(true);
    expect(undo1.json.version.id).toBe(created.version.id);
    expect(undo1.json.schema.items.map((item) => item.id)).toContain("q-short");

    // v1 没有父版本：回到最初，不是错误。
    const undo2 = await call<UndoDraftResponse>(app, "POST", `/api/forms/${formId}/undo`, {
      body: { fromVersionId: created.version.id },
      cookie,
    });
    expect(undo2.status).toBe(200);
    expect(undo2.json.undone).toBe(false);
    expect(undo2.json.version.id).toBe(created.version.id);
  });

  it("撤销后仍能继续改（指针退回去就是新的基准）", async () => {
    const { app, cookie } = await boot();
    const created = await createForm(app, cookie);
    const formId = created.form.id;
    const patched = await call<PatchFormResponse>(app, "PATCH", `/api/forms/${formId}`, {
      body: { baseVersionId: created.version.id, ops: [{ op: "setStem", itemId: "q-single", title: "改过" }] },
      cookie,
    });
    await call(app, "POST", `/api/forms/${formId}/undo`, {
      body: { fromVersionId: patched.json.version.id },
      cookie,
    });
    const again = await call<PatchFormResponse>(app, "PATCH", `/api/forms/${formId}`, {
      body: { baseVersionId: created.version.id, ops: [{ op: "setStem", itemId: "q-single", title: "换个说法" }] },
      cookie,
    });
    expect(again.status).toBe(200);
    // v1 → v2 → 撤销 → v3：版本行只增不改，n 不复用。
    expect(again.json.version.n).toBe(3);
    expect(again.json.version.parentId).toBe(created.version.id);
  });
});
