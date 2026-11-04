/**
 * `GET/POST /api/settings/llm` 的边界（2026-11-03）。
 *
 * 这条路由是唯一允许「网页填 Key」的入口，所以测试盯三件事：
 * 1. 必须登录；`ADMIN_EMAIL` 非空时只有该邮箱能写；
 * 2. Key 只进不出：响应体里连 `"apiKey"` 这个键名都不出现；
 * 3. 更新失败不改变正在运行的配置。
 */

import { afterEach, describe, expect, it } from "vitest";

import type { LlmSettingsResponse } from "@intentform/schema";

import {
  call,
  createTestEnv,
  login,
  seedTeacher,
  startTestServer,
  type TestServer,
} from "./testing/harness.ts";

const TEST_KEY = "route-test-key-not-real";

let server: TestServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe("GET /api/settings/llm", () => {
  it("未登录 401，登录后只回运行值与 hasApiKey", async () => {
    server = await startTestServer();
    const anonymous = await call(server, "GET", "/api/settings/llm");
    expect(anonymous.status).toBe(401);

    seedTeacher(server.db);
    const cookie = await login(server);
    const read = await call<LlmSettingsResponse>(server, "GET", "/api/settings/llm", { cookie });
    expect(read.status).toBe(200);
    expect(read.json).toMatchObject({
      ok: true,
      mode: "mock",
      hasApiKey: false,
      canEdit: true,
    });
    expect(read.text).not.toContain('"apiKey"');
  });
});

describe("POST /api/settings/llm", () => {
  it("切换模式与端点后立即生效，GET 能读到同一份运行值", async () => {
    server = await startTestServer();
    seedTeacher(server.db);
    const cookie = await login(server);

    const updated = await call<LlmSettingsResponse>(server, "POST", "/api/settings/llm", {
      cookie,
      body: { mode: "replay", baseUrl: "https://api.example.com/v1", model: "model-x" },
    });
    expect(updated.status).toBe(200);
    expect(updated.json).toMatchObject({ mode: "replay", model: "model-x", hasApiKey: false });

    const read = await call<LlmSettingsResponse>(server, "GET", "/api/settings/llm", { cookie });
    expect(read.json).toMatchObject({
      mode: "replay",
      baseUrl: "https://api.example.com/v1",
      model: "model-x",
    });
  });

  it("非法输入 400，运行配置保持不变", async () => {
    server = await startTestServer();
    seedTeacher(server.db);
    const cookie = await login(server);

    const badUrl = await call(server, "POST", "/api/settings/llm", {
      cookie,
      body: { mode: "mock", baseUrl: "not-a-url", model: "m" },
    });
    expect(badUrl.status).toBe(400);

    // live 缺 Key：运行时解析失败，不得把服务切到半坏状态。
    const missingKey = await call(server, "POST", "/api/settings/llm", {
      cookie,
      body: { mode: "live", baseUrl: "https://api.example.com/v1", model: "m" },
    });
    expect(missingKey.status).toBe(400);

    const read = await call<LlmSettingsResponse>(server, "GET", "/api/settings/llm", { cookie });
    expect(read.json.mode).toBe("mock");
    expect(read.json.baseUrl).toBe("https://api.deepseek.com/v1");
  });

  it("Key 只进不出：提交后响应与后续读取都不含 Key", async () => {
    server = await startTestServer();
    seedTeacher(server.db);
    const cookie = await login(server);

    const live = await call<LlmSettingsResponse>(server, "POST", "/api/settings/llm", {
      cookie,
      body: {
        mode: "live",
        baseUrl: "https://api.example.com/v1",
        model: "model-x",
        apiKey: TEST_KEY,
      },
    });
    expect(live.status).toBe(200);
    expect(live.json.hasApiKey).toBe(true);
    expect(live.text).not.toContain(TEST_KEY);
    expect(live.text).not.toContain('"apiKey"');

    const read = await call<LlmSettingsResponse>(server, "GET", "/api/settings/llm", { cookie });
    expect(read.text).not.toContain(TEST_KEY);
    expect(read.json.hasApiKey).toBe(true);

    // 留空 = 保持原 Key：切回 mock 再切回 live，不需要重输。
    const mock = await call<LlmSettingsResponse>(server, "POST", "/api/settings/llm", {
      cookie,
      body: { mode: "mock", baseUrl: "https://api.example.com/v1", model: "model-x" },
    });
    expect(mock.json.hasApiKey).toBe(true);
  });

  it("搜索端点与搜索 Key：只回 hasSearchKey，Key 不出现在响应里", async () => {
    server = await startTestServer();
    seedTeacher(server.db);
    const cookie = await login(server);

    const searchKey = "search-route-key-not-real";
    const saved = await call<LlmSettingsResponse>(server, "POST", "/api/settings/llm", {
      cookie,
      body: {
        mode: "mock",
        baseUrl: "https://api.example.com/v1",
        model: "model-x",
        searchBaseUrl: "https://search.example.test/api",
        searchApiKey: searchKey,
      },
    });
    expect(saved.status).toBe(200);
    expect(saved.json).toMatchObject({
      searchBaseUrl: "https://search.example.test/api",
      hasSearchKey: true,
    });
    expect(saved.text).not.toContain(searchKey);
    expect(saved.text).not.toContain('"searchApiKey"');

    const read = await call<LlmSettingsResponse>(server, "GET", "/api/settings/llm", { cookie });
    expect(read.json.searchBaseUrl).toBe("https://search.example.test/api");
    expect(read.json.hasSearchKey).toBe(true);
    expect(read.text).not.toContain(searchKey);

    // 非法搜索端点：400，且旧值不变。
    const bad = await call(server, "POST", "/api/settings/llm", {
      cookie,
      body: {
        mode: "mock",
        baseUrl: "https://api.example.com/v1",
        model: "model-x",
        searchBaseUrl: "ftp://search.example.test",
      },
    });
    expect(bad.status).toBe(400);
    const after = await call<LlmSettingsResponse>(server, "GET", "/api/settings/llm", { cookie });
    expect(after.json.searchBaseUrl).toBe("https://search.example.test/api");
    expect(after.json.hasSearchKey).toBe(true);
  });

  it("ADMIN_EMAIL 非空时只有该邮箱能写，其他教师 403", async () => {
    server = await startTestServer(createTestEnv({ ADMIN_EMAIL: "admin@example.com" }));
    const admin = seedTeacher(server.db, "admin@example.com");
    const other = seedTeacher(server.db, "other@example.com");
    const adminCookie = await login(server, admin.email);
    const otherCookie = await login(server, other.email);

    const asOther = await call<LlmSettingsResponse>(server, "GET", "/api/settings/llm", {
      cookie: otherCookie,
    });
    expect(asOther.status).toBe(200);
    expect(asOther.json.canEdit).toBe(false);

    const denied = await call(server, "POST", "/api/settings/llm", {
      cookie: otherCookie,
      body: { mode: "mock", baseUrl: "https://api.example.com/v1", model: "m" },
    });
    expect(denied.status).toBe(403);

    const asAdmin = await call<LlmSettingsResponse>(server, "GET", "/api/settings/llm", {
      cookie: adminCookie,
    });
    expect(asAdmin.json.canEdit).toBe(true);

    const allowed = await call<LlmSettingsResponse>(server, "POST", "/api/settings/llm", {
      cookie: adminCookie,
      body: { mode: "replay", baseUrl: "https://api.example.com/v1", model: "m" },
    });
    expect(allowed.status).toBe(200);
    expect(allowed.json.mode).toBe("replay");
  });
});
