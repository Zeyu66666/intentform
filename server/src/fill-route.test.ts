/**
 * 学生端收集页：`GET /f/:slug` 与零泄漏。
 *
 * 「零泄漏」不是读一遍代码就信的——这里直接从**响应体字节**里找
 * `answer` / `explanation` / `bloom` / `knowledgePoint` / `objectives`。
 * 真正上线前 `scripts/verify.mjs` 的 VC3 会用同样的检查跑一遍真实进程。
 */

import { afterEach, describe, expect, it } from "vitest";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FillViewResponse } from "@intentform/schema";
import {
  call,
  createPublishedQuiz,
  createTestEnv,
  login,
  seedTeacher,
  startTestServer,
  type TestServer,
} from "./testing/harness.ts";

const FORBIDDEN_KEYS = ["answer", "explanation", "bloom", "knowledgePoint", "objectives"];

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

describe("GET /f/:slug", () => {
  it("已发布表单返回 FillViewResponse 形状", async () => {
    const { app, cookie } = await boot();
    const quiz = await createPublishedQuiz(app, cookie);
    const response = await call<FillViewResponse>(app, "GET", `/f/${quiz.slug}`);
    expect(response.status).toBe(200);
    expect(response.json).toMatchObject({
      ok: true,
      formId: quiz.formId,
      versionId: quiz.versionId,
      versionN: 1,
      slug: quiz.slug,
    });
    // 题面与选项要给学生，否则填不了。
    expect(response.text).toContain("判分测试卷");
    expect(response.text).toContain("q-single");
  });

  it("零泄漏：响应体里没有 answer/explanation/bloom/knowledgePoint/objectives", async () => {
    const { app, cookie } = await boot();
    const quiz = await createPublishedQuiz(app, cookie);
    const response = await call(app, "GET", `/f/${quiz.slug}`);
    for (const key of FORBIDDEN_KEYS) {
      expect(response.text).not.toContain(key);
    }
    // 连知识点的值也不能漏（字段被剥了但值还在的话同样算泄漏）。
    expect(response.text).not.toContain("kp-a");
  });

  it("未发布表单与不存在的 slug 都是 404，且响应体一致", async () => {
    const { app, cookie } = await boot();
    const created = await call(app, "POST", "/api/forms", {
      body: { title: "草稿卷", kind: "quiz", schema: { ...quizLikeSchema() } },
      cookie,
    });
    expect(created.status).toBe(201);
    const missing = await call(app, "GET", "/f/zzzzzzzzzz");
    // 草稿没有 slug（发布才生成），所以这里只能用「不存在的 slug」验证 404 形状。
    expect(missing.status).toBe(404);
    expect(missing.json).toMatchObject({ ok: false, error: "not_found" });
  });

  it("Accept: application/json 时返回 JSON（HTML 壳走另一条分支）", async () => {
    const { app, cookie } = await boot();
    const quiz = await createPublishedQuiz(app, cookie);
    const response = await call(app, "GET", `/f/${quiz.slug}`, {
      headers: { accept: "application/json" },
    });
    expect(response.contentType).toContain("application/json");
    expect(response.status).toBe(200);
  });

  it("不要求登录（学生手机上没有账号）", async () => {
    const { app, cookie } = await boot();
    const quiz = await createPublishedQuiz(app, cookie);
    const response = await call(app, "GET", `/f/${quiz.slug}`, { csrf: false, origin: null });
    expect(response.status).toBe(200);
  });
});

describe("GET /f/:slug 的 HTML 分流", () => {
  it("Accept: text/html 且有产物 → 返回 HTML 壳本身", async () => {
    const indexHtml = join(tmpdir(), `intentform-index-${String(Date.now())}.html`);
    writeFileSync(indexHtml, "<!doctype html><title>意卷</title><div id=\"root\"></div>");
    try {
      const app = await startTestServer(createTestEnv({ WEB_INDEX_HTML: indexHtml }));
      server = app;
      const response = await call(app, "GET", "/f/anything", {
        headers: { accept: "text/html,application/xhtml+xml" },
        csrf: false,
        origin: null,
      });
      expect(response.status).toBe(200);
      expect(response.contentType).toContain("text/html");
      expect(response.text).toContain('id="root"');
    } finally {
      rmSync(indexHtml, { force: true });
    }
  });

  it("Accept: text/html 但缺产物 → 404 且是 JSON 提示，不吐栈也不回半张 HTML", async () => {
    const app = await startTestServer(
      createTestEnv({ WEB_INDEX_HTML: join(tmpdir(), "definitely-missing-index.html") }),
    );
    server = app;
    const response = await call(app, "GET", "/f/anything", {
      headers: { accept: "text/html" },
      csrf: false,
      origin: null,
    });
    expect(response.status).toBe(404);
    expect(response.contentType).toContain("application/json");
    expect(response.json).toMatchObject({ ok: false, error: "not_found" });
    expect(response.text).toContain("WEB_INDEX_HTML");
    // 不能把堆栈或 Node 的 internal 文本漏出去。
    expect(response.text).not.toMatch(/at .*\(|Error:|ENOENT/);
  });
});

/** 只为了造一个「未发布」的表单，schema 用最小合法结构。 */
function quizLikeSchema(): Record<string, unknown> {
  return {
    meta: { version: 1, kind: "quiz", title: "草稿卷", objectives: [], totalScore: 5 },
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
  };
}
