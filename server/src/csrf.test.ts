/**
 * 跨站写保护：缺 `x-intentform-csrf` 或 Origin 不对 → 403。
 *
 * 这两条是 §5「不能优先砍 CSRF」的落地证据。测试里故意用 `csrf: false`
 * 和 `origin: null` 去撞，因为它们正是浏览器跨站提交时的真实形态：
 * 跨站表单既发不出自定义头，其 Origin 也不会等于 APP_ORIGIN。
 */

import { afterEach, describe, expect, it } from "vitest";
import { TEST_APP_ORIGIN, call, login, seedTeacher, startTestServer, type TestServer } from "./testing/harness.ts";

let server: TestServer | undefined;

async function boot(): Promise<TestServer> {
  server = await startTestServer();
  seedTeacher(server.db);
  return server;
}

afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe("跨站写保护", () => {
  it("缺自定义头 → 403 forbidden", async () => {
    const app = await boot();
    const response = await call(app, "POST", "/api/auth/login", {
      body: { email: "teacher@example.com", password: "intentform-test-password" },
      csrf: false,
    });
    expect(response.status).toBe(403);
    expect(response.json).toMatchObject({ ok: false, error: "forbidden" });
  });

  it("Origin 与 APP_ORIGIN 不一致 → 403", async () => {
    const app = await boot();
    const response = await call(app, "POST", "/api/auth/login", {
      body: { email: "teacher@example.com", password: "intentform-test-password" },
      origin: "https://attacker.example",
    });
    expect(response.status).toBe(403);
    expect(response.json).toMatchObject({ ok: false, error: "forbidden" });
  });

  it("完全没有 Origin 的修改类请求 → 403（无法证明不是别站发起）", async () => {
    const app = await boot();
    const response = await call(app, "POST", "/api/auth/login", {
      body: { email: "teacher@example.com", password: "intentform-test-password" },
      origin: null,
    });
    expect(response.status).toBe(403);
  });

  it("两道闸都齐了才放行（登录成功）", async () => {
    const app = await boot();
    const cookie = await login(app);
    expect(cookie).toContain("intentform_session=");
  });

  it("GET 不受 CSRF 限制（只读无副作用）", async () => {
    const app = await boot();
    const response = await call(app, "GET", "/api/auth/me", { csrf: false, origin: null });
    expect(response.status).toBe(401);
    expect(response.json).toMatchObject({ ok: false, error: "unauthorized" });
  });

  it("预检 OPTIONS 回 204 且只对 APP_ORIGIN 回显 ACAO", async () => {
    const app = await boot();
    const allowed = await fetch(`${app.baseUrl}/api/forms`, {
      method: "OPTIONS",
      headers: { origin: TEST_APP_ORIGIN, "access-control-request-headers": "x-intentform-csrf" },
    });
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("access-control-allow-origin")).toBe(TEST_APP_ORIGIN);
    expect(allowed.headers.get("access-control-allow-headers")).toContain("x-intentform-csrf");

    const denied = await fetch(`${app.baseUrl}/api/forms`, {
      method: "OPTIONS",
      headers: { origin: "https://attacker.example" },
    });
    expect(denied.status).toBe(204);
    expect(denied.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("登出也要带自定义头（它同样是写操作）", async () => {
    const app = await boot();
    const cookie = await login(app);
    const withoutHeader = await call(app, "POST", "/api/auth/logout", { cookie, csrf: false });
    expect(withoutHeader.status).toBe(403);
    const ok = await call(app, "POST", "/api/auth/logout", { cookie });
    expect(ok.status).toBe(200);
  });
});
