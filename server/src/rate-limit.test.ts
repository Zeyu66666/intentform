/**
 * 限流：《计划 v3.0》§5「限流、调用边界」是必须保留项，这里是它的证据。
 *
 * 两层都测：
 * 1. `createRateLimiter` 的窗口语义（注入 `nowMs`，不睡真实时间）；
 * 2. 挂到路由上之后真的回 429 + `retry-after`，且**第 N+1 次才拒**——
 *    「第一次就拒」和「从不拒」都能让一个错的实现看起来是对的。
 */

import { afterEach, describe, expect, it } from "vitest";
import type { SubmitResponse } from "@intentform/schema";
import { createRateLimiter, rateLimitKey } from "./rate-limit.ts";
import {
  call,
  createPublishedQuiz,
  createTestEnv,
  login,
  seedTeacher,
  startTestServer,
  type TestServer,
} from "./testing/harness.ts";

const WINDOW_MS = 60_000;

describe("createRateLimiter", () => {
  it("配额内放行，第 N+1 次拒绝并给出 retryAfterSeconds", () => {
    const limiter = createRateLimiter(WINDOW_MS);
    const start = 1_000_000;
    expect(limiter.hit("k", 2, start)).toEqual({ ok: true });
    expect(limiter.hit("k", 2, start + 1_000)).toEqual({ ok: true });
    const rejected = limiter.hit("k", 2, start + 30_000);
    expect(rejected).toEqual({ ok: false, retryAfterSeconds: 30 });
  });

  it("跨窗口后重新计数（固定窗口，不是永久封禁）", () => {
    const limiter = createRateLimiter(WINDOW_MS);
    expect(limiter.hit("k", 1, 0)).toEqual({ ok: true });
    expect(limiter.hit("k", 1, 59_999).ok).toBe(false);
    expect(limiter.hit("k", 1, 60_000)).toEqual({ ok: true });
  });

  it("不同 key 互不影响", () => {
    const limiter = createRateLimiter(WINDOW_MS);
    expect(limiter.hit("a", 1, 0)).toEqual({ ok: true });
    expect(limiter.hit("b", 1, 0)).toEqual({ ok: true });
    expect(limiter.hit("a", 1, 0).ok).toBe(false);
  });

  it("配额 <= 0 表示不限（压测/内网演示不必再包一层 if）", () => {
    const limiter = createRateLimiter(WINDOW_MS);
    for (let index = 0; index < 100; index += 1) {
      expect(limiter.hit("k", 0, 0)).toEqual({ ok: true });
    }
    expect(limiter.size()).toBe(0);
  });

  it("key 里只有 IP 的哈希，没有明文 IP", () => {
    const key = rateLimitKey("submissions", "secret", "127.0.0.1");
    expect(key.startsWith("submissions:")).toBe(true);
    expect(key).not.toContain("127.0.0.1");
    expect(key.split(":")[1]).toMatch(/^[a-f0-9]{64}$/);
    // 同一个 IP + 同一个 secret 稳定，换 secret 就变（不同部署之间不可关联）。
    expect(key).toBe(rateLimitKey("submissions", "secret", "127.0.0.1"));
    expect(key).not.toBe(rateLimitKey("submissions", "other-secret", "127.0.0.1"));
  });
});

describe("POST /api/submissions 的限流", () => {
  let server: TestServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("配额用尽后回 429 rate_limited，并带 retry-after", async () => {
    server = await startTestServer(createTestEnv({ RATE_SUBMIT_PER_MIN: "2" }));
    seedTeacher(server.db);
    const cookie = await login(server);
    const quiz = await createPublishedQuiz(server, cookie);
    const body = {
      slug: quiz.slug,
      formVersionId: quiz.versionId,
      answers: { "q-single": "op1" },
    };

    const first = await call<SubmitResponse>(server, "POST", "/api/submissions", { body });
    const second = await call<SubmitResponse>(server, "POST", "/api/submissions", { body });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);

    const third = await call(server, "POST", "/api/submissions", { body });
    expect(third.status).toBe(429);
    expect(third.json).toMatchObject({ ok: false, error: "rate_limited" });
    expect(third.text).toContain("秒后再试");
  });

  it("限流不看登录态：匿名提交同样计数（学生手机上没有账号）", async () => {
    server = await startTestServer(createTestEnv({ RATE_SUBMIT_PER_MIN: "1" }));
    seedTeacher(server.db);
    const cookie = await login(server);
    const quiz = await createPublishedQuiz(server, cookie);
    const body = { slug: quiz.slug, formVersionId: quiz.versionId, answers: {} };
    expect((await call(server, "POST", "/api/submissions", { body })).status).toBe(201);
    expect((await call(server, "POST", "/api/submissions", { body })).status).toBe(429);
  });
});
