/**
 * 鉴权测试：会话 cookie 的签名、过期、篡改，以及失败锁定。
 *
 * 这里刻意不 mock argon2——真的跑一次 verify，才能证明「密码对不上就 401」
 * 不是靠类型推断出来的。
 */

import { afterEach, describe, expect, it } from "vitest";
import type { LoginResponse, MeResponse } from "@intentform/schema";
import { signSession } from "./auth.ts";
import {
  TEST_PASSWORD,
  TEST_SESSION_SECRET,
  call,
  cookieFrom,
  login,
  seedTeacher,
  startTestServer,
  type TestServer,
} from "./testing/harness.ts";

let server: TestServer | undefined;

async function boot(): Promise<{ app: TestServer; email: string }> {
  server = await startTestServer();
  const teacher = seedTeacher(server.db);
  return { app: server, email: teacher.email };
}

afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe("登录", () => {
  it("密码正确返回教师身份并种 cookie", async () => {
    const { app, email } = await boot();
    const response = await call<LoginResponse>(app, "POST", "/api/auth/login", {
      body: { email, password: TEST_PASSWORD },
    });
    expect(response.status).toBe(200);
    expect(response.json).toMatchObject({ ok: true, teacher: { email } });
    const cookie = response.setCookies.join("; ");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    // COOKIE_SECURE=false 时不能加 Secure，否则本地 http 下登录立刻失效。
    expect(cookie).not.toContain("Secure");
  });

  it("邮箱大小写与首尾空白不敏感", async () => {
    const { app, email } = await boot();
    const response = await call<LoginResponse>(app, "POST", "/api/auth/login", {
      body: { email: `  ${email.toUpperCase()}  `, password: TEST_PASSWORD },
    });
    expect(response.status).toBe(200);
  });

  it("密码错误返回 401，且不区分「邮箱不存在」", async () => {
    const { app } = await boot();
    const wrongPassword = await call(app, "POST", "/api/auth/login", {
      body: { email: "teacher@example.com", password: "wrong-password" },
    });
    const unknownEmail = await call(app, "POST", "/api/auth/login", {
      body: { email: "nobody@example.com", password: "wrong-password" },
    });
    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    expect(wrongPassword.json).toMatchObject({ error: "unauthorized" });
    expect(unknownEmail.json).toMatchObject({ error: "unauthorized" });
  });

  it("形状校验失败回中文 400，不透出 zod 的英文原文", async () => {
    const { app } = await boot();
    const shortPassword = await call(app, "POST", "/api/auth/login", {
      body: { email: "teacher@example.com", password: "short" },
    });
    expect(shortPassword.status).toBe(400);
    expect(shortPassword.json).toMatchObject({ ok: false, error: "bad_request" });
    expect(shortPassword.json).toMatchObject({ message: "密码至少 8 位" });

    // 契约里 email 只约束长度与大小写（不做 RFC 校验），所以用「缺字段」触发形状错。
    const badEmail = await call(app, "POST", "/api/auth/login", {
      body: { password: TEST_PASSWORD },
    });
    expect(badEmail.status).toBe(400);
    expect(badEmail.json).toMatchObject({ message: "邮箱格式不正确" });
    expect(badEmail.text).not.toMatch(/String must|Invalid|Required/);
  });

  it("连续 5 次失败后锁定，正确密码也进不去", async () => {
    const { app, email } = await boot();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const failed = await call(app, "POST", "/api/auth/login", {
        body: { email, password: `wrong-password-${String(attempt)}` },
      });
      expect(failed.status).toBe(401);
    }
    const locked = await call(app, "POST", "/api/auth/login", {
      body: { email, password: TEST_PASSWORD },
    });
    expect(locked.status).toBe(429);
    expect(locked.json).toMatchObject({ error: "rate_limited" });
  });
});

describe("会话 cookie", () => {
  it("/api/auth/me 未登录 401，登录后 200", async () => {
    const { app, email } = await boot();
    const anonymous = await call(app, "GET", "/api/auth/me");
    expect(anonymous.status).toBe(401);
    const cookie = await login(app);
    const me = await call<MeResponse>(app, "GET", "/api/auth/me", { cookie });
    expect(me.status).toBe(200);
    expect(me.json).toMatchObject({ ok: true, teacher: { email } });
  });

  it("签名被篡改 → 401", async () => {
    const { app } = await boot();
    const cookie = await login(app);
    const value = cookie.split("=")[1] ?? "";
    const parts = value.split(".");
    const tampered = `${parts[0]}.${parts[1]}.${"A".repeat(43)}`;
    const response = await call(app, "GET", "/api/auth/me", {
      cookie: `intentform_session=${tampered}`,
    });
    expect(response.status).toBe(401);
  });

  it("过期时间已过 → 401（不需要查库）", async () => {
    const { app, email } = await boot();
    const teacher = seedTeacher(app.db, "second@example.com");
    void email;
    const expired = signSession(teacher.id, Math.floor(Date.now() / 1000) - 10, TEST_SESSION_SECRET);
    const response = await call(app, "GET", "/api/auth/me", {
      cookie: `intentform_session=${expired}`,
    });
    expect(response.status).toBe(401);
  });

  it("登出清 cookie（Max-Age=0）", async () => {
    const { app } = await boot();
    const cookie = await login(app);
    const response = await call(app, "POST", "/api/auth/logout", { cookie });
    expect(response.status).toBe(200);
    const cleared = cookieFrom(response.setCookies);
    expect(response.setCookies.join("; ")).toContain("Max-Age=0");
    expect(cleared).toBe("intentform_session=");
  });
});

describe("账号枚举", () => {
  it("邮箱不存在与密码错：同状态码、同文案", async () => {
    const { app } = await boot();
    const unknown = await call(app, "POST", "/api/auth/login", {
      body: { email: "nobody@example.com", password: "wrong-password-1" },
    });
    const wrongPassword = await call(app, "POST", "/api/auth/login", {
      body: { email: "teacher@example.com", password: "wrong-password-2" },
    });
    expect(unknown.status).toBe(401);
    expect(wrongPassword.status).toBe(401);
    expect(unknown.json).toEqual(wrongPassword.json);
    expect(unknown.text).toBe(wrongPassword.text);
  });

  it("邮箱不存在时也真的跑了一次 argon2（耗时同量级，不是微秒级秒回）", async () => {
    const { app } = await boot();
    const started = performance.now();
    await call(app, "POST", "/api/auth/login", {
      body: { email: "nobody@example.com", password: "wrong-password-1" },
    });
    const elapsedMs = performance.now() - started;
    // 陪跑的 KDF 在测试参数（8 MiB）下也有毫秒量级；不陪跑时这条路径只是一次
    // 主键查询 + 一次哈希，通常 < 1 ms。阈值取 1 ms 是为了别在慢 CI 上抖。
    expect(elapsedMs).toBeGreaterThan(1);
  });
});
